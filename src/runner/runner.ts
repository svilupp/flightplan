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
//   webmcp_call → exact page-provided WebMCP tool through the driver boundary; result assertions
//     and captures consume the structured return without entering the selector ladder.
//   assert (a `do:'assert'` step) + per-step `assert[]` → runAssertions(..., 'after').
//   Plus `when:'before'`/`when:'after'` assertions around every step.
//
// Verdict: passed (all steps + assertions ok) · failed (a deterministic step/assertion failed) ·
// inconclusive (reserved for budget/AI-unavailable — Phase 4) · error (infra/connect/throw).
//
// Canonical references: PLAN.md §3 (driver lifecycle), §4 (RunSummary / verdict), §5 Phase 2.

import {
  type AiRuntime,
  type BudgetLimitName,
  createAiRuntime,
  createGoogleGenerate,
  createOpenAiGenerate,
  createOpenRouterGenerate,
  isBudgetExceeded,
  type RecentAction,
} from "../ai/index.ts";
import type { ModelUsage } from "../artifacts/index.ts";
import {
  type AiCallEvent,
  type Clock as ArtifactClock,
  type ArtifactProvenance,
  type ArtifactWriters,
  createRun,
  type LadderTier,
  openArtifactWriters,
  type RunSummary,
  type StepSummary,
  type WebMcpEvidence,
  writeSummary,
} from "../artifacts/index.ts";
import {
  type AssertClock,
  type AssertContext,
  type AssertionResult,
  runAssertions,
} from "../assert/index.ts";
import type { CacheConfig, ConnectConfig, ResolvedConfig } from "../config/types.ts";
import {
  BrowserPilotDriver,
  type DialogPolicy,
  getBrowserPilotProvenance,
} from "../driver/browser-pilot-driver.ts";
import type {
  ActionReceipt,
  DispatchState,
  Driver,
  EmitCommandOptions,
  EmitCommandResult,
  EvalOptions,
  MatchedCondition,
  NativeDialogPolicy,
  NewPageExpectation,
  NewPageResult,
  WebMcpCallResult,
} from "../driver/index.ts";
import { selectorUsedToStrategy } from "../driver/index.ts";
import { type ImportGraph, resolveImports } from "../flow/imports.ts";
import { describeTarget, normalizeTarget } from "../flow/normalize-target.ts";
import { loadFlowFileFlattened } from "../flow/run.ts";
import { applyTemplatingDeep, resolveInputs, type TemplateContext } from "../flow/template.ts";
import type {
  AiJudgeAssertion,
  Assertion,
  Capture,
  FlowFile,
  PopupExpectation,
  Step,
} from "../flow/types.ts";
import {
  createLadder,
  type LadderResult,
  type ResolveContext,
  resolveVisionBatch,
  type StepExecution,
} from "../ladder/index.ts";
import {
  type CacheOptions,
  LockParseError,
  type LockSession,
  type LockWriteMode,
  openLockSession,
  type RecordResolutionResult,
  resolveLockWriteMode,
  type SessionImport,
} from "../lock/index.ts";
import { createRedactor, gatherSecretValues, REDACTED, type Redactor } from "../redaction/index.ts";
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
  type SpanHandle,
  stepEndAttrs,
  stepSpanAttrs,
  TELEMETRY_EVENTS,
  TELEMETRY_SPAN_NAMES,
} from "../telemetry/index.ts";
import type {
  AdvisoryIntentChangedVerdict,
  AdvisoryVerdict,
  AdvisoryVerdictKind,
  RunVerdict,
} from "../types.ts";
import {
  type Divergence,
  detectDivergence,
  isPathMutatingStep,
  isSyntheticRepairStepId,
  runPathRepair,
} from "./path-repair.ts";
import type { RunClock, RunOptions, RunResult } from "./types.ts";

/** The default API-key env var when `[ai].api_key_env` is unset (PLAN.md §4 / §8 risk #5). */
export const DEFAULT_API_KEY_ENV = "OPENROUTER_API_KEY";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The default connect config when neither the flow nor config sets `connect`: Mode A attach
 * to a general CDP endpoint at localhost:9222 (Chrome's conventional remote-debugging port).
 * A flow opts into a launched browser (or another endpoint) via an explicit `[connect]` block.
 * Note: `connect` is taken from the ENTRY flow only — imported flows' `[connect]` blocks are
 * intentionally ignored (imports contribute steps, never config).
 */
export const DEFAULT_CONNECT_CONFIG: ConnectConfig = {
  mode: "attach",
  browserURL: "localhost:9222",
};

/**
 * Settle delay (ms) applied AFTER a successful ladder action, before the next step's single L1
 * snapshot. The L1 ladder resolves each step from ONE snapshot (it does not poll); after a click
 * that mutates the DOM (e.g. a wizard "Next" revealing the next section), Chrome's accessibility
 * tree updates ASYNCHRONOUSLY, so an immediate next-step snapshot can race a stale tree
 * (verified: the /wizard submit step intermittently saw the pre-reveal tree). A short settle
 * between ladder steps lets the AX tree catch up. Driven by the run clock, so tests with a
 * FakeClock incur ZERO real delay. (Assertions poll on their own and need no settle.)
 *
 * This is the DEFAULT / fallback; the effective value is the resolved `[timeouts] settle_ms`
 * (`DEFAULT_TIMEOUTS.settle_ms`, kept in sync with this constant), threaded via `RunServices`.
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
  /**
   * L5 path-repair accounting (PLAN_v003 v003-6). `replanCount` is how many divergences the planner
   * repaired (one per divergence that produced repair steps); `repairedSteps` is the ids of the
   * synthetic repair steps that were spliced in + executed. Both are surfaced in the run summary.
   */
  replanCount: number;
  repairedSteps: string[];
  captures: Record<string, string>;
  secretCaptures: Set<string>;
  pages: Array<{
    targetId?: string;
    type?: string;
    opener?: string;
    openerTargetId?: string;
    url?: string;
    title?: string;
    role: "active" | "popup";
  }>;
  inconclusiveReason: string | null;
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
    replanCount: 0,
    repairedSteps: [],
    captures: {},
    secretCaptures: new Set(),
    pages: [],
    inconclusiveReason: null,
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
  /**
   * Post-action AX-tree settle (ms) slept after every successful ladder action (`[timeouts]
   * settle_ms`, default {@link LADDER_SETTLE_MS}). `0` disables it. Driven by the run clock, so a
   * FakeClock incurs zero real delay.
   */
  settleMs: number;
  /**
   * L0 cache-hit-quality tuning from `[cache]` config (L0 cache-hit quality — Layer 2). Threaded
   * into each ladder step's `ResolveContext.cache` (flow-level defaults; a per-step `cache` mode
   * overrides `signature`). Undefined when no `[cache]` block is set → default matching.
   */
  cache?: CacheOptions;
  /**
   * Author-declared deterministic attribute-hook names from `[resolve] attributes` (e.g.
   * `["data-cmd"]`). Threaded onto each ladder step's `ResolveContext.resolveAttributes` so an
   * AI-tier pick persists a discriminating `[data-cmd="c2"]` durable selector (Fix 1). Undefined
   * when the `[resolve]` block declares none (behavior unchanged).
   */
  resolveAttributes?: readonly string[];
  /**
   * The L5 path-repair planner policy (PLAN_v003 v003-6). Present ALWAYS in a resolved config
   * (`enabled` defaulted false — opt-in), but the divergence/replan machinery is guarded so it only fires when
   * an AI runtime is present AND `[plan].enabled` AND a real recorded expectation diverges — a
   * no-AI-runtime run is byte-identical to before.
   */
  plan: {
    enabled: boolean;
    /** The durable flow goal (defaults to the flow `description`) — the prompt-cache key + anchor. */
    goal: string;
    escalateConfidence?: number;
    escalateAttempts?: number;
  };
  inputs: Record<string, string>;
  env: Record<string, string | undefined>;
  dialogPolicy: NativeDialogPolicy;
  /** Run-time warning sink (defaults to stderr). */
  onWarn: (message: string) => void;
}

/**
 * The step verbs that can carry `secret === true` (flow schema): a secret `fill`/`select` VALUE, or
 * a secret `goto` URL. A frame captured on any of these could render the secret on screen, so
 * `redact_media` fail-closes on ALL of them (B7) — not just `fill` (the earlier gap that left secret
 * `select`/`goto` frames persisted). Kept in sync with the schema's `secret?: boolean` verbs.
 */
const SECRET_CAPABLE_VERBS = new Set<Step["do"]>([
  "fill",
  "select",
  "goto",
  "emit",
  "eval",
  "evaluate",
  "webmcp_call",
]);

/** True when this step both CAN carry a secret (schema) AND is flagged `secret === true`. */
function isSecretStep(step: Step): boolean {
  return (
    SECRET_CAPABLE_VERBS.has(step.do) &&
    "secret" in step &&
    (step as { secret?: boolean }).secret === true
  );
}

/**
 * Persist a per-step screenshot frame when recording is on, honoring `redact_media`. v0 fail-closed
 * policy (P5_DESIGN.md §6 / Risk V2): when redaction is active AND the step carries `secret:true`
 * (any of fill / select / goto — {@link isSecretStep}), SKIP persisting the frame entirely (the
 * in-memory L3 vision base64 is untouched — resolution still works). Collects the written path into
 * `services.screenshotPaths` and emits an `artifact_created` telemetry event. Never throws — media
 * capture must never break a run.
 */
async function maybePersistScreenshot(
  driver: Driver,
  step: Step,
  services: RunServices,
  span: SpanHandle,
): Promise<void> {
  if (!services.record || !driver.saveScreenshot) return;
  if (services.redactMedia && services.redactor.enabled && isSecretStep(step)) {
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
  const ctx: TemplateContext = { inputs, env, deferCaptures: true };
  // Template the step list (deep — covers urls, values, hints, assertion text/selectors).
  const steps = flow.steps.map((s) => applyTemplatingDeep(s, ctx));
  return { steps, inputs };
}

// ---------------------------------------------------------------------------
// Connect config + assertion config
// ---------------------------------------------------------------------------

/** Pick the connect config: flow/config `connect` if present, else attach to CDP at localhost:9222. */
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
    const active = runtime;
    ctx.aiJudge = (assertion, opts) => active.judge(assertion as AiJudgeAssertion, opts);
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
  // L0 portfolio health (DESIGN §3.4): surface the winning strategy's agreement count so
  // report/explain can show how many remembered strategies corroborate the pick (e.g. "3/4").
  if (exec.portfolio !== undefined) browserAction.agreement = exec.portfolio.agreement;
  if (exec.failureReason !== undefined) browserAction.failureReason = exec.failureReason;
  if (exec.coveringElement !== undefined) {
    browserAction.coveringElement = JSON.stringify(exec.coveringElement);
  }
  if (exec.dispatchState !== undefined) browserAction.dispatchState = exec.dispatchState;
  if (exec.retrySafe !== undefined) browserAction.retrySafe = exec.retrySafe;
  if (exec.matchedConditions !== undefined)
    browserAction.matchedConditions = exec.matchedConditions;
  if (exec.attempts !== undefined) browserAction.attempts = exec.attempts;
  if (exec.retryDecisionReason !== undefined)
    browserAction.retryDecisionReason = exec.retryDecisionReason;
  if (exec.retryReason !== undefined) browserAction.retryReason = exec.retryReason;
  if (exec.receipt !== undefined) browserAction.receipt = exec.receipt;
  if (exec.effect !== undefined) browserAction.effect = exec.effect;
  if (exec.anchor !== undefined) browserAction.anchor = exec.anchor;
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
    if (attempt.strategy != null) ev.strategy = attempt.strategy;
    if (attempt.dispatchState !== undefined) ev.dispatchState = attempt.dispatchState;
    if (attempt.retrySafe !== undefined) ev.retrySafe = attempt.retrySafe;
    if (attempt.matchedConditions !== undefined) ev.matchedConditions = attempt.matchedConditions;
    if (attempt.attempts !== undefined) ev.attempts = attempt.attempts;
    if (attempt.retryDecisionReason !== undefined)
      ev.retryDecisionReason = attempt.retryDecisionReason;
    if (attempt.retryReason !== undefined) ev.retryReason = attempt.retryReason;
    if (attempt.receipt !== undefined) ev.receipt = attempt.receipt;
    if (attempt.effect !== undefined) ev.effect = attempt.effect;
    if (attempt.anchor !== undefined) ev.anchor = attempt.anchor;
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
): Promise<{ anyFailed: boolean; deterministicCount: number; deterministicFailed: number }> {
  if (assertions.length === 0)
    return { anyFailed: false, deterministicCount: 0, deterministicFailed: 0 };
  // Thread the step id so a routed `ai_judge` labels its `ai_call` purpose `judge:<stepId>`.
  const results = await runAssertions(assertions, { ...assertCtx, stepId }, phase);
  let anyFailed = false;
  let deterministicCount = 0;
  let deterministicFailed = 0;
  for (const r of results) {
    if (r.type !== "ai_judge") deterministicCount += 1;
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
      if (r.type !== "ai_judge") deterministicFailed += 1;
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
  return { anyFailed, deterministicCount, deterministicFailed };
}

function normalizeDialogPolicy(policy: NonNullable<Step["dialog"]>): NativeDialogPolicy {
  return policy === "manual" ? "prompt" : policy;
}

function capturesForStep(step: Step): Capture[] {
  if (!("capture" in step) || step.capture === undefined) return [];
  return Array.isArray(step.capture) ? step.capture : [step.capture];
}

function popupForStep(step: Step): PopupExpectation | undefined {
  if (!("expect_page" in step || "popup" in step || "new_page" in step)) return undefined;
  return (
    ("expect_page" in step && step.expect_page) ||
    ("popup" in step && step.popup) ||
    ("new_page" in step && step.new_page) ||
    undefined
  );
}

function toDriverPopupExpectation(expectation: PopupExpectation): NewPageExpectation {
  return {
    ...(expectation.opener !== undefined
      ? { opener: expectation.opener, openerTargetId: expectation.opener }
      : {}),
    ...(expectation.url !== undefined ? { url: expectation.url } : {}),
    ...(expectation.title !== undefined ? { title: expectation.title } : {}),
    ...(expectation.type !== undefined ? { type: expectation.type } : {}),
    ...(expectation.target_id !== undefined ? { targetId: expectation.target_id } : {}),
    ...(expectation.timeout_ms !== undefined ? { timeoutMs: expectation.timeout_ms } : {}),
  };
}

async function captureBeforeState(
  driver: Driver,
  step: Step,
): Promise<NonNullable<ReturnType<typeof buildAssertContext>["beforeState"]>> {
  const assertions = "assert" in step && step.assert ? step.assert : [];
  const transitions = assertions.filter((a) => a.type === "transition");
  if (transitions.length === 0) return {};
  const out: NonNullable<ReturnType<typeof buildAssertContext>["beforeState"]> = {
    url: await driver.currentUrl().catch(() => undefined),
    values: {},
    states: {},
  };
  const needsText = transitions.some((a) => a.type === "transition" && a.kind === "text_changed");
  const snapshot = needsText ? await driver.snapshot() : undefined;
  if (snapshot) out.text = snapshot.text;
  for (const assertion of transitions) {
    if (assertion.type !== "transition" || !assertion.selector) continue;
    const state = await driver.elementState?.(assertion.selector);
    if (!state) continue;
    out.values![assertion.selector] = state.value;
    out.states![assertion.selector] =
      `${state.visible}:${state.value}:${state.checked}:${state.disabled}:${state.selected}`;
  }
  return out;
}

function readResultPath(root: unknown, path: string): { found: boolean; value: unknown } {
  if (path === ".") return { found: root !== undefined, value: root };
  const parts = path.split(".").filter((part) => part.length > 0);
  let value: unknown = root;
  for (const part of parts) {
    if (value === null || value === undefined || typeof value !== "object") {
      return { found: false, value: undefined };
    }
    if (!(part in (value as object))) return { found: false, value: undefined };
    value = (value as Record<string, unknown>)[part];
  }
  return { found: value !== undefined, value };
}

function stringifyCaptureValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  const serialized = JSON.stringify(value);
  return serialized ?? "";
}

async function captureStepValues(
  driver: Driver,
  step: Step,
  actionResult?: unknown,
): Promise<Record<string, string>> {
  const specs = capturesForStep(step);
  if (specs.length === 0) return {};
  const out: Record<string, string> = {};
  let snapshot: Awaited<ReturnType<Driver["snapshot"]>> | undefined;
  for (const spec of specs) {
    if (spec.type === "result") {
      const resolved = readResultPath(actionResult, spec.path ?? ".");
      if (resolved.found) out[spec.name] = stringifyCaptureValue(resolved.value);
      continue;
    }
    if (spec.type === "url") {
      out[spec.name] = await driver.currentUrl();
      continue;
    }
    if (spec.selector && driver.elementState) {
      const state = await driver.elementState(spec.selector);
      if (spec.type === "value") out[spec.name] = state.value ?? "";
      else if (spec.type === "text") out[spec.name] = state.text;
      else if (spec.state === "visible") out[spec.name] = String(state.visible);
      else if (spec.state === "hidden") out[spec.name] = String(!state.visible);
      else if (spec.state === "enabled") out[spec.name] = String(state.disabled !== true);
      else if (spec.state === "disabled") out[spec.name] = String(state.disabled === true);
      else if (spec.state === "checked") out[spec.name] = String(state.checked === true);
      else if (spec.state === "unchecked") out[spec.name] = String(state.checked === false);
      else if (spec.state === "selected") out[spec.name] = String(state.selected === true);
      else out[spec.name] = state.value ?? state.text;
      continue;
    }
    if (spec.type === "state" && driver.pageState) {
      const page = await driver.pageState();
      if (spec.state === "dialog") out[spec.name] = String(page.dialogOpen === true);
      else if (spec.state === "menu") out[spec.name] = String(page.menuOpen === true);
      else if (spec.state === "new_page") out[spec.name] = String((page.popupCount ?? 0) > 0);
      continue;
    }
    snapshot ??= await driver.snapshot();
    if (spec.type === "text") out[spec.name] = snapshot.text;
    else if (spec.type === "value") out[spec.name] = "";
    else if (spec.type === "state")
      out[spec.name] = String(snapshot.interactiveElements.length > 0);
  }
  return out;
}

/** Redact captures for persistence while retaining raw values in the in-memory template scope. */
function redactCapturedValues(
  step: Step,
  captured: Record<string, string>,
  redactor: Redactor,
): Record<string, string> {
  const specs = capturesForStep(step);
  const secretNames = new Set(
    specs.filter((spec) => spec.secret === true).map((spec) => spec.name),
  );
  return Object.fromEntries(
    Object.entries(captured).map(([name, value]) => [
      name,
      secretNames.has(name) ? REDACTED : redactor.redactValue(value),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Per-step execution
// ---------------------------------------------------------------------------

/** The result of executing one step's ACTION (not its assertions). */
interface StepActionOutcome {
  ok: boolean;
  tier?: LadderTier;
  error?: string;
  /**
   * DEFERRED lock write-back for a successful ladder resolution. Present only when the action
   * resolved+acted (`exec.ok`) AND a lock session is active. The caller invokes it to credit the
   * resolution against the lock (learn / re-rank / heal) — but ONLY once the FULL step outcome is a
   * pass (action ok AND assertions ok), so a wrong-but-clickable selector never earns a green and
   * climbs the portfolio on a step whose assertions fail (measured admin-crud regression). The
   * returned {@link RecordResolutionResult} drives the heal/drift accounting; invoking it more than
   * once would double-count, so the caller calls it exactly once per step. Absent → no write-back
   * (goto/wait/press/assert, a failed action, or a session-less run).
   */
  creditResolution?: () => RecordResolutionResult;
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
  dispatchState?: DispatchState;
  retrySafe?: boolean;
  matchedConditions?: MatchedCondition[];
  attempts?: number;
  retryDecisionReason?: string;
  retryReason?: string;
  receipt?: ActionReceipt;
  effect?: "observe" | "idempotent" | "at_most_once";
  anchor?: string;
  transportAmbiguous?: boolean;
  popup?: NewPageResult;
  captures?: Record<string, string>;
  actionResult?: unknown;
  webmcp?: WebMcpEvidence;
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
  preResolved?: LadderResult,
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
    case "switch_frame": {
      // Enter the `<iframe>` identified by the step's target so SUBSEQUENT steps resolve inside it.
      // The iframe ELEMENT lives in the current document, so we hand its selector(s) straight to the
      // driver (browser-pilot resolves it) — a `switch_frame` is NOT a cost-ladder resolution and
      // takes no snapshot/ranking. A natural-language-only target can't identify a frame → fail clean.
      const { selectors } = normalizeTarget(step.target);
      const desc = describeTarget(step.target) ?? step.id;
      if (selectors.length === 0) {
        return {
          ok: false,
          error:
            `switch_frame \`${step.id}\` needs a selector target identifying the <iframe> element ` +
            "(a natural-language-only target cannot enter a frame)",
        };
      }
      const ok = await driver.switchToFrame(selectors);
      const ba = {
        action: "switch_frame",
        selectorOrIntent: services.redactor.redactText(desc),
        ok,
        durationMs: 0,
      };
      await writers.trace.emitBrowserAction(ba);
      span.event(
        TELEMETRY_EVENTS.browserAction,
        browserActionEventAttrs({ type: "browser_action", ts: 0, ...ba }),
      );
      return ok
        ? { ok: true }
        : { ok: false, error: `switch_frame: could not enter iframe (${desc})` };
    }
    case "switch_to_main": {
      // Leave the current frame and return to the top document. Always succeeds (a no-op on the top
      // document); resets the driver's frame context so later steps resolve against the main frame.
      await driver.switchToMain();
      const ba = { action: "switch_to_main", selectorOrIntent: "", ok: true, durationMs: 0 };
      await writers.trace.emitBrowserAction(ba);
      span.event(
        TELEMETRY_EVENTS.browserAction,
        browserActionEventAttrs({ type: "browser_action", ts: 0, ...ba }),
      );
      return { ok: true };
    }
    case "emit": {
      // emit is inherently at-most-once: no ladder, no lock, no lock-relevant selector — just a
      // direct WebSocket command injection on the driver, mirroring the `press`/`switch_frame`
      // non-targeted path. A table payload is JSON-serialized here (the driver boundary only
      // accepts a string); templating already ran deep over the raw table (`applyTemplatingDeep`).
      if (!driver.emitCommand) {
        return {
          ok: false,
          error:
            `step ${step.id} declares an emit step, but the connected driver does not support ` +
            "emitCommand (browser-pilot >=0.2.0 required for the emit step's page.emitMessage)",
          // Never attempted a send — a clean, non-dispatched failure. emit owns its OWN
          // delivery/reply proof (EmitCommandResult) rather than the generic dispatch-receipt
          // machinery other verbs use, so this is always a normal step failure, never the
          // uncertain-dispatch → inconclusive path shared by click/fill/etc.
          dispatchState: "not_dispatched",
        };
      }
      const payload =
        typeof step.payload === "string" ? step.payload : JSON.stringify(step.payload);
      const emitOpts: EmitCommandOptions = {
        channel: step.channel,
        payload,
        ...(step.match !== undefined ? { match: step.match } : {}),
        ...(step.base64 !== undefined ? { base64: step.base64 } : {}),
        ...(step.await_reply
          ? {
              awaitReply: {
                ...(step.await_reply.where !== undefined ? { where: step.await_reply.where } : {}),
                ...(step.await_reply.match !== undefined ? { match: step.await_reply.match } : {}),
                ...(step.await_reply.timeout_ms !== undefined
                  ? { timeout: step.await_reply.timeout_ms }
                  : {}),
              },
            }
          : {}),
      };
      const redactedPayload = services.redactor.redactText(payload);
      const emitBa = (ok: boolean): void => {
        const ba = { action: "emit", selectorOrIntent: redactedPayload, ok, durationMs: 0 };
        void writers.trace.emitBrowserAction(ba);
        span.event(
          TELEMETRY_EVENTS.browserAction,
          browserActionEventAttrs({ type: "browser_action", ts: 0, ...ba }),
        );
      };
      // A dispatch/delivery failure (bp's `EmitTargetError` for an ambiguous socket, an
      // `awaitReply` timeout, or any other rejection) is a normal STEP failure — not an infra
      // error — so it is caught here rather than left to propagate to the run-loop's try/catch
      // (which maps an uncaught throw to verdict `error`, per the runner's INFRA-vs-step-failure
      // split). Normal `on_fail`/verdict machinery then applies exactly as for any other verb.
      let result: EmitCommandResult;
      try {
        result = await driver.emitCommand(emitOpts);
      } catch (err) {
        emitBa(false);
        const detail = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: `emit step ${step.id} failed: ${detail}`,
          dispatchState: "not_dispatched",
        };
      }
      const awaitedReply = step.await_reply !== undefined;
      const replyMissing = awaitedReply && result.reply === undefined;
      const ok = result.delivered && !replyMissing;
      emitBa(ok);
      if (!ok) {
        if (!result.delivered) {
          // `delivered: false` with `reason: "dispatched-unconfirmed"` means the frame was SENT
          // but bp could not confirm it over the wire (no `Network.webSocketFrameSent` proof) —
          // an uncertain dispatch, exactly like a click whose input events fired but whose effect
          // is unconfirmed. Any OTHER `delivered: false` reason (e.g. no matching socket) never
          // sent a frame at all, so it stays `not_dispatched`.
          const dispatchState: DispatchState =
            result.reason === "dispatched-unconfirmed" ? "uncertain" : "not_dispatched";
          const reason = `not delivered${result.reason ? ` (${result.reason})` : ""}`;
          return {
            ok: false,
            error: `emit step ${step.id}: ${reason}`,
            dispatchState,
          };
        }
        // `delivered: true` but the awaited reply never arrived: the frame WAS dispatched (and
        // confirmed) — only the reply-observation failed. That is a confirmed dispatch, not an
        // unconfirmed one.
        return {
          ok: false,
          error: `emit step ${step.id}: awaited reply was not received before timeout`,
          dispatchState: "dispatched",
        };
      }
      return { ok: true };
    }
    case "webmcp_call": {
      if (!driver.webmcpCall) {
        return {
          ok: false,
          error:
            "step " +
            step.id +
            " declares a webmcp_call step, but the connected driver does not " +
            "support WebMCP (browser-pilot >=0.4.1 required)",
          dispatchState: "not_dispatched",
          retrySafe: true,
        };
      }
      const effect = step.effect ?? "observe";
      const allowMutation = effect !== "observe";
      const opts = {
        tool: step.tool,
        input: step.input,
        ...(step.origin !== undefined ? { origin: step.origin } : {}),
        ...(step.from_origins !== undefined ? { fromOrigins: step.from_origins } : {}),
        allowMutation,
        ...(step.timeout_ms !== undefined ? { timeoutMs: step.timeout_ms } : {}),
      };
      const actionLabel = step.origin ? `${step.tool}@${step.origin}` : step.tool;
      const evidence = (result: WebMcpCallResult): WebMcpEvidence => ({
        tool: result.tool?.name ?? step.tool,
        ...((result.tool?.origin ?? step.origin)
          ? { origin: result.tool?.origin ?? step.origin }
          : {}),
        phase: result.phase,
        dispatchState: result.dispatchState,
        retrySafe: result.retrySafe,
        ...(result.tool?.annotations?.readOnlyHint !== undefined
          ? { readOnlyHint: result.tool.annotations.readOnlyHint }
          : {}),
        ...(result.tool?.annotations?.untrustedContentHint !== undefined
          ? { untrustedContentHint: result.tool.annotations.untrustedContentHint }
          : {}),
      });
      const emitTrace = (ok: boolean, result: WebMcpCallResult | undefined): void => {
        const ba = {
          action: "webmcp_call",
          selectorOrIntent: services.redactor.redactText(actionLabel),
          ok,
          durationMs: 0,
          ...(result?.dispatchState !== undefined ? { dispatchState: result.dispatchState } : {}),
          ...(result?.retrySafe !== undefined ? { retrySafe: result.retrySafe } : {}),
        };
        void writers.trace.emitBrowserAction(ba);
        span.event(
          TELEMETRY_EVENTS.browserAction,
          browserActionEventAttrs({ type: "browser_action", ts: 0, ...ba }),
        );
      };
      let result: WebMcpCallResult;
      try {
        result = await driver.webmcpCall(opts);
      } catch (err) {
        emitTrace(false, undefined);
        return {
          ok: false,
          error:
            "webmcp_call step " +
            step.id +
            " failed: " +
            services.redactor.redactText(err instanceof Error ? err.message : String(err)),
          dispatchState: "uncertain",
          retrySafe: false,
          effect,
          webmcp: {
            tool: step.tool,
            ...(step.origin !== undefined ? { origin: step.origin } : {}),
            phase: "invoke",
            dispatchState: "uncertain",
            retrySafe: false,
          },
        };
      }
      emitTrace(result.ok, result);
      if (!result.ok) {
        return {
          ok: false,
          error:
            "webmcp_call step " +
            step.id +
            " failed: " +
            services.redactor.redactText(result.error ?? "tool invocation failed"),
          dispatchState: result.dispatchState,
          retrySafe: result.retrySafe,
          effect,
          webmcp: evidence(result),
        };
      }
      return {
        ok: true,
        actionResult: result.result,
        dispatchState: result.dispatchState,
        retrySafe: result.retrySafe,
        effect,
        webmcp: evidence(result),
      };
    }
    case "eval": {
      // Escape-hatch JS execution (browser-pilot's `Page.evaluate`, which pierces a genuine
      // cross-origin OOPIF when the element verbs cannot). No ladder, no lock, no lock-relevant
      // selector — a direct driver call, mirroring the emit/switch_frame non-targeted path.
      const evalOpts: EvalOptions = {
        script: step.script,
        ...(step.frame !== undefined ? { frame: step.frame } : {}),
        ...(step.args !== undefined ? { args: step.args } : {}),
      };
      const redactedIntent = services.redactor.redactText(
        step.frame !== undefined ? `eval in ${step.frame}` : "eval",
      );
      const evalBa = (ok: boolean): void => {
        const ba = { action: "eval", selectorOrIntent: redactedIntent, ok, durationMs: 0 };
        void writers.trace.emitBrowserAction(ba);
        span.event(
          TELEMETRY_EVENTS.browserAction,
          browserActionEventAttrs({ type: "browser_action", ts: 0, ...ba }),
        );
      };
      let result: Awaited<ReturnType<Driver["evalInFrame"]>>;
      try {
        result = await driver.evalInFrame(evalOpts);
      } catch (err) {
        evalBa(false);
        const detail = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: `eval step ${step.id} failed: ${detail}`,
          dispatchState: "not_dispatched",
        };
      }
      if (!result.ok) {
        evalBa(false);
        // A frame that could never be entered means NOTHING ran — cleanly `not_dispatched`. A
        // thrown script exception means the frame WAS entered and the script started executing
        // before failing — its side effects (if any) are unknown, so it's `uncertain`, mirroring
        // the emit case's `dispatched-unconfirmed`. An older driver that hasn't been updated to
        // report `phase` falls back to `not_dispatched` (the prior, more conservative behavior).
        const dispatchState: DispatchState =
          result.phase === "script" ? "uncertain" : "not_dispatched";
        return {
          ok: false,
          error: `eval step ${step.id}: ${result.error ?? "evaluation failed"}`,
          dispatchState,
        };
      }
      // `expect` gates success and REPLACES the normal fill-verification path: "truthy" (default)
      // passes when the result is JS-truthy; any other literal string is compared against
      // `JSON.stringify(result)` for an exact match.
      const expectOk =
        step.expect === "truthy"
          ? Boolean(result.value)
          : JSON.stringify(result.value) === step.expect;
      evalBa(expectOk);
      if (!expectOk) {
        return {
          ok: false,
          error: `eval step ${step.id}: result did not satisfy expect = ${JSON.stringify(step.expect)}`,
          dispatchState: "dispatched",
        };
      }
      return { ok: true };
    }
    case "evaluate": {
      // Bare escape-hatch JS expression (browser-pilot's `page.evaluate`), which already routes
      // into whatever OOPIF child session a prior `switch_frame` step entered — no frame
      // targeting, no args/expect wrapper (see `eval` for the richer variant). No ladder, no
      // lock, no lock-relevant selector — a direct driver call, mirroring the emit/eval
      // non-targeted path.
      if (!driver.evaluateExpression) {
        return {
          ok: false,
          error:
            `step ${step.id} declares an evaluate step, but the connected driver does not ` +
            "support evaluateExpression (page.evaluate is not available on the connected driver)",
          dispatchState: "not_dispatched",
        };
      }
      const redactedIntent = step.secret
        ? services.redactor.redactText(step.expression)
        : step.expression;
      const evaluateBa = (ok: boolean): void => {
        const ba = { action: "evaluate", selectorOrIntent: redactedIntent, ok, durationMs: 0 };
        void writers.trace.emitBrowserAction(ba);
        span.event(
          TELEMETRY_EVENTS.browserAction,
          browserActionEventAttrs({ type: "browser_action", ts: 0, ...ba }),
        );
      };
      try {
        await driver.evaluateExpression(step.expression);
      } catch (err) {
        evaluateBa(false);
        const detail = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: `evaluate step ${step.id} failed: ${detail}`,
          dispatchState: "not_dispatched",
        };
      }
      evaluateBa(true);
      return { ok: true };
    }
    case "run": {
      // `run` steps are flattened into concrete child steps at LOAD time (flow/run.ts,
      // PLAN_v002 v002-8) — one reaching the dispatcher means the caller skipped
      // `loadFlowFileFlattened`. Fail the step loudly rather than silently no-op.
      return {
        ok: false,
        error:
          `run step \`${step.id}\` reached the runner unflattened — flows must be loaded via ` +
          `loadFlowFileFlattened`,
      };
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
      // L0 cache-hit quality (Layer 2): thread `[cache]` tuning. A per-step `cache` mode overrides
      // the flow-level `signature`; `ignore_regions` stays flow-level. No `[cache]` + no step
      // override → `ctx.cache` unset → default full-signature matching (behavior unchanged).
      const stepCache = "cache" in step ? step.cache : undefined;
      const mergedCache = mergeStepCache(services.cache, stepCache);
      if (mergedCache) ctx.cache = mergedCache;
      // Author-declared attribute hooks (`[resolve] attributes`, Fix 1): an AI-tier pick persists a
      // discriminating `[data-cmd="c2"]` durable selector so warm runs replay at L0 with no vision.
      if (services.resolveAttributes) ctx.resolveAttributes = services.resolveAttributes;
      // Wire the L2/L3/L4 AI tiers (Phase 4). Absent → the orchestrator returns the failed L1
      // result with the handoff (AI-less runs behave exactly as in P2/P3).
      if (runtime) ctx.ai = runtime.hooks;
      // Vision batching (PLAN_v003 §4 v003-3): when this step was part of a ≥2-step vision batch, its
      // resolution (screenshot + vision call + act) already ran up-front in `resolveVisionBatch`; we
      // consume that pre-resolved `LadderResult` here instead of a second per-step ladder call. All
      // downstream handling (trace emit, lock write-back, settle, error/advisory) is IDENTICAL to a
      // single-step resolve — only the resolve+act was hoisted. A group of size 1 or any broken
      // safety condition never sets `preResolved`, so the normal single-step path runs unchanged.
      const expectation = popupForStep(step);
      if (expectation && !driver.expectNewPage) {
        return {
          ok: false,
          error:
            `step ${step.id} declares a new-page expectation, but the driver cannot arm ` +
            "popup observation before dispatch",
          dispatchState: "not_dispatched",
          retrySafe: true,
        };
      }
      let popup: NewPageResult | undefined;
      let result: LadderResult;
      const resolve = async (): Promise<LadderResult> =>
        preResolved ?? ladder.resolveStep(step, ctx);
      if (expectation && driver.expectNewPage) {
        popup = await driver.expectNewPage(toDriverPopupExpectation(expectation), async () => {
          result = await resolve();
          return result;
        });
        // The callback above is the only dispatch owner. A missing/incorrect popup is an
        // observation failure and must not trigger another ladder tier or click.
        if (!result!) {
          return {
            ok: false,
            error: "new-page expectation completed without a resolution result",
            dispatchState: "uncertain",
            retrySafe: false,
            popup,
          };
        }
      } else {
        result = await resolve();
      }
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
        // Write-back is DEFERRED (not run here): learning/healing the recipe per the lock write
        // policy must be gated on the FULL step outcome (action ok AND assertions ok), NOT bare
        // action success — otherwise a WRONG-but-clickable selector earns a green and climbs the
        // per-step portfolio, so the next warm run replays the wrong pick (measured admin-crud
        // regression). We hand the caller a one-shot thunk that performs the write-back; the run
        // loop invokes it only after the step's after-assertions pass (a step with NO assertions
        // still credits on action success, exactly as before). For ai_pick, forward
        // `kind:'ai_pick'` so a `pinned_choice` is persisted, threading the chosen candidate's
        // human-readable name (`exec.pinnedLabel`, set by the AI acting tiers) into the pin's
        // `label` so a healed/replayed pin stays legible.
        const creditResolution = session
          ? (): RecordResolutionResult =>
              session.recordResolution(step, exec, {
                resolvedAtL0: exec.tier === "L0",
                // Layer 3: a revalidated L0 hit carries a fresh signature basis for the stale lock;
                // pass the flag so the write policy refreshes the stored sig (auto) without a heal.
                ...(exec.revalidated ? { revalidated: true } : {}),
                ...(step.do === "ai_pick" ? { kind: "ai_pick" as const } : {}),
                ...(exec.pinnedLabel !== undefined ? { pinnedLabel: exec.pinnedLabel } : {}),
              })
          : undefined;
        // Let the AX tree settle after a DOM-mutating action so the NEXT step's single L1
        // snapshot is fresh (no real delay under a FakeClock — tests stay instant). Effective
        // value is `[timeouts] settle_ms`; `0` skips the sleep entirely.
        if (services.settleMs > 0) await clock.sleep(services.settleMs);
        return {
          ok: popup?.matched !== false,
          ...(popup?.matched === false
            ? { error: popup.reason ?? "new-page expectation was not observed" }
            : {}),
          tier: exec.tier,
          ...(creditResolution ? { creditResolution } : {}),
          ...(exec.dispatchState !== undefined ? { dispatchState: exec.dispatchState } : {}),
          ...(exec.retrySafe !== undefined ? { retrySafe: exec.retrySafe } : {}),
          ...(exec.matchedConditions !== undefined
            ? { matchedConditions: exec.matchedConditions }
            : {}),
          ...(exec.attempts !== undefined ? { attempts: exec.attempts } : {}),
          ...(exec.retryDecisionReason !== undefined
            ? { retryDecisionReason: exec.retryDecisionReason }
            : {}),
          ...(exec.retryReason !== undefined ? { retryReason: exec.retryReason } : {}),
          ...(exec.receipt !== undefined ? { receipt: exec.receipt } : {}),
          ...(exec.effect !== undefined ? { effect: exec.effect } : {}),
          ...(exec.anchor !== undefined ? { anchor: exec.anchor } : {}),
          ...(popup ? { popup } : {}),
          ...(popup?.matched === false ? { transportAmbiguous: true, retrySafe: false } : {}),
        };
      }
      // The step could not resolve+act. With AI wired this may be a TERMINAL L4 advisor verdict
      // (the advisor classified the failure but never acts); without AI it is an L1 escalation the
      // P2 default could not consume. Either way the step fails — the advisory only annotates.
      const detail =
        exec.error ??
        (exec.escalate
          ? "step escalated past the deterministic ladder but no AI tier resolved it"
          : "step failed to resolve at L1");
      const out: StepActionOutcome = {
        ok: false,
        tier: exec.tier,
        error: detail,
        ...(exec.effect !== undefined ? { effect: exec.effect } : {}),
        ...(exec.anchor !== undefined ? { anchor: exec.anchor } : {}),
      };
      if (exec.advisory) out.advisory = exec.advisory;
      if (exec.signatureBasis) out.signatureBasis = exec.signatureBasis;
      if (exec.dispatchState !== undefined) out.dispatchState = exec.dispatchState;
      if (exec.retrySafe !== undefined) out.retrySafe = exec.retrySafe;
      if (exec.matchedConditions !== undefined) out.matchedConditions = exec.matchedConditions;
      if (exec.attempts !== undefined) out.attempts = exec.attempts;
      if (exec.retryDecisionReason !== undefined)
        out.retryDecisionReason = exec.retryDecisionReason;
      if (exec.retryReason !== undefined) out.retryReason = exec.retryReason;
      if (exec.receipt !== undefined) out.receipt = exec.receipt;
      if (popup) out.popup = popup;
      return out;
    }
  }
}

/**
 * Map the on-disk `[cache]` config (snake_case) to the ladder's `CacheOptions` (camelCase), or
 * `undefined` when the block is absent/empty (→ default matching). L0 cache-hit quality, Layer 2.
 */
function cacheOptionsFromConfig(cache: CacheConfig | undefined): CacheOptions | undefined {
  if (!cache) return undefined;
  const out: CacheOptions = {};
  if (cache.ignore_regions && cache.ignore_regions.length > 0) {
    out.ignoreRegions = cache.ignore_regions;
  }
  if (cache.signature !== undefined) out.signature = cache.signature;
  return out.ignoreRegions !== undefined || out.signature !== undefined ? out : undefined;
}

/**
 * Merge a per-step `cache` mode over the flow-level cache options (L0 cache-hit quality, Layer 2).
 * The step override only touches the `signature` match mode; `ignore_regions` stays flow-level.
 * Returns `undefined` when neither source contributes anything.
 */
function mergeStepCache(
  flow: CacheOptions | undefined,
  stepMode: "full" | "struct-only" | undefined,
): CacheOptions | undefined {
  if (stepMode === undefined) return flow;
  return { ...(flow ?? {}), signature: stepMode };
}

/** The NL description a ladder step was resolving (for the browser_action event). */
function ladderSelectorOrIntent(step: Step): string {
  const target = "target" in step ? step.target : undefined;
  return describeTarget(target) ?? step.id;
}

// ---------------------------------------------------------------------------
// The main loop over steps
// ---------------------------------------------------------------------------

/** Default `on_fail.max`: how many times a step may be RE-ENTERED via a jump before we give up. */
const DEFAULT_ON_FAIL_MAX = 1;

/** A snapshot of the failure-bearing run-state fields, so an `on_fail` jump can roll them back. */
interface StateSnapshot {
  failedStep: string | null;
  verdictFailed: boolean;
  failedAssertionsLen: number;
  healedStepsLen: number;
}

function snapshotState(state: RunState): StateSnapshot {
  return {
    failedStep: state.failedStep,
    verdictFailed: state.verdictFailed,
    failedAssertionsLen: state.failedAssertions.length,
    healedStepsLen: state.healedSteps.length,
  };
}

/**
 * Roll back the failure-bearing state to a pre-step snapshot. Used when an `on_fail` jump RECOVERS
 * a step that would otherwise have failed the run: the recovered attempt's assertion failures and
 * verdict flags are discarded (the recovery path is now in control). Heals are NOT rolled back —
 * a healed recipe is legitimately learned regardless of the subsequent jump.
 */
function restoreState(state: RunState, snap: StateSnapshot): void {
  state.failedStep = snap.failedStep;
  state.verdictFailed = snap.verdictFailed;
  state.failedAssertions.length = snap.failedAssertionsLen;
}

// ---------------------------------------------------------------------------
// Vision batching (PLAN_v003 §4 v003-3): group consecutive same-page vision targets
// ---------------------------------------------------------------------------

/**
 * Is this step a member of a vision batch — a locator-targeting verb explicitly hinted `tier_hint =
 * vision`? Only these steps can share one screenshot + one vision call. A `tier_hint = vision` step
 * (batched or single) still runs the free/deterministic L0+L1 tiers first, then — if it must
 * escalate — skips the L2 text tier and climbs STRAIGHT to L3 vision (pillar c; see the AI-climb in
 * `ladder/orchestrator.ts`'s `nextAiHook`).
 */
function isVisionBatchable(step: Step): step is Step & { tier_hint: "vision" } {
  // The `&&` chain: a hinted targeting verb, AND — to keep a group to pure targeting actions on ONE
  // unchanged page (the batch resolver's single up-front screenshot + snapshot precondition) — a
  // step WITHOUT per-step assertions (whose before/after must bracket ITS own action) and WITHOUT an
  // `on_fail` (whose jump needs per-step dispatch). Such steps fall to the single-step path instead.
  return (
    LADDER_VERBS.has(step.do) &&
    "tier_hint" in step &&
    step.tier_hint === "vision" &&
    !("assert" in step && step.assert && step.assert.length > 0) &&
    !("on_fail" in step && step.on_fail) &&
    popupForStep(step) === undefined
  );
}

/**
 * The length of the MAXIMAL run of consecutive {@link isVisionBatchable} steps starting at `start`.
 * Any non-vision-hinted step (incl. a page-navigating `goto`/`wait`/`press`, a standalone `assert`,
 * or a targeting step WITHOUT the hint) breaks the run — so a navigation/mutation between two
 * vision-hinted steps SPLITS the batch (they resolve on different pages, never one screenshot).
 * Returns 0 when the step at `start` is not batchable.
 */
function visionBatchRunLength(steps: Step[], start: number): number {
  let end = start;
  while (end < steps.length && isVisionBatchable(steps[end]!)) end += 1;
  return end - start;
}

/**
 * Execute the ordered step list (already templated + resume-trimmed). Mutates `state`. Stops
 * early when `state.aborted` is set (eager assertion fail with fail_on_assertion, or a hard
 * error). Each step: step_start → before-assertions → action → after-assertions → step_end.
 *
 * The loop is INDEX-driven with a jump table (`id → index`) so a step's `on_fail = { goto, max }`
 * can redirect control to another step (or retry `self`) instead of failing the run. A per-target
 * re-entry counter (bounded by `max`, default {@link DEFAULT_ON_FAIL_MAX}) prevents infinite loops;
 * the global `max_steps` budget is the ultimate backstop (every step attempt, including re-entries,
 * counts against it). With no `on_fail` anywhere the loop walks 0..N-1 exactly as before.
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
  // Jump table: step id → index. Ids are unique (enforced by the linter); on a duplicate the first
  // wins (matches steps/unique-ids' first-seen attribution). Absent-id steps are simply not targets.
  const idToIndex = new Map<string, number>();
  steps.forEach((s, i) => {
    if (!idToIndex.has(s.id)) idToIndex.set(s.id, i);
  });
  // Per-step re-entry counter: how many times control has JUMPED into each step id. Bounded by the
  // failing step's `on_fail.max` so a self-retry / recovery loop can never spin forever.
  const reentries = new Map<string, number>();
  // Vision batching (PLAN_v003 §4 v003-3): pre-resolved `LadderResult`s keyed by step id, populated
  // ONCE when the loop first reaches the head of a ≥2-step same-page vision batch (the shared
  // screenshot + vision call + acts all happen there). Each entry is consumed (deleted) when its
  // step runs, so an `on_fail` jump BACK into a batched step re-resolves it freshly against the now-
  // changed page rather than replaying a stale pre-resolved pick. Empty when no step is vision-hinted.
  const batchResults = new Map<string, LadderResult>();

  // L5 path-repair (PLAN_v003 v003-6): a bounded, redaction-safe recent-action history handed to the
  // planner as context, and a set of divergences already repaired (so a re-detected divergence on
  // the SAME diverged step id does not replan again in one pass). Empty/unused when the planner is
  // off or no AI runtime is present.
  const recent: RecentAction[] = [];
  const repairedDivergences = new Set<string>();

  let stepsAttempted = 0;
  let cursor = 0;
  while (cursor < steps.length) {
    if (state.aborted) break;
    const rawStep = steps[cursor]!;
    // Capture references are resolved at execution time, after earlier steps have observed them.
    const step = applyTemplatingDeep(rawStep, {
      inputs: services.inputs,
      env: services.env,
      captures: state.captures,
    });

    // (0) max_steps budget (Phase 4). The tracker does NOT enforce this — the runner loop does.
    // The (maxSteps+1)-th step is never started: the run fails fast with the partial evidence
    // already gathered (verdict `inconclusive`, exit 3). Unlimited when `max_steps` is unset, so
    // AI-less runs that set no budget are byte-identical to before. Re-entries from `on_fail` jumps
    // count too — the budget is the global backstop against a runaway jump loop.
    if (maxSteps !== undefined && stepsAttempted >= maxSteps) {
      state.budgetExceeded = "max_steps";
      state.aborted = true;
      break;
    }
    stepsAttempted += 1;

    // Snapshot the failure-bearing state so a successful `on_fail` jump can roll it back (the
    // recovered attempt must not leave a `failed` verdict or a stray failed-assertion behind).
    const preStep = snapshotState(state);

    // Attempt an `on_fail` jump for THIS step: returns the target index when the jump is taken
    // (failure-bearing state already rolled back), or `null` when we should fail normally.
    const tryOnFail = (failedAction?: StepActionOutcome): number | null => {
      // A possible post-dispatch failure is observation-only. Do not let `on_fail = self` or a
      // recovery jump turn an uncertain transport result into a second side effect.
      if (
        failedAction?.dispatchState === "dispatched" ||
        failedAction?.dispatchState === "uncertain" ||
        failedAction?.retrySafe === false
      ) {
        return null;
      }
      if (step.effect === "at_most_once" && failedAction) return null;
      const onFail = "on_fail" in step ? step.on_fail : undefined;
      if (!onFail) return null;
      if (step.retry?.policy === "never" && (onFail.goto === "self" || onFail.goto === step.id)) {
        return null;
      }
      // `goto = "self"` (or the step's own id) means retry this same step.
      const targetId = onFail.goto === "self" ? step.id : onFail.goto;
      const targetIndex = idToIndex.get(targetId);
      if (targetIndex === undefined) return null; // unknown target (the linter flags this) → fail
      const max = onFail.max ?? DEFAULT_ON_FAIL_MAX;
      const entered = reentries.get(targetId) ?? 0;
      if (entered >= max) return null; // re-entry budget exhausted → fail the run normally
      reentries.set(targetId, entered + 1);
      restoreState(state, preStep);
      return targetIndex;
    };

    const stepStart = clock.now();
    const startPayload: Parameters<ArtifactWriters["run"]["emitStepStart"]>[0] = {
      stepId: step.id,
      do: step.do,
      ...(step.effect !== undefined ? { effect: step.effect } : {}),
      ...(step.anchor !== undefined
        ? { anchor: step.anchor }
        : "target" in step && describeTarget(step.target)
          ? { anchor: describeTarget(step.target) }
          : {}),
    };
    {
      const targetDesc = "target" in step ? describeTarget(step.target) : undefined;
      if (targetDesc) startPayload.intent = targetDesc;
    }
    await writers.run.emitStepStart(startPayload);

    // Open the per-step telemetry span (NOOP when telemetry is disabled). Make it the active span
    // so any `ai_call` (incl. routed ai_judge assertions) lands on THIS step. Reset to the run span
    // when the step ends (`endStep`). Idempotent — `SpanHandle.end` ignores a double-end.
    const stepSpanAttrPayload: { stepId: string; do: string; intent?: string } = {
      stepId: step.id,
      do: step.do,
    };
    {
      const targetDesc = "target" in step ? describeTarget(step.target) : undefined;
      if (targetDesc) stepSpanAttrPayload.intent = targetDesc;
    }
    const stepSpan = services.runSpan.child(
      TELEMETRY_SPAN_NAMES.step,
      stepSpanAttrs(stepSpanAttrPayload),
    );
    services.activeSpan.current = stepSpan;
    const endStep = (ok: boolean, durationMs: number, healed: boolean, tier?: LadderTier): void => {
      stepSpan.end(
        stepEndAttrs({ ok, healed, repaired: false, durationMs, ...(tier ? { tier } : {}) }),
      );
      services.activeSpan.current = services.runSpan;
    };

    try {
      if (driver.setDialogPolicy) {
        await driver.setDialogPolicy(
          step.dialog ? normalizeDialogPolicy(step.dialog) : services.dialogPolicy,
        );
      }

      assertCtx.captures = state.captures;
      assertCtx.actionResult = undefined;
      assertCtx.beforeState = await captureBeforeState(driver, step);
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
        // Eager + fail: a failed precondition would abort the run before acting (failedStep/
        // verdictFailed were already set by runAndRecordAssertions). An `on_fail` on this step can
        // recover instead of aborting: roll the state back and jump.
        const jump = tryOnFail();
        await emitStepEnd(writers, step.id, false, clock.now() - stepStart, {
          healed: false,
          error: "precondition (before-assertion) failed",
          ...(step.effect !== undefined ? { effect: step.effect } : {}),
          ...(step.anchor !== undefined
            ? { anchor: step.anchor }
            : "target" in step && describeTarget(step.target)
              ? { anchor: describeTarget(step.target) }
              : {}),
        });
        recordStepSummary(state, step, false, undefined, "precondition (before) failed", false);
        endStep(false, clock.now() - stepStart, false);
        if (jump !== null) {
          cursor = jump;
          continue;
        }
        state.aborted = true;
        break;
      }

      // (2) the step action.
      let action: StepActionOutcome;
      try {
        // Vision batching (PLAN_v003 §4 v003-3): when the loop reaches the HEAD of a ≥2-step run of
        // consecutive same-page vision-hinted targeting steps (and an AI runtime is wired), resolve
        // the whole run through ONE screenshot + ONE vision call via `resolveVisionBatch`, caching a
        // `LadderResult` per step. Each grouped step then flows through the SAME `performStepAction`
        // + assertion + write-back path below, just consuming its cached result instead of a second
        // ladder call. A lone hint (run length 1), a runtime-less run, or a broken safety condition
        // never populates the cache → the normal per-step path runs unchanged. Kept inside this
        // `try` so a `BudgetExceededError` from the shared screenshot/vision call maps to
        // `inconclusive` via the same handler as a single-step AI call.
        if (
          runtime &&
          !batchResults.has(step.id) &&
          isVisionBatchable(step) &&
          visionBatchRunLength(steps, cursor) >= 2
        ) {
          const groupLen = visionBatchRunLength(steps, cursor);
          const group = steps.slice(cursor, cursor + groupLen);
          const ctx: ResolveContext = { driver, now: () => clock.now() };
          ctx.sleep = (ms) => clock.sleep(ms);
          if (session) ctx.lock = session.hook;
          // Author-declared attribute hooks (`[resolve] attributes`, Fix 1) so a batched vision pick
          // also persists a discriminating `[data-cmd="c2"]` durable selector for warm L0 replay.
          if (services.resolveAttributes) ctx.resolveAttributes = services.resolveAttributes;
          ctx.ai = runtime.hooks;
          // Wrap the bound batch hook in an arrow (the hook is `this`-free, but referencing it bare
          // trips oxlint `unbound-method`); this is the `BatchVisionResolve` the ladder injects.
          const groupResults = await resolveVisionBatch(group, ctx, (s, c) =>
            runtime.hooks.resolveBatchL3(s, c),
          );
          group.forEach((g, i) => {
            const r = groupResults[i];
            if (r) batchResults.set(g.id, r);
          });
        }
        const preResolved = batchResults.get(step.id);
        if (preResolved) batchResults.delete(step.id); // one-shot: re-entry re-resolves fresh
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
          preResolved,
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

      // (3) after-phase assertions (validation). A dispatched/uncertain action is observable even
      // when transport reported `ok=false`; deterministic postconditions may prove the effect and
      // rescue the logical step without redispatching it.
      assertCtx.actionResult = action.actionResult;
      let afterFailed = false;
      let afterDeterministicCount = 0;
      let afterDeterministicFailed = 0;
      const mayObserve =
        action.ok || action.dispatchState === "dispatched" || action.dispatchState === "uncertain";
      if (mayObserve) {
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
        afterDeterministicCount = after.deterministicCount;
        afterDeterministicFailed = after.deterministicFailed;
      }

      const captured = await captureStepValues(driver, step, action.actionResult);
      Object.assign(state.captures, captured);
      for (const spec of capturesForStep(step)) {
        if (spec.secret === true) state.secretCaptures.add(spec.name);
      }
      const persistedCaptured = redactCapturedValues(step, captured, services.redactor);
      assertCtx.captures = state.captures;
      if (action.popup) {
        state.pages.push({
          ...(action.popup.targetId !== undefined ? { targetId: action.popup.targetId } : {}),
          ...(action.popup.type !== undefined ? { type: action.popup.type } : {}),
          ...(action.popup.opener !== undefined ? { opener: action.popup.opener } : {}),
          ...(action.popup.openerTargetId !== undefined
            ? { openerTargetId: action.popup.openerTargetId }
            : {}),
          ...(action.popup.url !== undefined ? { url: action.popup.url } : {}),
          ...(action.popup.title !== undefined ? { title: action.popup.title } : {}),
          role: "popup",
        });
      }

      const rescuePassed =
        !action.ok &&
        (action.dispatchState === "dispatched" || action.dispatchState === "uncertain") &&
        afterDeterministicCount > 0 &&
        afterDeterministicFailed === 0;
      const transportAmbiguous = rescuePassed || action.transportAmbiguous === true;
      const criticalPossibleDispatch = action.dispatchState !== "not_dispatched";
      if (!action.ok && !rescuePassed) {
        if (step.effect === "at_most_once" && criticalPossibleDispatch) {
          state.inconclusiveReason =
            `step ${step.id} may have dispatched an at-most-once effect but deterministic ` +
            "postconditions did not confirm it; no redispatch was attempted";
          state.aborted = true;
        } else {
          state.verdictFailed = true;
          if (state.failedStep === null) state.failedStep = step.id;
        }
      }

      // (3.5) opt-in per-step screenshot frame (video recording on), honoring `redact_media`.
      await maybePersistScreenshot(driver, step, services, stepSpan);

      const stepOk = (action.ok || rescuePassed) && !afterFailed;
      const durationMs = clock.now() - stepStart;

      // (3.6) Credit the lock write-back + heal accounting — GATED on the FULL step outcome.
      // recordResolution learns/re-ranks/heals the per-step portfolio; crediting it on bare action
      // success (as before this fix) let a WRONG-but-clickable selector earn a green and climb the
      // portfolio when the step's assertions then FAILED, so the next warm run replayed the wrong
      // pick (measured admin-crud regression). We now invoke the deferred `creditResolution` ONLY
      // when `stepOk` — action ok AND no failing after-assertion. A step with NO after-assertions
      // has `afterFailed === false`, so `stepOk === action.ok` and it credits on action success
      // exactly as before (behavior-identical for the passing / no-assertion case; a clean L0 warm
      // pass stays byte-stable because the write-back still runs on a pass). Heal/drift accounting
      // is derived from the credit result here (moved from before the assertions) so a heal is only
      // counted + persisted when the healed selector actually produced a passing step; under
      // `--frozen` a credited drift still fails the run via `rec.fail`.
      //
      // Fix 3 — NEVER persist a recipe keyed to a synthetic `:repair:` step id. A planner-injected
      // repair step (`<step>:repair:<n>.<i>`) is a throwaway, proposed action (it may be a `do=fill`
      // on an unrelated status indicator); crediting its resolution poisons the lock with a junk
      // recipe that a warm run then replays and fails on. It resolved+acted (so the recovery continues
      // in memory), but its recipe is deliberately DROPPED — only genuine flow steps earn a recipe.
      let healed = false;
      if (stepOk && action.creditResolution && !isSyntheticRepairStepId(step.id)) {
        const rec = action.creditResolution();
        healed = rec.healed;
        if (rec.healed) {
          state.healedSteps.push(step.id);
          if (rec.fail) {
            state.verdictFailed = true;
            if (state.failedStep === null) state.failedStep = step.id;
          }
        }
      }

      // `on_fail` recovery: a step that would FAIL THE RUN (a failed action, or a failing
      // after-assertion under fail_on_assertion) can jump instead of failing. A hard infra error
      // (state.runError) is NEVER recoverable — it always aborts with verdict `error`.
      const wouldFailRun = !stepOk || (afterFailed && assertCtx.failOnAssertion);
      const jump =
        wouldFailRun && !state.runError && !state.inconclusiveReason ? tryOnFail(action) : null;

      await emitStepEnd(writers, step.id, stepOk, durationMs, {
        healed,
        ...(action.tier ? { tier: action.tier } : {}),
        ...(action.error ? { error: action.error } : {}),
        ...(action.dispatchState !== undefined ? { dispatchState: action.dispatchState } : {}),
        ...(action.retrySafe !== undefined ? { retrySafe: action.retrySafe } : {}),
        ...(action.matchedConditions !== undefined
          ? { matchedConditions: action.matchedConditions }
          : {}),
        ...(action.attempts !== undefined ? { attempts: action.attempts } : {}),
        ...(action.retryDecisionReason !== undefined
          ? { retryDecisionReason: action.retryDecisionReason }
          : {}),
        ...(action.retryReason !== undefined ? { retryReason: action.retryReason } : {}),
        ...(action.receipt !== undefined ? { receipt: action.receipt } : {}),
        ...(action.effect !== undefined ? { effect: action.effect } : { effect: step.effect }),
        ...(action.anchor !== undefined
          ? { anchor: action.anchor }
          : {
              anchor: step.anchor ?? ("target" in step ? describeTarget(step.target) : undefined),
            }),
        ...(transportAmbiguous ? { transportAmbiguous: true } : {}),
        ...(Object.keys(persistedCaptured).length > 0 ? { captures: persistedCaptured } : {}),
        ...(action.popup ? { popup: action.popup } : {}),
        ...(action.webmcp ? { webmcp: action.webmcp } : {}),
      });
      recordStepSummary(state, step, stepOk, action.tier, action.error, healed, {
        ...action,
        ...(transportAmbiguous ? { transportAmbiguous: true } : {}),
        ...(Object.keys(persistedCaptured).length > 0 ? { captures: persistedCaptured } : {}),
      });
      endStep(stepOk, durationMs, healed, action.tier);

      if (jump !== null) {
        // Recovered: state already rolled back in tryOnFail(). Redirect and keep going.
        cursor = jump;
        continue;
      }

      // (3.75) L4 `intent_changed` → planner (PLAN_v003 v003-6, SECOND trigger, additive). When a
      // step FAILS and the advisor classified it `intent_changed` (the step no longer matches the
      // app), the planner may repair the path in place. On a successful repair we RECOVER like an
      // `on_fail` jump: roll back the failure-bearing state, splice the repair steps after this step,
      // and redirect the cursor to the first one. `on_fail` (above) still takes precedence.
      if (
        wouldFailRun &&
        !state.runError &&
        !transportAmbiguous &&
        step.effect !== "at_most_once" &&
        stepsAttempted <= steps.length + 1 && // guard is soft; max_steps is the real backstop
        runtime &&
        services.plan.enabled &&
        action.advisory?.kind === "intent_changed" &&
        !repairedDivergences.has(step.id)
      ) {
        const ctx: ResolveContext = { driver, now: () => clock.now() };
        ctx.sleep = (ms) => clock.sleep(ms);
        if (session) ctx.lock = session.hook;
        if (services.cache) ctx.cache = services.cache;
        const currentUrl = await driver.currentUrl().catch(() => "");
        const recovered = await runRepairAndSplice(
          steps,
          cursor,
          { nextStep: step, currentUrl },
          ctx,
          runtime,
          services,
          recent,
          repairedDivergences,
          state,
        );
        if (recovered) {
          rebuildJumpTable(idToIndex, steps); // splice invalidated the jump table
          // Roll back this step's failure so the recovery path (the spliced steps) is in control.
          restoreState(state, preStep);
          cursor += 1; // the first spliced repair step now sits at cursor+1.
          continue;
        }
      }

      // Abort policy:
      //   - EAGER: stop at the first step that fails the verdict (failed action, or a failed
      //     after-assertion when fail_on_assertion). This is the fail-fast path.
      //   - DEFERRED: keep going; collect every failure and fail at the end.
      //   - A hard infra error (state.runError) ALWAYS aborts regardless of mode.
      if (
        assertCtx.mode === "eager" &&
        (!action.ok || (afterFailed && assertCtx.failOnAssertion))
      ) {
        state.aborted = true;
      }
      if (state.runError) state.aborted = true;

      // Record this step in the planner's recent-action history (redaction-safe: ids + verbs only,
      // never a fill value). Kept bounded so the volatile suffix stays small.
      recordRecentAction(recent, step, stepOk);

      // (4) L5 PATH REPAIR (PLAN_v003 v003-6). ENABLED-BY-DEFAULT, but inert unless BOTH an AI
      // runtime is present AND `[plan].enabled`. After a SUCCESSFUL navigating/mutating step, check
      // whether the NEXT recorded step's page expectation still holds; on a divergence run the
      // bounded cheap→escalate planner and SPLICE the repair steps into the stream (mirrors the
      // `on_fail` cursor redirect). Kept inside this `try` so a planner `BudgetExceededError`
      // (`max_replans` / `max_model_calls` / `max_cost_usd`) maps to `inconclusive` via the handler
      // below. A no-AI-runtime run never enters here → byte-identical to before.
      if (
        !state.aborted &&
        stepOk &&
        runtime &&
        services.plan.enabled &&
        isPathMutatingStep(step)
      ) {
        const spliced = await maybeRepairPath(
          steps,
          cursor,
          driver,
          session,
          clock,
          runtime,
          services,
          recent,
          repairedDivergences,
          state,
        );
        if (spliced) rebuildJumpTable(idToIndex, steps); // splice invalidated the jump table
      }

      cursor += 1;
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
          ...(step.effect !== undefined ? { effect: step.effect } : {}),
          ...(step.anchor !== undefined
            ? { anchor: step.anchor }
            : "target" in step && describeTarget(step.target)
              ? { anchor: describeTarget(step.target) }
              : {}),
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

/**
 * Rebuild the step-id → index jump table after a path-repair splice mutated `steps` (PLAN_v003
 * v003-6). First-seen wins (mirrors the initial build) so an `on_fail.goto` still resolves. Called
 * only after a splice — the common (no-repair) path never touches the table.
 */
function rebuildJumpTable(idToIndex: Map<string, number>, steps: Step[]): void {
  idToIndex.clear();
  steps.forEach((s, i) => {
    if (!idToIndex.has(s.id)) idToIndex.set(s.id, i);
  });
}

/** Max recent actions kept for the planner's history block (bounded → the volatile suffix stays small). */
const RECENT_ACTION_WINDOW = 8;

/**
 * Push a step's outcome onto the planner's recent-action history (PLAN_v003 v003-6). Redaction-safe:
 * only the id + verb + a short NL intent (never a fill VALUE) are recorded. Bounded to the last
 * {@link RECENT_ACTION_WINDOW} actions.
 */
function recordRecentAction(recent: RecentAction[], step: Step, ok: boolean): void {
  const intent = "target" in step ? describeTarget(step.target) : undefined;
  recent.push({ id: step.id, do: step.do, ok, ...(intent ? { intent } : {}) });
  if (recent.length > RECENT_ACTION_WINDOW) recent.splice(0, recent.length - RECENT_ACTION_WINDOW);
}

/**
 * L5 path repair (PLAN_v003 v003-6): after a successful navigating/mutating step at `cursor`, detect
 * whether the NEXT recorded step diverges and, if so, run the bounded cheap→escalate planner and
 * SPLICE the validated repair steps into `steps` right after `cursor`. Returns `true` when steps
 * were inserted (so the caller rebuilds the jump table). The caller guards on runtime + `[plan]
 * .enabled`. Budget errors (`max_replans` via `noteReplan`, or a planner-call ceiling) PROPAGATE so
 * the runner maps them to `inconclusive`.
 */
async function maybeRepairPath(
  steps: Step[],
  cursor: number,
  driver: Driver,
  session: LockSession | undefined,
  clock: RunClock,
  runtime: AiRuntime,
  services: RunServices,
  recent: RecentAction[],
  repairedDivergences: Set<string>,
  state: RunState,
): Promise<boolean> {
  const nextStep = steps[cursor + 1];
  if (!nextStep) return false; // nothing after this step to diverge from.
  // Only replan ONCE per diverged step id per pass (avoid re-detecting the same divergence).
  if (repairedDivergences.has(nextStep.id)) return false;

  const ctx: ResolveContext = { driver, now: () => clock.now() };
  ctx.sleep = (ms) => clock.sleep(ms);
  if (session) ctx.lock = session.hook;
  if (services.cache) ctx.cache = services.cache;

  const divergence = await detectDivergence(driver, nextStep, session, ctx, services.cache);
  if (!divergence) return false;

  return runRepairAndSplice(
    steps,
    cursor,
    divergence,
    ctx,
    runtime,
    services,
    recent,
    repairedDivergences,
    state,
  );
}

/**
 * Charge the run-level replan budget, run the bounded planner loop, and splice its repair steps into
 * `steps` after `cursor`. Shared by the divergence trigger and the L4 `intent_changed` trigger.
 * `noteReplan()` is charged BEFORE any planner call so `max_replans` fail-fasts to `inconclusive`.
 * Returns `true` when repair steps were inserted.
 */
async function runRepairAndSplice(
  steps: Step[],
  cursor: number,
  divergence: Divergence,
  ctx: ResolveContext,
  runtime: AiRuntime,
  services: RunServices,
  recent: RecentAction[],
  repairedDivergences: Set<string>,
  state: RunState,
): Promise<boolean> {
  // Mark handled up-front so a give_up (or a mid-loop budget throw) does not re-trigger this pass.
  repairedDivergences.add(divergence.nextStep.id);
  // Run-level hard stop. Throws BudgetExceededError('max_replans') → the runner maps it to
  // `inconclusive` (checked BEFORE spending any planner call, and NEVER swallowed below).
  runtime.budget.noteReplan();

  let repair: Awaited<ReturnType<typeof runPathRepair>>;
  try {
    repair = await runPathRepair({
      runtime,
      goal: services.plan.goal,
      divergence,
      ctx,
      recent: [...recent],
      ...(services.plan.escalateConfidence !== undefined
        ? { escalateConfidence: services.plan.escalateConfidence }
        : {}),
      ...(services.plan.escalateAttempts !== undefined
        ? { escalateAttempts: services.plan.escalateAttempts }
        : {}),
    });
  } catch (err) {
    // A budget ceiling (`max_model_calls` / `max_cost_usd`) MUST propagate → `inconclusive`.
    if (isBudgetExceeded(err)) throw err;
    // ANY OTHER planner failure (a malformed model response, a driver hiccup while gathering the
    // page) is BEST-EFFORT recovery — it must NEVER turn a failed/passed run into an `error`. Degrade
    // to "no repair": the diverged/failed step stays as it was.
    return false;
  }

  if (repair.decision !== "repaired" || repair.steps.length === 0) return false;

  // Splice the validated, id-namespaced repair steps into the stream right after `cursor` so the
  // loop executes them next through the NORMAL ladder (they count against `max_steps`).
  steps.splice(cursor + 1, 0, ...repair.steps);
  state.replanCount += 1;
  for (const s of repair.steps) state.repairedSteps.push(s.id);
  return true;
}

/** Emit a step_end event. `healed` is set when the step's recipe drifted + self-healed (P3). */
function emitStepEnd(
  writers: ArtifactWriters,
  stepId: string,
  ok: boolean,
  durationMs: number,
  extra: {
    healed: boolean;
    tier?: LadderTier;
    error?: string;
    dispatchState?: DispatchState;
    retrySafe?: boolean;
    matchedConditions?: MatchedCondition[];
    attempts?: number;
    retryDecisionReason?: string;
    retryReason?: string;
    receipt?: ActionReceipt;
    transportAmbiguous?: boolean;
    captures?: Record<string, string>;
    webmcp?: WebMcpEvidence;
    popup?: NewPageResult;
    effect?: "observe" | "idempotent" | "at_most_once";
    anchor?: string;
  },
): Promise<void> {
  const payload: Parameters<ArtifactWriters["run"]["emitStepEnd"]>[0] = {
    stepId,
    ok,
    healed: extra.healed,
    durationMs,
  };
  if (extra.tier) payload.tier = extra.tier;
  if (extra.error) payload.error = extra.error;
  if (extra.dispatchState !== undefined) payload.dispatchState = extra.dispatchState;
  if (extra.retrySafe !== undefined) payload.retrySafe = extra.retrySafe;
  if (extra.matchedConditions !== undefined) payload.matchedConditions = extra.matchedConditions;
  if (extra.attempts !== undefined) payload.attempts = extra.attempts;
  if (extra.retryDecisionReason !== undefined)
    payload.retryDecisionReason = extra.retryDecisionReason;
  if (extra.retryReason !== undefined) payload.retryReason = extra.retryReason;
  if (extra.receipt !== undefined) payload.receipt = extra.receipt;
  if (extra.transportAmbiguous !== undefined) payload.transportAmbiguous = extra.transportAmbiguous;
  if (extra.captures !== undefined) payload.captures = extra.captures;
  if (extra.webmcp !== undefined) payload.webmcp = extra.webmcp;
  if (extra.popup !== undefined) payload.popup = extra.popup;
  if (extra.effect !== undefined) payload.effect = extra.effect;
  if (extra.anchor !== undefined) payload.anchor = extra.anchor;
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
  metadata?: StepActionOutcome,
): void {
  const row: StepSummary = { stepId: step.id, do: step.do, ok, healed, durationMs: 0 };
  if (metadata?.effect !== undefined) row.effect = metadata.effect;
  else if (step.effect !== undefined) row.effect = step.effect;
  if (metadata?.anchor !== undefined) row.anchor = metadata.anchor;
  else if ("target" in step) row.anchor = describeTarget(step.target);
  if (tier) row.tier = tier;
  if (error) row.error = error;
  if (metadata?.dispatchState !== undefined) row.dispatchState = metadata.dispatchState;
  if (metadata?.retrySafe !== undefined) row.retrySafe = metadata.retrySafe;
  if (metadata?.matchedConditions !== undefined) row.matchedConditions = metadata.matchedConditions;
  if (metadata?.attempts !== undefined) row.attempts = metadata.attempts;
  if (metadata?.retryDecisionReason !== undefined)
    row.retryDecisionReason = metadata.retryDecisionReason;
  if (metadata?.retryReason !== undefined) row.retryReason = metadata.retryReason;
  if (metadata?.receipt !== undefined) row.receipt = metadata.receipt;
  if (metadata?.transportAmbiguous !== undefined)
    row.transportAmbiguous = metadata.transportAmbiguous;
  if (metadata?.captures !== undefined) row.captures = metadata.captures;
  if (metadata?.webmcp !== undefined) row.webmcp = metadata.webmcp;
  if (metadata?.popup !== undefined) row.popup = metadata.popup;
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
  if (state.budgetExceeded || state.inconclusiveReason) return "inconclusive";
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
  // Hooks flatten their own `run` steps too (a setup/teardown module may compose flows).
  const loaded = await loadFlowFileFlattened(resolvedPath, { env });
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
    // Redact an AI-emitted note before persisting it to the hook module's lock (DESIGN §4).
    redactNote: (note: string) => services.redactor.redactText(note),
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
  const env = opts.env ?? process.env;
  const artifactClock: ArtifactClock = () => clock.now();

  // --- (1) load + import-resolve + template ---
  // Load with `run` steps flattened into namespaced child steps (PLAN_v002 v002-8) — the
  // runner always executes against the final concrete step list.
  const loaded = await loadFlowFileFlattened(opts.flowPath, { env });
  // Resolve the import graph (root node carries this flow's resolved inputs).
  const graph = await resolveImports(loaded, { env });
  const rootNode = graph.nodes.get(graph.rootPath);
  const inputs = rootNode?.inputs ?? resolveInputs(loaded.flow.inputs, undefined, env, {});
  const { steps: allSteps } = templateFlow(loaded.flow, inputs, env);

  // Resume/slice support: trim to the `--from`/`--to` debugging range (both inclusive).
  const steps = trimStepRange(allSteps, opts.fromStep, opts.toStep);

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
  const onWarn = opts.onWarn ?? ((m: string) => console.error(m));
  const services: RunServices = {
    redactor,
    runSpan,
    activeSpan,
    onWarn,
    record: opts.config.browser?.record === true,
    redactMedia: opts.config.redaction.redact_media ?? true,
    screenshotsDir: runDir.screenshotsDir,
    screenshotPaths: [],
    shotIndex: { n: 0 },
    settleMs: opts.config.timeouts.settle_ms,
    ...(cacheOptionsFromConfig(opts.config.cache)
      ? { cache: cacheOptionsFromConfig(opts.config.cache) }
      : {}),
    ...(opts.config.resolve?.attributes && opts.config.resolve.attributes.length > 0
      ? { resolveAttributes: opts.config.resolve.attributes }
      : {}),
    // L5 path-repair planner policy (PLAN_v003 v003-6). `enabled` defaults FALSE via the resolved
    // config (opt-in); the goal defaults to the flow `description` when `[flow].goal` is unset.
    plan: {
      enabled: opts.config.plan.enabled,
      goal: resolveFlowGoal(loaded.flow),
      ...(opts.config.plan.escalate_confidence !== undefined
        ? { escalateConfidence: opts.config.plan.escalate_confidence }
        : {}),
      ...(opts.config.plan.escalate_attempts !== undefined
        ? { escalateAttempts: opts.config.plan.escalate_attempts }
        : {}),
    },
    inputs,
    env,
    dialogPolicy: normalizeDialogPolicy(opts.config.browser?.dialog ?? "dismiss"),
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
  const artifactProvenance: ArtifactProvenance = {
    browserPilot: getBrowserPilotProvenance(),
  };

  // Emit run_start (config + limits summaries are compact, redaction-safe projections). Inputs are
  // masked via the redactor (secret values → REDACTED; PII when mask_text on).
  await writers.run.emitRunStart({
    runId: runDir.runId,
    flowId: loaded.flow.id,
    inputs: redactor.redactInputs(inputs),
    configSummary: configSummary(opts.config, connectCfg),
    limits: limitsSummary(opts.config),
    provenance: artifactProvenance,
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
  // Under `--frozen` the committed lock is authoritative: a malformed `*.lock.toml` is a hard
  // failure (a `LockParseError`) — we must NOT silently re-resolve fresh (which would mask a garbage
  // committed artifact with a `drift_count=0` pass). Map it to a `runError` (verdict `error`, exit 2)
  // and abort the step loop. In auto/no-write modes `openLockSession` still auto-heals + warns.
  let session: LockSession | undefined;
  try {
    session = await openLockSession({
      lockPath,
      source: loaded.path,
      sourceHash: loaded.sourceHash,
      description: loaded.flow.description,
      mode: lockMode,
      inferStrategy: selectorUsedToStrategy,
      now: () => clock.now(),
      // Redact an AI-emitted note-to-future-self BEFORE it is persisted to the lock (DESIGN §4):
      // secrets always masked, PII when `mask_text` on; identity when redaction is off.
      redactNote: (note: string) => redactor.redactText(note),
      ...(imported.length > 0 ? { imported } : {}),
      ...(stepNamespaces.size > 0
        ? { hookOptions: { namespaceFor: (step: Step) => stepNamespaces.get(step.id) } }
        : {}),
    });
  } catch (err) {
    if (err instanceof LockParseError) {
      state.runError = `malformed lock under --frozen: ${err.message}`;
      state.aborted = true;
    } else {
      throw err;
    }
  }

  // Surface import step-id collisions (H6): when two imported modules define the SAME step id, the
  // root step-namespace map binds to the graph-iteration-first module silently (see
  // buildStepNamespaceMap). This does NOT change binding — it just makes the ambiguity observable so
  // a maintainer can disambiguate (a run-time warning, per the brief). `onWarn` defaults to stderr.
  for (const c of collectImportStepCollisions(graph)) {
    onWarn(
      `flightplan: import step-id collision on "${c.stepId}": bound to "${c.boundModule}" ` +
        `(also defined by ${c.otherModules.map((m) => `"${m}"`).join(", ")}). ` +
        `A root reference to "${c.stepId}" resolves against "${c.boundModule}"; ` +
        `rename the step or reference it via its module namespace to disambiguate.`,
    );
  }

  // --- (3) build the driver (factory) then connect; teardown ALWAYS in finally ---
  // An injected `driverFactory` (tests) keeps the pure `(connectCfg) => Driver` seam; the default
  // production factory additionally receives the resolved `[timeouts]` (so an author's action_ms/
  // nav_ms override reaches BrowserPilotDriver instead of its own 5000/2000 fallback defaults) and
  // the author-declared `[resolve] attributes` (extra selector-hook attribute names like data-cmd).
  // A frozen source-hash failure is already terminal. Do not even invoke the driver factory in
  // that case: validation must complete before any browser-facing setup or connection.
  const driver = state.aborted
    ? ({} as Driver)
    : opts.driverFactory
      ? opts.driverFactory(connectCfg)
      : defaultDriverFactory(
          connectCfg,
          opts.config.timeouts,
          opts.config.resolve?.attributes,
          opts.config.browser?.dialog,
        );
  const assertCtx = buildAssertContext(driver, opts.config, clock, runtime);

  // The produced video path (opt-in `[browser] record`), collected in the finally before teardown.
  let videoPath: string | null = null;

  try {
    if (!state.aborted) await driver.connect(connectCfg);
    // --- (3.1) apply [config.auth] (Cloudflare Access wiring) BEFORE the setup hook / first goto ---
    // Feature-detected: a driver built against a browser-pilot release predating
    // `setExtraHTTPHeaders`/`mintCfAccessJwt` simply skips this (no `[config.auth]` support). An
    // unset `*_env` name or a rejected mint throws, which is caught below and folded into
    // `state.runError` (verdict `error`, matching connect()'s own failure handling) — auth must be
    // in place, or the run must fail, before any navigation.
    if (!state.aborted && opts.config.auth && driver.applyAuth) {
      await driver.applyAuth(opts.config.auth, env);
    }
    if (!state.aborted && driver.pageState) {
      try {
        const initialPage = await driver.pageState();
        if (initialPage.activeTargetId !== undefined) {
          state.pages.push({ targetId: initialPage.activeTargetId, role: "active" });
        }
      } catch {
        // Page identity is observability only; an unavailable probe must not fail the run.
      }
    }

    // --- (3.5) start opt-in recording (video / per-step frames) into the run's screenshots dir ---
    // Gated on `[browser] record` (default off). Feature-detected — a driver without recording (or
    // a record-off run) never calls it and behaves exactly as before. Never throws into the run.
    if (!state.aborted && services.record && driver.startRecording) {
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
    if (!state.runError && !state.inconclusiveReason && !state.verdictFailed && session) {
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
    if (loaded.flow.teardown && !state.aborted) {
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
    if (!state.aborted && services.record && driver.stopRecording) {
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
      if (driver.teardown) await driver.teardown();
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
    artifactProvenance,
    services.redactor,
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
  const provider = opts.config.ai?.provider ?? "openrouter";
  const generate =
    provider === "google"
      ? createGoogleGenerate({ apiKey })
      : provider === "openai"
        ? createOpenAiGenerate({ apiKey })
        : createOpenRouterGenerate({ apiKey });
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

/** A single import step-id collision: a step id defined by more than one imported module. */
interface ImportStepCollision {
  /** The colliding step id (e.g. `submit`). */
  stepId: string;
  /** The module (flow id) a root reference actually binds to (graph-iteration-first — see
   * {@link buildStepNamespaceMap}). */
  boundModule: string;
  /** The other module(s) that also define this step id (whose definitions are shadowed). */
  otherModules: string[];
}

/**
 * Detect import step-id collisions (H6): step ids defined by MORE THAN ONE imported module. Mirrors
 * {@link buildStepNamespaceMap}'s iteration so the reported `boundModule` is exactly the module a
 * root reference binds to (first-registered wins) — the shadowing is silent otherwise. Reporting
 * only; binding behavior is unchanged. Empty when there are no imports or no collisions.
 */
function collectImportStepCollisions(graph: ImportGraph): ImportStepCollision[] {
  const byStep = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    if (node.path === graph.rootPath || node.relation !== "import") continue;
    const moduleId = node.loaded.flow.id;
    for (const step of node.loaded.flow.steps) {
      const mods = byStep.get(step.id);
      // Only record each module ONCE per step id (a module repeating an id is a separate concern).
      if (mods) {
        if (!mods.includes(moduleId)) mods.push(moduleId);
      } else {
        byStep.set(step.id, [moduleId]);
      }
    }
  }
  const collisions: ImportStepCollision[] = [];
  for (const [stepId, mods] of byStep) {
    if (mods.length > 1) {
      collisions.push({ stepId, boundModule: mods[0]!, otherModules: mods.slice(1) });
    }
  }
  return collisions;
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
      // Fix 3 — a synthetic `:repair:` step never earns a persisted heal recipe either (its id is a
      // throwaway; a warm run would never look it up). Its `intent_changed` patch is still emitted
      // below (a human-readable diagnosis is harmless), but no lock write is keyed to a repair id.
      if (
        adv.verdict.kind === "heal" &&
        adv.signatureBasis &&
        session &&
        !isSyntheticRepairStepId(adv.step.id)
      ) {
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

/**
 * The production driver factory (a fresh BrowserPilotDriver). Threads the resolved `[timeouts]`
 * ceilings so an author's `action_ms`/`nav_ms` override reaches the driver instead of silently
 * falling back to the driver's own 5000/2000 DEFAULTS, plus the author-declared `[resolve]
 * attributes` (extra selector-hook attribute names like `data-cmd`) so the deterministic resolver
 * surfaces + ranks them, plus the resolved `[browser] dialog` policy so a flow's native-dialog
 * choice reaches the driver instead of its own `"dismiss"` fallback. Each arg is optional and
 * additive — an absent `[timeouts]`/`[resolve]`/`[browser] dialog` leaves the driver's own defaults
 * untouched. `connectCfg` is unused here (the driver receives it via `connect()`), but kept in the
 * signature so this matches the `DriverFactory` seam.
 */
export function defaultDriverFactory(
  _cfg: ConnectConfig,
  timeouts?: { action_ms: number; nav_ms: number },
  resolveAttributes?: readonly string[],
  dialog?: DialogPolicy,
): Driver {
  return new BrowserPilotDriver({
    ...(timeouts ? { actionTimeoutMs: timeouts.action_ms, navTimeoutMs: timeouts.nav_ms } : {}),
    ...(resolveAttributes && resolveAttributes.length > 0 ? { resolveAttributes } : {}),
    ...(dialog ? { dialogPolicy: dialog } : {}),
  });
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

/**
 * Slice the (already-flattened, namespaced) step list to the `--from`/`--to` debugging range
 * (PLAN_v002 v002-7). Both ends are INCLUSIVE — `toStep` still runs, then execution stops before
 * the next step. Either flag may be used alone; combined, `fromStep` must resolve to an index at
 * or before `toStep`'s (equal ids/indices are a valid 1-step slice).
 *
 * Unlike {@link trimFromStep}'s legacy silent-fallback-to-all-steps behavior (kept as-is for
 * back-compat — it has no error path today), this helper throws on an unknown `--to` id, and on
 * an unknown `--from` id when `--to` is also given, since a silent full-flow fallback would
 * defeat the point of a debugging slice. `runFlow` calls this instead of `trimFromStep` whenever
 * `toStep` is set.
 */
export function trimStepRange(
  steps: Step[],
  fromStep: string | undefined,
  toStep: string | undefined,
): Step[] {
  if (!fromStep && !toStep) return steps;

  let fromIdx = 0;
  if (fromStep) {
    fromIdx = steps.findIndex((s) => s.id === fromStep);
    if (fromIdx < 0) {
      throw new Error(`--from: no step with id "${fromStep}" in the flattened step list`);
    }
  }

  let toIdx = steps.length - 1;
  if (toStep) {
    toIdx = steps.findIndex((s) => s.id === toStep);
    if (toIdx < 0) {
      throw new Error(`--to: no step with id "${toStep}" in the flattened step list`);
    }
  }

  if (fromIdx > toIdx) {
    throw new Error(
      `--from "${fromStep}" (step ${fromIdx + 1}) comes after --to "${toStep}" ` +
        `(step ${toIdx + 1}) in the flow — the range is empty. Swap them or drop one flag.`,
    );
  }

  return steps.slice(fromIdx, toIdx + 1);
}

/**
 * The durable flow GOAL for the L5 path-repair planner (PLAN_v003 v003-6). Uses `[flow].goal` when
 * the author set it, else defaults to the flow `description` (both are always present — description
 * is a required header field). Load-bearing for non-local repairs and the prompt-cache key.
 */
export function resolveFlowGoal(flow: FlowFile): string {
  return flow.goal ?? flow.description;
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
  provenance: ArtifactProvenance,
  redactor: Redactor,
): RunSummary {
  const captures = Object.fromEntries(
    Object.entries(state.captures).map(([name, value]) => [
      name,
      state.secretCaptures.has(name) ? REDACTED : redactor.redactValue(value),
    ]),
  );
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
    replan_count: state.replanCount,
    repaired_steps: [...state.repairedSteps],
    provenance,
    ...(Object.keys(captures).length > 0 ? { captures } : {}),
    ...(state.pages.length > 0 ? { pages: [...state.pages] } : {}),
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
