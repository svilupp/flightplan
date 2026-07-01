// Flightplan — the run orchestration engine (the Phase 2 capstone).
//
// `runFlow(opts)` integrates every module built so far:
//   flow/ (load + import-resolve + template) · config/ (resolved config + connect default) ·
//   driver/ (the Driver boundary; connect/teardown lifecycle) · ladder/ (resolveStep per
//   targeted step) · assert/ (deterministic assertion engine) · artifacts/ (run.jsonl /
//   trace.jsonl / summary.json writers).
//
// It NEVER imports browser-pilot — it talks to the `Driver` interface only (the driver factory
// supplies the real `BrowserPilotDriver` in production, a `MockDriver` in tests). The driver is
// torn down in a `finally` on EVERY path (success, failed step, thrown error) — no orphan Chrome.
//
// Step dispatch (one entry per `StepDo`):
//   goto   → driver.goto(templated url)
//   wait   → clock.sleep(ms)  (injectable clock → tests never really sleep)
//   click|fill|select|press|ai_pick → ladder.resolveStep(...) (resolution+action coupled at L1);
//     emit one browser_action + one resolution_attempt per ladder attempt. ai_pick has no AI hook
//     in P2 → fails with a clear Phase-4 message.
//   assert (a `do:'assert'` step) + per-step `assert[]` → runAssertions(..., 'after').
//   Plus `when:'before'`/`when:'after'` assertions around every step.
//
// Verdict: passed (all steps + assertions ok) · failed (a deterministic step/assertion failed) ·
// inconclusive (reserved for budget/AI-unavailable — Phase 4) · error (infra/connect/throw).
//
// Canonical references: PLAN.md §3 (driver lifecycle), §4 (RunSummary / verdict), §5 Phase 2.

import { loadFlowFile } from "../flow/load.ts";
import { resolveImports, type ImportGraph } from "../flow/imports.ts";
import { applyTemplatingDeep, resolveInputs, type TemplateContext } from "../flow/template.ts";
import type { Assertion, AiJudgeAssertion, FlowFile, Step } from "../flow/types.ts";
import type { ConnectConfig, ResolvedConfig } from "../config/types.ts";
import { BrowserPilotDriver } from "../driver/browser-pilot-driver.ts";
import type { Driver } from "../driver/index.ts";
import { selectorUsedToStrategy } from "../driver/index.ts";
import {
  createLadder,
  type LadderResult,
  type ResolveContext,
  type StepExecution,
} from "../ladder/index.ts";
import {
  type LockSession,
  type LockWriteMode,
  type SessionImport,
  openLockSession,
  resolveLockWriteMode,
} from "../lock/index.ts";
import {
  type AssertContext,
  type AssertionResult,
  type AssertClock,
  runAssertions,
} from "../assert/index.ts";
import {
  createAiRuntime,
  createOpenRouterGenerate,
  isBudgetExceeded,
  type AiRuntime,
  type BudgetLimitName,
} from "../ai/index.ts";
import {
  createRun,
  openArtifactWriters,
  writeSummary,
  type AiCallEvent,
  type ArtifactWriters,
  type Clock as ArtifactClock,
  type LadderTier,
  type RunSummary,
  type StepSummary,
} from "../artifacts/index.ts";
import { createRedactor, gatherSecretValues, type Redactor } from "../redaction/index.ts";
import {
  aiCallEventAttrs,
  artifactCreatedAttrs,
  assertionResultEventAttrs,
  browserActionEventAttrs,
  createTelemetry,
  lockEventAttrs,
  resolutionAttemptEventAttrs,
  runEndAttrs,
  runSpanAttrs,
  stepEndAttrs,
  stepSpanAttrs,
  TELEMETRY_EVENTS,
  TELEMETRY_SPAN_NAMES,
  type SpanHandle,
} from "../telemetry/index.ts";
import type {
  AdvisoryVerdict,
  AdvisoryIntentChangedVerdict,
  AdvisoryVerdictKind,
  RunVerdict,
  Strategy,
} from "../types.ts";
import type { ModelUsage } from "../artifacts/index.ts";
import type { RunClock, RunOptions, RunResult } from "./types.ts";

/** The default API-key env var when `[ai].api_key_env` is unset (PLAN.md §4 / §8 risk #5). */
export const DEFAULT_API_KEY_ENV = "OPENROUTER_API_KEY";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The default connect config when neither the flow nor config sets `connect`: Mode B launch,
 * HEADLESS, so the fixtures run self-contained (no BYO Chrome needed). PLAN.md §3 + the brief.
 */
export const DEFAULT_CONNECT_CONFIG: ConnectConfig = {
  mode: "launch",
  headless: true,
};

/**
 * Settle delay (ms) applied AFTER a successful ladder action, before the next step's single L1
 * snapshot. The L1 ladder resolves each step from ONE snapshot (it does not poll); after a click
 * that mutates the DOM (e.g. a wizard "Next" revealing the next section), Chrome's accessibility
 * tree updates ASYNCHRONOUSLY, so an immediate next-step snapshot can race a stale tree
 * (verified: the /wizard submit step intermittently saw the pre-reveal tree). A short settle
 * between ladder steps lets the AX tree catch up. Driven by the run clock, so tests with a
 * FakeClock incur ZERO real delay. (Assertions poll on their own and need no settle.)
 */
export const LADDER_SETTLE_MS = 150;

/** The verdict → process-exit-code mapping (PLAN.md §4 / the brief). */
export const VERDICT_EXIT_CODES: Record<RunVerdict, number> = {
  passed: 0,
  failed: 1,
  inconclusive: 3,
  error: 2,
};

/** A real wall-clock RunClock (production default). */
export const systemRunClock: RunClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// ---------------------------------------------------------------------------
// Step-do groupings
// ---------------------------------------------------------------------------

/**
 * The targeted verbs the ladder resolves+acts on. `ai_pick` is a click-like action that maps onto
 * the SAME resolve+act path (Phase 4) and additionally pins its choice into the lock
 * (`kind:'ai_pick'` → `pinned_choice`) so later runs replay it deterministically at L0.
 */
export const LADDER_VERBS = new Set<Step["do"]>(["click", "fill", "select", "ai_pick"]);

// ---------------------------------------------------------------------------
// Internal run state
// ---------------------------------------------------------------------------

/** Accumulated, mutable run state threaded through the step loop. */
interface RunState {
  stepSummaries: StepSummary[];
  /** EVERY failing assertion (for the report), independent of `fail_on_assertion`. */
  failedAssertions: Array<{ step: string; type: AssertionResult["type"]; detail: string }>;
  /** The first step id that drives a `failed` verdict (a step-action failure, or an assertion
   * failure when `fail_on_assertion` is true). `null` when nothing should fail the run. */
  failedStep: string | null;
  /** True once a deterministic failure should make the verdict `failed` (respects the flag). */
  verdictFailed: boolean;
  /** True once we must abort the remaining steps (eager fail, or a hard step error). */
  aborted: boolean;
  /** Set when the run hit an infra/harness error → verdict `error`. */
  runError: string | null;
  /** Step ids whose recipe drifted and self-healed (Phase 3). `drift_count == healedSteps.length`. */
  healedSteps: string[];
  /**
   * Set to the ceiling that tripped when a budget (`max_steps`/`max_model_calls`/`max_screenshots`/
   * `max_cost_usd`) is exceeded → verdict `inconclusive` (Phase 4). A budget overflow is NEVER a
   * `runError` (which would yield `error`); the run fails fast with the partial evidence gathered.
   */
  budgetExceeded: BudgetLimitName | null;
  /**
   * The FIRST L4 advisor verdict kind surfaced this run (annotates the summary; never overrides the
   * run verdict — PLAN.md §4). `null` when no step reached the advisor.
   */
  advisoryVerdict: AdvisoryVerdictKind | null;
  /**
   * The L4 advisor verdicts to act on after the loop (heal-write / proposed-patch), captured with
   * the step + any validated `signatureBasis` from a deeper acting tier (Phase 4).
   */
  advisorySteps: Array<{
    step: Step;
    verdict: AdvisoryVerdict;
    signatureBasis?: { sig: string; url: string };
  }>;
  /** The materialized `proposed-patches/` file path, set on an `intent_changed` verdict. */
  proposedPatchPath: string | null;
}

/** A fresh, empty {@link RunState}. */
function freshRunState(): RunState {
  return {
    stepSummaries: [],
    failedAssertions: [],
    failedStep: null,
    verdictFailed: false,
    aborted: false,
    runError: null,
    healedSteps: [],
    budgetExceeded: null,
    advisoryVerdict: null,
    advisorySteps: [],
    proposedPatchPath: null,
  };
}

// ---------------------------------------------------------------------------
// Cross-cutting run services (Phase 5: redaction + telemetry + media)
// ---------------------------------------------------------------------------

/**
 * The Phase-5 cross-cutting services threaded through the step loop (and hook flows) alongside the
 * existing writers/clock/session/runtime. Bundled into one object so the inner signatures grow by a
 * single param. Every member is a no-op/identity when its feature is disabled (an AI-less /
 * no-secret / no-token / no-record run is behavior-identical to before).
 */
interface RunServices {
  /** Redaction policy (secrets + PII). Identity when disabled — see {@link createRedactor}. */
  redactor: Redactor;
  /** The telemetry run span (root). Per-step spans are `runSpan.child(...)`. NOOP when disabled. */
  runSpan: SpanHandle;
  /**
   * Mutable holder of the active step span. The `onAiCall` telemetry bridge (set once on the AI
   * runtime, before the loop) reads this so an `ai_call` event lands on the CURRENT step's span —
   * including ai_judge assertions and hook-flow steps. Reset to `runSpan` between steps.
   */
  activeSpan: { current: SpanHandle };
  /** `[browser] record` — opt-in run video / per-step frame capture (default off). */
  record: boolean;
  /** `[redaction] redact_media` — skip persisting a secret-adjacent step's frame (fail-closed). */
  redactMedia: boolean;
  /** The run's `screenshots/` dir (per-step frames + bp's `record` output land here). */
  screenshotsDir: string;
  /** Collected persisted screenshot paths → `RunSummary.screenshot_paths`. */
  screenshotPaths: string[];
  /** Monotonic frame index for unique screenshot filenames. */
  shotIndex: { n: number };
}

/**
 * Persist a per-step screenshot frame when recording is on, honoring `redact_media`. v0 fail-closed
 * policy (P5_DESIGN.md §6 / Risk V2): when redaction is active AND the step is a `secret:true` fill,
 * SKIP persisting the frame entirely (the in-memory L3 vision base64 is untouched — resolution still
 * works). Collects the written path into `services.screenshotPaths` and emits an `artifact_created`
 * telemetry event. Never throws — media capture must never break a run.
 */
async function maybePersistScreenshot(
  driver: Driver,
  step: Step,
  services: RunServices,
  span: SpanHandle,
): Promise<void> {
  if (!services.record || !driver.saveScreenshot) return;
  if (
    services.redactMedia &&
    services.redactor.enabled &&
    step.do === "fill" &&
    step.secret === true
  ) {
    return; // fail-closed: never persist a secret-adjacent frame to disk.
  }
  const idx = services.shotIndex.n++;
  const path = `${services.screenshotsDir}/${String(idx).padStart(3, "0")}-${step.id}.png`;
  try {
    const saved = await driver.saveScreenshot(path);
    if (saved) {
      services.screenshotPaths.push(saved);
      span.event(
        TELEMETRY_EVENTS.artifactCreated,
        artifactCreatedAttrs({ kind: "screenshot", path: saved }),
      );
    }
  } catch {
    /* media capture is best-effort — never fail the run on a frame persist error */
  }
}

// ---------------------------------------------------------------------------
// Templating
// ---------------------------------------------------------------------------

/**
 * Resolve a flow's effective inputs and apply templating to every step. The import graph is
 * resolved first so the root flow's inputs (and any `with` overrides from importing flows, when
 * this flow is itself imported) are in scope — but for a directly-invoked flow the root node's
 * inputs are simply its declared `[inputs]` resolved against env.
 */
function templateFlow(
  flow: FlowFile,
  inputs: Record<string, string>,
  env: Record<string, string | undefined>,
): { steps: Step[]; inputs: Record<string, string> } {
  const ctx: TemplateContext = { inputs, env };
  // Template the step list (deep — covers urls, values, hints, assertion text/selectors).
  const steps = flow.steps.map((s) => applyTemplatingDeep(s, ctx));
  return { steps, inputs };
}

// ---------------------------------------------------------------------------
// Connect config + assertion config
// ---------------------------------------------------------------------------

/** Pick the connect config: flow/config `connect` if present, else Mode B headless launch. */
export function resolveConnectConfig(config: ResolvedConfig): ConnectConfig {
  return config.connect ?? DEFAULT_CONNECT_CONFIG;
}

/** Build the AssertContext slice from the resolved config + the run clock + the (optional) AI runtime. */
function buildAssertContext(
  driver: Driver,
  config: ResolvedConfig,
  clock: RunClock,
  runtime: AiRuntime | undefined,
): Omit<AssertContext, "mode"> & { mode: "eager" | "deferred" } {
  // `RunLimits` always has assertions/fail_on_assertion/assert_timeout_ms (built-in defaults).
  const mode = config.run.assertions ?? "eager";
  const failOnAssertion = config.run.fail_on_assertion ?? true;
  const defaultTimeoutMs = config.run.assert_timeout_ms ?? 5000;
  // The assert engine wants an AssertClock (now/sleep) — the RunClock satisfies it structurally.
  const assertClock: AssertClock = { now: () => clock.now(), sleep: (ms) => clock.sleep(ms) };
  const ctx: Omit<AssertContext, "mode"> & { mode: "eager" | "deferred" } = {
    driver,
    defaultTimeoutMs,
    mode,
    failOnAssertion,
    clock: assertClock,
  };
  // Route `ai_judge` assertions to the runtime's oracle when AI is available; absent → the engine
  // keeps its Phase-2 stub and AI-less runs are unchanged. The engine only ever routes a narrowed
  // `ai_judge` assertion here, so the cast to `AiJudgeAssertion` is sound (and sidesteps the
  // contravariant-param mismatch between the seam's `Assertion` slot and `judge`'s narrower param).
  if (runtime) {
    const judge = runtime.judge;
    ctx.aiJudge = (assertion, opts) => judge(assertion as AiJudgeAssertion, opts);
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Emitting ladder attempts as trace events
// ---------------------------------------------------------------------------

/** Map a ladder attempt's escalation/ok into a short outcome string for the trace event. */
function attemptOutcome(ok: boolean, escalated: boolean): string {
  if (ok) return "resolved";
  if (escalated) return "escalated";
  return "unresolved";
}

/**
 * Emit a `browser_action` (the coupled act) + one `resolution_attempt` per ladder tier tried.
 * Returns nothing — pure side-effect on the trace writer.
 */
async function emitLadderTrace(
  writers: ArtifactWriters,
  stepId: string,
  action: string,
  selectorOrIntent: string,
  result: LadderResult,
  redactor: Redactor,
  span: SpanHandle,
): Promise<void> {
  const exec = result.execution;
  // Defense-in-depth: the intent/target string never carries the fill VALUE, but a PII-bearing
  // intent could leak into trace.jsonl — redact it (identity when redaction is disabled).
  const browserAction: Parameters<ArtifactWriters["trace"]["emitBrowserAction"]>[0] = {
    action,
    selectorOrIntent: redactor.redactText(selectorOrIntent),
    ok: exec.ok,
    durationMs: result.attempts.reduce((sum, a) => sum + (a.durationMs ?? 0), 0),
  };
  if (exec.selectorUsed !== undefined) browserAction.selectorUsed = exec.selectorUsed;
  if (exec.strategy != null) browserAction.strategy = exec.strategy;
  if (exec.failureReason !== undefined) browserAction.failureReason = exec.failureReason;
  if (exec.coveringElement !== undefined) {
    browserAction.coveringElement = JSON.stringify(exec.coveringElement);
  }
  await writers.trace.emitBrowserAction(browserAction);
  span.event(
    TELEMETRY_EVENTS.browserAction,
    browserActionEventAttrs({ type: "browser_action", ts: 0, ...browserAction }),
  );

  for (const attempt of result.attempts) {
    const ev: Parameters<ArtifactWriters["trace"]["emitResolutionAttempt"]>[0] = {
      stepId,
      tier: attempt.tier,
      outcome: attemptOutcome(attempt.ok, attempt.escalated),
      durationMs: attempt.durationMs ?? 0,
    };
    if (attempt.strategy != null) ev.strategy = attempt.strategy as Strategy;
    await writers.trace.emitResolutionAttempt(ev);
    span.event(
      TELEMETRY_EVENTS.resolutionAttempt,
      resolutionAttemptEventAttrs({ type: "resolution_attempt", ts: 0, ...ev }),
    );
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Run the phase's assertions, emit an `assertion_result` per result, and fold failures into the
 * run state. Returns whether the phase produced ANY failing assertion (so the caller can apply
 * eager-abort policy). Honors eager × fail_on_assertion via the engine's eager short-circuit and
 * this function's abort signalling.
 */
async function runAndRecordAssertions(
  assertions: readonly Assertion[],
  phase: "before" | "after",
  stepId: string,
  assertCtx: ReturnType<typeof buildAssertContext>,
  writers: ArtifactWriters,
  state: RunState,
  span: SpanHandle,
  redactor: Redactor,
): Promise<{ anyFailed: boolean }> {
  if (assertions.length === 0) return { anyFailed: false };
  // Thread the step id so a routed `ai_judge` labels its `ai_call` purpose `judge:<stepId>`.
  const results = await runAssertions(assertions, { ...assertCtx, stepId }, phase);
  let anyFailed = false;
  for (const r of results) {
    // Redact the human-readable assertion message BEFORE it reaches any sink. The deterministic
    // evaluators (assert/conditions.ts) echo the configured `expected` AND the live observed DOM
    // value into `r.message` (value/text/visible/hidden/count), so a `secret:true` fill value would
    // otherwise leak in CLEARTEXT into run.jsonl's assertion_result, the telemetry assertion_result
    // event, and summary.json's failed_assertions. Redacting once here covers all three sinks
    // (the event feeds run.jsonl + telemetry; `detail` feeds summary.json). Identity when disabled.
    const message = redactor.redactText(r.message);
    const ev = {
      stepId,
      assertType: r.type,
      pass: r.pass,
      message,
      durationMs: r.durationMs,
    };
    await writers.run.emitAssertionResult(ev);
    span.event(
      TELEMETRY_EVENTS.assertionResult,
      assertionResultEventAttrs({ type: "assertion_result", ts: 0, ...ev }),
    );
    if (!r.pass) {
      anyFailed = true;
      state.failedAssertions.push({ step: stepId, type: r.type, detail: message });
      // A failed assertion fails the run ONLY when fail_on_assertion is true. With it false,
      // failures are reported (above) but treated as non-fatal warnings (the verdict stays
      // unaffected by assertions). See the assert engine's eager/deferred × fail table.
      if (assertCtx.failOnAssertion) {
        state.verdictFailed = true;
        if (state.failedStep === null) state.failedStep = stepId;
      }
    }
  }
  return { anyFailed };
}

// ---------------------------------------------------------------------------
// Per-step execution
// ---------------------------------------------------------------------------

/** The result of executing one step's ACTION (not its assertions). */
interface StepActionOutcome {
  ok: boolean;
  tier?: LadderTier;
  error?: string;
  /** True when the step's recipe drifted and self-healed (Phase 3). */
  healed?: boolean;
  /** True when a heal under `--frozen` must fail the run (drift not persisted in CI). */
  driftFail?: boolean;
  /**
   * The TERMINAL L4 advisor verdict, when the step exhausted the ladder and the advisor classified
   * it (Phase 4). The step still counts as failed (the advisor never resolves+acts); the runner
   * acts on the verdict after the loop (heal-write / proposed-patch / nothing) and surfaces it in
   * the summary, but it NEVER overrides the run verdict.
   */
  advisory?: AdvisoryVerdict;
  /**
   * A validated pre-action `signatureBasis` from a deeper acting tier, carried so an L4 `heal`
   * verdict can be persisted against the page it was learned on. Absent in practice today (the
   * advisor never acts), in which case a `heal` verdict is recorded but the speculative write is
   * skipped.
   */
  signatureBasis?: { sig: string; url: string };
}

/**
 * Perform a single step's ACTION (no assertions). Dispatches on `step.do`. Returns
 * ok/tier/error (+ heal accounting for ladder steps). Emits the appropriate trace events for
 * ladder-driven steps and, on a successful resolution, records the result against the lock
 * session (write policy: auto-heal / frozen / no-write).
 */
async function performStepAction(
  step: Step,
  driver: Driver,
  ladder: ReturnType<typeof createLadder>,
  writers: ArtifactWriters,
  clock: RunClock,
  session: LockSession | undefined,
  runtime: AiRuntime | undefined,
  services: RunServices,
  span: SpanHandle,
): Promise<StepActionOutcome> {
  switch (step.do) {
    case "goto": {
      await driver.goto(step.url);
      return { ok: true };
    }
    case "wait": {
      await clock.sleep(step.ms);
      return { ok: true };
    }
    case "press": {
      const ok = await driver.press(step.key);
      const ba = {
        action: "press",
        selectorOrIntent: services.redactor.redactText(step.key),
        ok,
        durationMs: 0,
      };
      await writers.trace.emitBrowserAction(ba);
      span.event(
        TELEMETRY_EVENTS.browserAction,
        browserActionEventAttrs({ type: "browser_action", ts: 0, ...ba }),
      );
      return ok ? { ok: true } : { ok: false, error: `press ${step.key} failed` };
    }
    case "assert": {
      // A standalone assert step has no action of its own — its assertions run in the
      // after-phase handling. Treat the action as a no-op success here.
      return { ok: true };
    }
    case "click":
    case "fill":
    case "select":
    case "ai_pick": {
      // `ai_pick` shares the resolve+act path (it maps to a click-like action); the only extra is
      // pinning its choice into the lock (`kind:'ai_pick'`) so later runs replay it at L0.
      //
      // We deliberately do NOT pass `ResolveContext.currentUrl`: L0 reads the URL from its own
      // snapshot (`snapshot.url`), and an extra `page.url()` CDP round-trip immediately before
      // the L1 snapshot was observed to destabilise browser-pilot's resolution over the shared
      // snapshot (browser-pilot 0.1.0). The lock hook (when present) gates L0; absent → L0 misses → L1.
      const ctx: ResolveContext = { driver, now: () => clock.now() };
      // Inject the run clock as the repair sleep (auto-repair's `missing`/`disabled` waits honor
      // the FakeClock in tests instead of incurring real timers). Additive/no-op when repair is
      // not reached (P5_DESIGN.md §1 / validation follow-up).
      ctx.sleep = (ms) => clock.sleep(ms);
      if (session) ctx.lock = session.hook;
      // Wire the L2/L3/L4 AI tiers (Phase 4). Absent → the orchestrator returns the failed L1
      // result with the handoff (AI-less runs behave exactly as in P2/P3).
      if (runtime) ctx.ai = runtime.hooks;
      const result = await ladder.resolveStep(step, ctx);
      const selectorOrIntent = ladderSelectorOrIntent(step);
      await emitLadderTrace(
        writers,
        step.id,
        step.do,
        selectorOrIntent,
        result,
        services.redactor,
        span,
      );
      const exec = result.execution;
      if (exec.ok) {
        // Write-back: learn/heal the recipe per the lock write policy (no-op without a session).
        // For ai_pick, forward `kind:'ai_pick'` so a `pinned_choice` is persisted, threading the
        // chosen candidate's human-readable name (`exec.pinnedLabel`, set by the AI acting tiers)
        // into the pin's `label` so a healed/replayed pin stays legible.
        let healed = false;
        let driftFail = false;
        if (session) {
          const rec = session.recordResolution(step, exec, {
            resolvedAtL0: exec.tier === "L0",
            ...(step.do === "ai_pick" ? { kind: "ai_pick" as const } : {}),
            ...(exec.pinnedLabel !== undefined ? { pinnedLabel: exec.pinnedLabel } : {}),
          });
          healed = rec.healed;
          driftFail = rec.fail;
        }
        // Let the AX tree settle after a DOM-mutating action so the NEXT step's single L1
        // snapshot is fresh (no real delay under a FakeClock — tests stay instant).
        await clock.sleep(LADDER_SETTLE_MS);
        return { ok: true, tier: exec.tier, healed, driftFail };
      }
      // The step could not resolve+act. With AI wired this may be a TERMINAL L4 advisor verdict
      // (the advisor classified the failure but never acts); without AI it is an L1 escalation the
      // P2 default could not consume. Either way the step fails — the advisory only annotates.
      const detail =
        exec.error ??
        (exec.escalate
          ? "step escalated past the deterministic ladder but no AI tier resolved it"
          : "step failed to resolve at L1");
      const out: StepActionOutcome = { ok: false, tier: exec.tier, error: detail };
      if (exec.advisory) out.advisory = exec.advisory;
      if (exec.signatureBasis) out.signatureBasis = exec.signatureBasis;
      return out;
    }
  }
}

/** The NL intent/target string a ladder step was resolving (for the browser_action event). */
function ladderSelectorOrIntent(step: Step): string {
  if ("intent" in step && step.intent) return step.intent;
  if ("target" in step && step.target) return step.target;
  return step.id;
}

// ---------------------------------------------------------------------------
// The main loop over steps
// ---------------------------------------------------------------------------

/**
 * Execute the ordered step list (already templated + resume-trimmed). Mutates `state`. Stops
 * early when `state.aborted` is set (eager assertion fail with fail_on_assertion, or a hard
 * error). Each step: step_start → before-assertions → action → after-assertions → step_end.
 */
async function executeSteps(
  steps: Step[],
  driver: Driver,
  ladder: ReturnType<typeof createLadder>,
  writers: ArtifactWriters,
  assertCtx: ReturnType<typeof buildAssertContext>,
  clock: RunClock,
  state: RunState,
  session: LockSession | undefined,
  runtime: AiRuntime | undefined,
  maxSteps: number | undefined,
  services: RunServices,
): Promise<void> {
  let stepsAttempted = 0;
  for (const step of steps) {
    if (state.aborted) break;

    // (0) max_steps budget (Phase 4). The tracker does NOT enforce this — the runner loop does.
    // The (maxSteps+1)-th step is never started: the run fails fast with the partial evidence
    // already gathered (verdict `inconclusive`, exit 3). Unlimited when `max_steps` is unset, so
    // AI-less runs that set no budget are byte-identical to before.
    if (maxSteps !== undefined && stepsAttempted >= maxSteps) {
      state.budgetExceeded = "max_steps";
      state.aborted = true;
      break;
    }
    stepsAttempted += 1;

    const stepStart = clock.now();
    const startPayload: Parameters<ArtifactWriters["run"]["emitStepStart"]>[0] = {
      stepId: step.id,
      do: step.do,
    };
    if ("intent" in step && step.intent) startPayload.intent = step.intent;
    await writers.run.emitStepStart(startPayload);

    // Open the per-step telemetry span (NOOP when telemetry is disabled). Make it the active span
    // so any `ai_call` (incl. routed ai_judge assertions) lands on THIS step. Reset to the run span
    // when the step ends (`endStep`). Idempotent — `SpanHandle.end` ignores a double-end.
    const stepSpanAttrPayload: { stepId: string; do: string; intent?: string } = {
      stepId: step.id,
      do: step.do,
    };
    if ("intent" in step && step.intent) stepSpanAttrPayload.intent = step.intent;
    const stepSpan = services.runSpan.child(TELEMETRY_SPAN_NAMES.step, stepSpanAttrs(stepSpanAttrPayload));
    services.activeSpan.current = stepSpan;
    const endStep = (ok: boolean, durationMs: number, healed: boolean, tier?: LadderTier): void => {
      stepSpan.end(stepEndAttrs({ ok, healed, repaired: false, durationMs, ...(tier ? { tier } : {}) }));
      services.activeSpan.current = services.runSpan;
    };

    try {
      // (1) before-phase assertions (e.g. preconditions).
      const beforeAssertions = "assert" in step && step.assert ? step.assert : [];
      const before = await runAndRecordAssertions(
        beforeAssertions,
        "before",
        step.id,
        assertCtx,
        writers,
        state,
        stepSpan,
        services.redactor,
      );
      if (before.anyFailed && assertCtx.failOnAssertion && assertCtx.mode === "eager") {
        // Eager + fail: a failed precondition aborts the run before acting (failedStep/verdictFailed
        // were already set by runAndRecordAssertions for these failing before-assertions).
        await emitStepEnd(writers, step.id, false, clock.now() - stepStart, {
          healed: false,
          error: "precondition (before-assertion) failed",
        });
        recordStepSummary(state, step, false, undefined, "precondition (before) failed", false);
        endStep(false, clock.now() - stepStart, false);
        state.aborted = true;
        break;
      }

      // (2) the step action.
      let action: StepActionOutcome;
      try {
        action = await performStepAction(
          step,
          driver,
          ladder,
          writers,
          clock,
          session,
          runtime,
          services,
          stepSpan,
        );
      } catch (err) {
        // A budget overflow propagates from the AI tiers — re-throw so the per-step budget handler
        // (below) maps it to `inconclusive`, NOT to a `runError`/`error`.
        if (isBudgetExceeded(err)) throw err;
        // Any other driver/ladder throw is an INFRA error → abort the run with verdict `error`.
        const detail = err instanceof Error ? err.message : String(err);
        action = { ok: false, error: detail };
        state.runError = `step ${step.id} threw: ${detail}`;
        state.aborted = true;
      }

      // A step-ACTION failure (the step couldn't resolve+act) is a deterministic step failure: it
      // always fails the run (independent of fail_on_assertion, which governs assertions only).
      if (!action.ok) {
        state.verdictFailed = true;
        if (state.failedStep === null) state.failedStep = step.id;
      }

      // L4 advisory verdict (Phase 4). The step still counts as failed (the advisor never acts);
      // we capture the verdict to act on after the loop and to annotate the summary. It NEVER
      // overrides the run verdict.
      if (action.advisory) {
        if (state.advisoryVerdict === null) state.advisoryVerdict = action.advisory.kind;
        state.advisorySteps.push({
          step,
          verdict: action.advisory,
          ...(action.signatureBasis ? { signatureBasis: action.signatureBasis } : {}),
        });
      }

      // Heal accounting (Phase 3). A self-heal is reported via `healed`/`drift_count` and, under
      // `--frozen`, fails the run (the committed lock is stale). The flow still proceeds (a heal
      // is not a step failure) — frozen drift fails the verdict but does not abort the loop.
      if (action.healed) {
        state.healedSteps.push(step.id);
        if (action.driftFail) {
          state.verdictFailed = true;
          if (state.failedStep === null) state.failedStep = step.id;
        }
      }

      // (3) after-phase assertions (validation). Run even if the action failed? No — if the action
      // failed there is nothing meaningful to validate; record the failure and stop the step.
      let afterFailed = false;
      if (action.ok) {
        const afterAssertions = "assert" in step && step.assert ? step.assert : [];
        const after = await runAndRecordAssertions(
          afterAssertions,
          "after",
          step.id,
          assertCtx,
          writers,
          state,
          stepSpan,
          services.redactor,
        );
        afterFailed = after.anyFailed;
      }

      // (3.5) opt-in per-step screenshot frame (video recording on), honoring `redact_media`.
      await maybePersistScreenshot(driver, step, services, stepSpan);

      const stepOk = action.ok && !afterFailed;
      const durationMs = clock.now() - stepStart;
      const healed = action.healed ?? false;
      await emitStepEnd(writers, step.id, stepOk, durationMs, {
        healed,
        ...(action.tier ? { tier: action.tier } : {}),
        ...(action.error ? { error: action.error } : {}),
      });
      recordStepSummary(state, step, stepOk, action.tier, action.error, healed);
      endStep(stepOk, durationMs, healed, action.tier);

      // Abort policy:
      //   - EAGER: stop at the first step that fails the verdict (failed action, or a failed
      //     after-assertion when fail_on_assertion). This is the fail-fast path.
      //   - DEFERRED: keep going; collect every failure and fail at the end.
      //   - A hard infra error (state.runError) ALWAYS aborts regardless of mode.
      if (assertCtx.mode === "eager" && (!action.ok || (afterFailed && assertCtx.failOnAssertion))) {
        state.aborted = true;
      }
      if (state.runError) state.aborted = true;
    } catch (err) {
      // A budget overflow anywhere in the step (action OR a routed ai_judge assertion): fail fast
      // with `inconclusive`, recording this step as partial evidence (a step_end + summary row).
      if (isBudgetExceeded(err)) {
        state.budgetExceeded = err.limit;
        state.aborted = true;
        const detail = `budget exceeded: ${err.limit}`;
        await emitStepEnd(writers, step.id, false, clock.now() - stepStart, {
          healed: false,
          error: detail,
        });
        recordStepSummary(state, step, false, undefined, detail, false);
        endStep(false, clock.now() - stepStart, false);
        break;
      }
      endStep(false, clock.now() - stepStart, false);
      throw err; // unexpected — propagate to runFlow's harness-error handler
    }
  }
}

/** Emit a step_end event. `healed` is set when the step's recipe drifted + self-healed (P3). */
function emitStepEnd(
  writers: ArtifactWriters,
  stepId: string,
  ok: boolean,
  durationMs: number,
  extra: { healed: boolean; tier?: LadderTier; error?: string },
): Promise<void> {
  const payload: Parameters<ArtifactWriters["run"]["emitStepEnd"]>[0] = {
    stepId,
    ok,
    healed: extra.healed,
    durationMs,
  };
  if (extra.tier) payload.tier = extra.tier;
  if (extra.error) payload.error = extra.error;
  return writers.run.emitStepEnd(payload);
}

/** Append the per-step rollup row to the run state. */
function recordStepSummary(
  state: RunState,
  step: Step,
  ok: boolean,
  tier: LadderTier | undefined,
  error: string | undefined,
  healed: boolean,
): void {
  const row: StepSummary = { stepId: step.id, do: step.do, ok, healed, durationMs: 0 };
  if (tier) row.tier = tier;
  if (error) row.error = error;
  state.stepSummaries.push(row);
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/** Compute the run verdict from the accumulated state. Precedence: error > inconclusive > failed
 * > passed (PLAN.md §4 verdict semantics).
 *   error        → an infra/connect/harness error occurred.
 *   inconclusive → a budget ceiling was exceeded (fail-fast with partial evidence, Phase 4). A
 *                  `BudgetExceededError` is NEVER classified as `runError`, so it outranks `failed`
 *                  but never masks a genuine harness `error`.
 *   failed       → a deterministic step-action failed, OR a failing assertion under fail_on_assertion.
 *   passed       → everything ok (failing assertions with fail_on_assertion=false are reported but
 *                  do NOT fail the run — they stay non-fatal warnings). */
export function computeVerdict(state: RunState): RunVerdict {
  if (state.runError) return "error";
  if (state.budgetExceeded) return "inconclusive";
  if (state.verdictFailed || state.failedStep !== null) return "failed";
  return "passed";
}

// ---------------------------------------------------------------------------
// Setup / teardown hooks (referenced flows)
// ---------------------------------------------------------------------------

/**
 * Run a referenced setup/teardown flow's steps inline against the same driver. Loads the referenced
 * flow, templates it against its own inputs, and runs each step through the same dispatcher. A setup
 * failure is recorded against the passed state (it aborts before the main steps); teardown failures
 * run on their own sub-state and never override an already-good verdict (best-effort cleanup).
 *
 * IMPORTS/HOOKS END-TO-END (Phase 5): the hook opens its OWN per-file {@link LockSession} against the
 * hook module's sidecar `<module>.lock.toml` (1:1 file↔lock — PROPOSAL "each file keeps exactly one
 * lock"). So a setup flow's steps L0-hit and heal-write against the SETUP flow's own lock, not the
 * root's, and provenance routing is exercised end-to-end. The run's write `mode` (frozen/no-write/
 * auto) + redaction + telemetry flow through `services` exactly like a main-flow step.
 */
async function runHookFlow(
  hookPath: string,
  baseDir: string,
  env: Record<string, string | undefined>,
  driver: Driver,
  ladder: ReturnType<typeof createLadder>,
  writers: ArtifactWriters,
  assertCtx: ReturnType<typeof buildAssertContext>,
  clock: RunClock,
  state: RunState,
  runtime: AiRuntime | undefined,
  lockMode: LockWriteMode,
  services: RunServices,
): Promise<void> {
  const resolvedPath = hookPath.startsWith("/") ? hookPath : `${baseDir}/${hookPath}`;
  const loaded = await loadFlowFile(resolvedPath);
  const inputs = resolveInputs(loaded.flow.inputs, undefined, env, {});
  const { steps } = templateFlow(loaded.flow, inputs, env);
  // Open the hook module's OWN lock session (its sidecar `<module>.lock.toml`). The hook's steps
  // L0-hit + heal against THIS lock; a missing/malformed lock loads fresh (auto-heal default).
  const hookSession = await openLockSession({
    lockPath: defaultLockPath(resolvedPath),
    source: loaded.path,
    sourceHash: loaded.sourceHash,
    ...(loaded.flow.description ? { description: loaded.flow.description } : {}),
    mode: lockMode,
    inferStrategy: selectorUsedToStrategy,
    now: () => clock.now(),
  });
  // `max_steps` is a main-flow budget, so hook steps are not counted against it (maxSteps undefined).
  await executeSteps(
    steps,
    driver,
    ladder,
    writers,
    assertCtx,
    clock,
    state,
    hookSession,
    runtime,
    undefined,
    services,
  );
  // Persist the hook module's learned/healed recipes (auto mode only; frozen/no-write never write).
  // Skip the flush on a harness error (the in-memory lock state is unreliable).
  if (!state.runError) {
    try {
      await hookSession.flush();
    } catch {
      // A hook lock-write failure is non-fatal to the run verdict (the resolution already happened).
    }
  }
}

// ---------------------------------------------------------------------------
// runFlow — the entrypoint
// ---------------------------------------------------------------------------

/**
 * Run a flow end-to-end. Loads + templates the flow, resolves the connect config, opens artifact
 * writers, connects the driver, walks the steps (resume-trimmed via `fromStep`), runs assertions,
 * computes the verdict + totals, writes the summary, and ALWAYS tears the driver down (finally).
 * Returns the {@link RunResult} (summary + run dir + exit code). Never throws for a flow-level
 * failure — only re-throws a programming error after teardown (it still writes what it can).
 */
export async function runFlow(opts: RunOptions): Promise<RunResult> {
  const clock = opts.clock ?? systemRunClock;
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const artifactClock: ArtifactClock = () => clock.now();

  // --- (1) load + import-resolve + template ---
  const loaded = await loadFlowFile(opts.flowPath);
  // Resolve the import graph (root node carries this flow's resolved inputs).
  const graph = await resolveImports(loaded, { env });
  const rootNode = graph.nodes.get(graph.rootPath);
  const inputs = rootNode?.inputs ?? resolveInputs(loaded.flow.inputs, undefined, env, {});
  const { steps: allSteps } = templateFlow(loaded.flow, inputs, env);

  // Resume support: trim to the steps at/after `fromStep`.
  const steps = trimFromStep(allSteps, opts.fromStep);

  // --- (2) connect config + artifact run dir + writers ---
  const connectCfg = resolveConnectConfig(opts.config);
  const runDir = await createRun({
    ...(opts.out !== undefined ? { baseDir: opts.out } : {}),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
  });
  const writers = openArtifactWriters(runDir, artifactClock);

  // --- (2.05) redaction (Phase 5) — secrets + PII masked before anything is logged/traced/sent ---
  // Gather every `secret:true` fill value (+ backing inputs) across the ROOT steps AND the
  // setup/teardown hook nodes (the import graph already loaded them), so hook secrets are masked in
  // the shared run.jsonl / trace.jsonl / ai.jsonl too. `mask_text` (default fail-closed `true`)
  // gates PII scrubbing; secret values are masked unconditionally. Disabled redactor = identity.
  const secrets = new Set<string>(gatherSecretValues(steps, inputs));
  for (const node of graph.nodes.values()) {
    if (node.relation !== "setup" && node.relation !== "teardown") continue;
    const { steps: hookSteps } = templateFlow(node.loaded.flow, node.inputs, env);
    for (const v of gatherSecretValues(hookSteps, node.inputs)) secrets.add(v);
  }
  const redactor = createRedactor({
    maskText: opts.config.redaction.mask_text ?? true,
    secrets,
  });

  // --- (2.06) telemetry (Phase 5) — optional Logfire spans/events; NOOP when no token/sink ---
  const tel = createTelemetry({
    config: opts.config,
    env,
    ...(opts.telemetrySink ? { sink: opts.telemetrySink } : {}),
    now: () => clock.now(),
  });
  const runSpan = tel.startRun(runSpanAttrs({ flowId: loaded.flow.id, runId: runDir.runId }));

  // The bundle of cross-cutting P5 services threaded through the loop + hooks (no-op when disabled).
  const activeSpan: { current: SpanHandle } = { current: runSpan };
  const services: RunServices = {
    redactor,
    runSpan,
    activeSpan,
    record: opts.config.browser?.record === true,
    redactMedia: opts.config.redaction.redact_media ?? true,
    screenshotsDir: runDir.screenshotsDir,
    screenshotPaths: [],
    shotIndex: { n: 0 },
  };

  // The ai_call telemetry bridge (Risk R5): mirror each emitted `ai_call` onto the ACTIVE step span
  // without coupling `ai/` to telemetry. `SpanHandle.event` swallows its own errors; the `aiCall`
  // caller additionally guards the observer, so this can never break a run.
  const onAiCall = (event: Omit<AiCallEvent, "ts" | "type">): void => {
    activeSpan.current.event(
      TELEMETRY_EVENTS.aiCall,
      aiCallEventAttrs({ type: "ai_call", ts: 0, ...event }),
    );
  };

  // --- (2.1) build the AI runtime (Phase 4), gated on the test seam / API-key presence ---
  // Injected factory (tests) wins; otherwise build the real OpenRouter-backed runtime ONLY when
  // the configured API-key env var is present. No factory + no key → no runtime → AI tiers are
  // unavailable and the run behaves exactly as in P2/P3 (`ctx.ai`/`assertCtx.aiJudge` stay unset).
  // The redactor + the `onAiCall` telemetry bridge are threaded into the runtime so ai.jsonl is
  // redacted and ai_call telemetry lands on the active step span.
  const runtime = buildAiRuntime(opts, env, writers, clock, redactor, onAiCall);

  const state: RunState = freshRunState();

  // Emit run_start (config + limits summaries are compact, redaction-safe projections). Inputs are
  // masked via the redactor (secret values → REDACTED; PII when mask_text on).
  await writers.run.emitRunStart({
    runId: runDir.runId,
    flowId: loaded.flow.id,
    inputs: redactor.redactInputs(inputs),
    configSummary: configSummary(opts.config, connectCfg),
    limits: limitsSummary(opts.config),
  });

  const ladder = createLadder(opts.startTier !== undefined ? { startTier: opts.startTier } : {});

  // --- (2.5) open the lock session (read + compose committed lock; expose the L0 hook) ---
  // Maps the CLI flags to the write policy: auto-heal (default) / --frozen / --no-lock-write.
  // A missing lock → fresh empty (every step L0-misses → L1 learns); a malformed lock → empty +
  // warn (the auto-heal default). The default lock path is the sidecar `<flow>.lock.toml`.
  const lockMode = resolveLockWriteMode({
    ...(opts.frozen !== undefined ? { frozen: opts.frozen } : {}),
    ...(opts.noLockWrite !== undefined ? { noLockWrite: opts.noLockWrite } : {}),
  });
  const lockPath = opts.lockPath ?? defaultLockPath(loaded.path);
  // Phase 5 imports/composition: compose every `import`ed module's committed lock into the root's
  // read view (provenance routes heals back to each module's own file), and map a root step id that
  // matches an imported module's step onto that module's namespace so a root reference can L0-hit a
  // composed import recipe (`<namespace>:<step>`). Empty when there are no imports → behavior is
  // identical to before (the namespaceFor lookup only fires after a bare-key miss).
  const imported = buildSessionImports(graph);
  const stepNamespaces = buildStepNamespaceMap(graph);
  const session = await openLockSession({
    lockPath,
    source: loaded.path,
    sourceHash: loaded.sourceHash,
    description: loaded.flow.description,
    mode: lockMode,
    inferStrategy: selectorUsedToStrategy,
    now: () => clock.now(),
    ...(imported.length > 0 ? { imported } : {}),
    ...(stepNamespaces.size > 0
      ? { hookOptions: { namespaceFor: (step: Step) => stepNamespaces.get(step.id) } }
      : {}),
  });

  // --- (3) build the driver (factory) then connect; teardown ALWAYS in finally ---
  const driver = (opts.driverFactory ?? defaultDriverFactory)(connectCfg);
  const assertCtx = buildAssertContext(driver, opts.config, clock, runtime);

  // The produced video path (opt-in `[browser] record`), collected in the finally before teardown.
  let videoPath: string | null = null;

  try {
    await driver.connect(connectCfg);

    // --- (3.5) start opt-in recording (video / per-step frames) into the run's screenshots dir ---
    // Gated on `[browser] record` (default off). Feature-detected — a driver without recording (or
    // a record-off run) never calls it and behaves exactly as before. Never throws into the run.
    if (services.record && driver.startRecording) {
      try {
        await driver.startRecording({ dir: runDir.screenshotsDir });
      } catch {
        // recording is best-effort — a start failure degrades to no capture, never fails the run.
      }
    }

    // --- (4) setup hook (referenced flow) ---
    if (loaded.flow.setup && !state.aborted) {
      await runHookFlow(
        loaded.flow.setup,
        dirOf(loaded.path),
        env,
        driver,
        ladder,
        writers,
        assertCtx,
        clock,
        state,
        runtime,
        lockMode,
        services,
      );
    }

    // --- (5) the main step loop (max_steps budget enforced here) ---
    if (!state.aborted) {
      await executeSteps(
        steps,
        driver,
        ladder,
        writers,
        assertCtx,
        clock,
        state,
        session,
        runtime,
        opts.config.run.max_steps,
        services,
      );
    }

    // --- (5.4) act on L4 advisor verdicts (Phase 4): heal-write (only with a validated basis from
    // a deeper acting tier) / materialize an `intent_changed` proposed patch. `bug`/`flake` never
    // write. This NEVER changes the run verdict (the step already failed). ---
    await processAdvisoryVerdicts(state, runDir, session);

    // --- (5.5) persist learned/healed recipes (auto mode only; frozen/no-write never write) ---
    // Heals are written even when a later step/assertion failed (the recipe is still valid); a
    // harness error skips the flush (the in-memory state is unreliable).
    if (!state.runError) {
      try {
        const written = await session.flush();
        for (const path of written) {
          runSpan.event(TELEMETRY_EVENTS.lockWrite, lockEventAttrs({ source: path }));
        }
      } catch {
        // A lock-write failure is non-fatal to the run verdict (the resolution already happened).
      }
    }

    // --- (6) teardown hook (best-effort; runs even after a step failure, before driver teardown) ---
    if (loaded.flow.teardown) {
      // Teardown runs on its own fresh sub-state so its (best-effort) outcome does not corrupt
      // the main run verdict; failures are not folded into the main state.
      const teardownState: RunState = freshRunState();
      try {
        await runHookFlow(
          loaded.flow.teardown,
          dirOf(loaded.path),
          env,
          driver,
          ladder,
          writers,
          assertCtx,
          clock,
          teardownState,
          runtime,
          lockMode,
          services,
        );
      } catch {
        // teardown is best-effort — never let it turn a good run into an error.
      }
    }
  } catch (err) {
    // connect() or a fatal harness error → verdict `error` (not a flow `failed`).
    const detail = err instanceof Error ? err.message : String(err);
    state.runError = state.runError ?? `connect/harness error: ${detail}`;
  } finally {
    // --- (6.5) stop recording BEFORE teardown so the driver can finalize any video artifact ---
    // `null` (no single webm produced) is the graceful-degrade case — frames may still be on disk.
    if (services.record && driver.stopRecording) {
      try {
        videoPath = (await driver.stopRecording()) ?? null;
      } catch {
        videoPath = null; // a stop failure degrades to "no video"; the run is unaffected.
      }
      if (videoPath) {
        runSpan.event(
          TELEMETRY_EVENTS.artifactCreated,
          artifactCreatedAttrs({ kind: "video", path: videoPath }),
        );
      }
    }
    // The browser ALWAYS tears down — Mode B kills Chrome, Mode A disconnects. No orphan.
    try {
      await driver.teardown();
    } catch {
      // teardown failure is non-fatal; the verdict is already determined.
    }
  }

  // --- (7) verdict + totals + summary ---
  const verdict = computeVerdict(state);
  // Cost rollup from the AI runtime (Phase 4). No runtime (AI-less run) → zeros, exactly as before.
  const usage = runtime?.usageTotals() ?? { total_cost_usd: 0, model_usage: [] };
  const summary = buildSummary(
    verdict,
    loaded.flow.id,
    runDir,
    state,
    writers.trace.path,
    usage,
    services.screenshotPaths,
    videoPath,
  );

  await writers.run.emitRunEnd({
    verdict,
    totals: {
      steps_run: state.stepSummaries.length,
      drift_count: state.healedSteps.length,
      total_cost_usd: usage.total_cost_usd,
      model_usage: usage.model_usage,
    },
    ...(state.runError ? { error: state.runError } : {}),
  });
  await writeSummary(runDir, summary);
  await writers.close();

  // Close the telemetry run span (verdict + drift_count). NOOP when telemetry is disabled.
  runSpan.end(runEndAttrs({ verdict, driftCount: state.healedSteps.length }));

  return { summary, runDir: runDir.dir, exitCode: VERDICT_EXIT_CODES[verdict] };
}

/**
 * Build the AI runtime for a run, or `undefined` when AI is unavailable. The injected
 * `aiRuntimeFactory` (tests) takes precedence; otherwise the real OpenRouter-backed runtime is
 * built ONLY when the configured API-key env var (`[ai].api_key_env`, default `OPENROUTER_API_KEY`)
 * is present in `env`. No factory + no key → `undefined` (AI tiers stay unwired; P2/P3 behavior).
 * The runner NEVER imports the AI SDK directly — it goes through `ai/`'s `createOpenRouterGenerate`
 * / `createAiRuntime` (PLAN.md §2 dependency direction).
 */
function buildAiRuntime(
  opts: RunOptions,
  env: Record<string, string | undefined>,
  writers: ArtifactWriters,
  clock: RunClock,
  redactor: Redactor,
  onAiCall: (event: Omit<AiCallEvent, "ts" | "type">) => void,
): AiRuntime | undefined {
  if (opts.aiRuntimeFactory) {
    return opts.aiRuntimeFactory({
      config: opts.config,
      aiWriter: writers.ai,
      now: () => clock.now(),
      redactor,
      onAiCall,
    });
  }
  const keyEnv = opts.config.ai?.api_key_env ?? DEFAULT_API_KEY_ENV;
  const apiKey = env[keyEnv];
  if (!apiKey) return undefined;
  const generate = createOpenRouterGenerate({ apiKey });
  return createAiRuntime({
    config: opts.config,
    generate,
    aiWriter: writers.ai,
    now: () => clock.now(),
    redactor,
    onAiCall,
  });
}

/**
 * Build the {@link SessionImport}[] for the root lock session from the import graph's `import`-
 * relation modules (setup/teardown get their OWN per-hook sessions, not composed here). Each
 * import's recipe is namespaced by its flow id (`<flow.id>:<step>`) and its heals route back to the
 * module's own sidecar `<module>.lock.toml` via provenance.
 */
function buildSessionImports(graph: ImportGraph): SessionImport[] {
  const out: SessionImport[] = [];
  for (const node of graph.nodes.values()) {
    if (node.path === graph.rootPath || node.relation !== "import") continue;
    out.push({
      lockPath: defaultLockPath(node.path),
      source: node.loaded.path,
      sourceHash: node.loaded.sourceHash,
      namespace: node.loaded.flow.id,
      ...(node.loaded.flow.description ? { description: node.loaded.flow.description } : {}),
    });
  }
  return out;
}

/**
 * Map a step id to the namespace of the first `import`ed module that defines a step with that id, so
 * the root lock hook can L0-hit a composed import recipe (`<namespace>:<step>`) when the root's own
 * lock misses the bare key. Empty when there are no imports (preserving the pre-P5 behavior exactly).
 */
function buildStepNamespaceMap(graph: ImportGraph): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of graph.nodes.values()) {
    if (node.path === graph.rootPath || node.relation !== "import") continue;
    for (const step of node.loaded.flow.steps) {
      if (!map.has(step.id)) map.set(step.id, node.loaded.flow.id);
    }
  }
  return map;
}

/**
 * Act on the captured L4 advisor verdicts (Phase 4). `heal` writes the advisor's recipe to the lock
 * ONLY when a validated `signatureBasis` from a deeper ACTING tier is available (otherwise the
 * write is speculative — the advisor never acted — so it is recorded but skipped). `intent_changed`
 * materializes TWO artifacts under `<runDir>/proposed-patches/`: the primary human-readable
 * `<stepId>.patch` (referenced by `summary.proposed_patch_path`) and a structured `<stepId>.json`
 * sidecar. `bug`/`flake` never write. None of this changes the run verdict (the step already failed).
 */
async function processAdvisoryVerdicts(
  state: RunState,
  runDir: { proposedPatchesDir: string },
  session: LockSession | undefined,
): Promise<void> {
  for (const adv of state.advisorySteps) {
    try {
      if (adv.verdict.kind === "heal" && adv.signatureBasis && session) {
        // Speculative heal write: synthesize a durable resolution from the advisor's recipe gated
        // on the validated basis. (Today the advisor tier never carries a signatureBasis, so this
        // path is dormant — the verdict is recorded but no lock write happens, per spec.)
        const healExec: StepExecution = {
          ok: false,
          tier: "L4",
          escalate: false,
          durableSelector: adv.verdict.recipe.selector,
          strategy: adv.verdict.recipe.strategy,
          signatureBasis: adv.signatureBasis,
        };
        session.recordResolution(adv.step, healExec, { resolvedAtL0: false });
      } else if (adv.verdict.kind === "intent_changed") {
        // The `.patch` is the PRIMARY artifact (`proposed_patch_path` points at it); the `.json` is
        // a structured sidecar. v0 patch body is a human-readable diagnosis (no machine diff yet).
        const patchPath = `${runDir.proposedPatchesDir}/${adv.step.id}.patch`;
        const jsonPath = `${runDir.proposedPatchesDir}/${adv.step.id}.json`;
        const body = {
          step: adv.step.id,
          kind: "intent_changed" as const,
          summary: adv.verdict.summary,
          proposed_patch_path: adv.verdict.proposed_patch_path,
        };
        await Bun.write(jsonPath, `${JSON.stringify(body, null, 2)}\n`);
        await Bun.write(patchPath, intentChangedPatchBody(adv.step, adv.verdict));
        if (state.proposedPatchPath === null) state.proposedPatchPath = patchPath;
      }
      // `bug` / `flake`: never write (PLAN.md §5 Phase 4 / PROPOSAL "Advisory verdict").
    } catch {
      // Materializing a proposed patch / speculative heal write is best-effort — never let it turn
      // a failed run into a harness error.
    }
  }
}

/**
 * Render the human-readable `.patch` body for an `intent_changed` advisory verdict (v0). Not a
 * machine-applicable unified diff yet — a legible diagnosis a human/coding-agent acts on, naming the
 * step, the advisor's summary, and the relative path the verdict referenced.
 */
function intentChangedPatchBody(step: Step, verdict: AdvisoryIntentChangedVerdict): string {
  return [
    "# Flightplan proposed patch (intent_changed)",
    `# step: ${step.id} (do=${step.do})`,
    `# referenced-path: ${verdict.proposed_patch_path}`,
    "#",
    "# The advisor classified this step's failure as an app intent change: the step no longer",
    "# matches the application. Review the diagnosis below and update the flow accordingly.",
    "# (v0: human-readable diagnosis — not yet a machine-applicable diff.)",
    "",
    "## Diagnosis",
    verdict.summary,
    "",
  ].join("\n");
}

/** The production driver factory (a fresh BrowserPilotDriver). */
function defaultDriverFactory(_cfg: ConnectConfig): Driver {
  return new BrowserPilotDriver();
}

// ---------------------------------------------------------------------------
// Helpers: resume / summaries / redaction / paths
// ---------------------------------------------------------------------------

/** Trim the step list to start at `fromStep` (inclusive). Unknown id → run all steps. */
export function trimFromStep(steps: Step[], fromStep: string | undefined): Step[] {
  if (!fromStep) return steps;
  const idx = steps.findIndex((s) => s.id === fromStep);
  return idx >= 0 ? steps.slice(idx) : steps;
}

/** Directory of a file path (no node:path import needed — last slash split). */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : ".";
}

/**
 * The sidecar lock path for a flow when `--lock` is not given: `<flow>.lock.toml` (the `.toml`
 * suffix replaced, else appended). Mirrors the lint module's lock-discovery convention
 * (`src/lint/lint.ts`) so `lint` and `run` agree on where a flow's lock lives.
 */
function defaultLockPath(flowPath: string): string {
  return /\.toml$/i.test(flowPath)
    ? flowPath.replace(/\.toml$/i, ".lock.toml")
    : `${flowPath}.lock.toml`;
}

/** Build the final RunSummary from the accumulated state + the AI cost rollup (Phase 4) + the
 * collected media artifacts (Phase 5: persisted screenshots + the opt-in video path). */
function buildSummary(
  verdict: RunVerdict,
  flowId: string,
  runDir: { runId: string; dir: string },
  state: RunState,
  tracePath: string,
  usage: { total_cost_usd: number; model_usage: ModelUsage[] },
  screenshotPaths: string[],
  videoPath: string | null,
): RunSummary {
  return {
    verdict,
    flow_id: flowId,
    run_id: runDir.runId,
    run_dir: runDir.dir,
    failed_step: state.failedStep,
    failed_assertions: state.failedAssertions,
    advisory_verdict: state.advisoryVerdict,
    healed_steps: [...state.healedSteps],
    drift_count: state.healedSteps.length,
    screenshot_paths: [...screenshotPaths],
    video_path: videoPath,
    trace_path: tracePath,
    total_cost_usd: usage.total_cost_usd,
    model_usage: usage.model_usage,
    proposed_patch_path: state.proposedPatchPath,
    steps: state.stepSummaries,
  };
}

/** A compact, redaction-safe config summary for the run_start event. */
function configSummary(
  config: ResolvedConfig,
  connectCfg: ConnectConfig,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    connect_mode: connectCfg.mode,
  };
  if (connectCfg.mode === "launch" && connectCfg.headless !== undefined) {
    out.headless = connectCfg.headless;
  }
  if (config.browser?.provider) out.browser_provider = config.browser.provider;
  return out;
}

/** A compact run-limits summary for the run_start event (only the set fields). */
function limitsSummary(config: ResolvedConfig): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  const r = config.run;
  if (r.max_steps !== undefined) out.max_steps = r.max_steps;
  if (r.max_cost_usd !== undefined) out.max_cost_usd = r.max_cost_usd;
  if (r.assertions !== undefined) out.assertions = r.assertions;
  if (r.fail_on_assertion !== undefined) out.fail_on_assertion = r.fail_on_assertion;
  if (r.assert_timeout_ms !== undefined) out.assert_timeout_ms = r.assert_timeout_ms;
  return out;
}

