// Flightplan — the ladder orchestrator.
//
// `resolveStep(step, ctx)` walks the cost ladder for ONE (post-templating) flow step and returns
// a `LadderResult` = { the final `StepExecution`, the ordered per-tier `ResolutionAttempt[]` }.
// The runner emits the attempts as `resolution_attempt` trace events — the orchestrator RETURNS
// the data and never writes artifacts itself (PLAN.md §5 Phase 2 / §7 explain UX).
//
// Phase-2 walk (PLAN.md §2 mermaid (b)):
//   L0 (stub → miss) → L1. If L1 escalates: call the L2 hook if present (Phase 4 provides it),
//   then L3, then L4 — each only if the prior escalated AND the hook exists. With NO AI hooks
//   (the Phase-2 default), return the failed L1 `StepExecution` with `escalate:true` and the
//   `L2Handoff` attached, so the runner can surface the handoff / fail the step.
//
// EXTENSION POINT: the AI tiers are reached ONLY through `ctx.ai?.{resolveL2,resolveL3,
// classifyL4}` (see `AiHooks` in `types.ts`). This file imports NOTHING from `ai/`. Phase 4
// wires the AI tiers in by supplying `ctx.ai` — no change to this file's core is needed.

import { cssOnlyTarget, normalizeTarget } from "../flow/normalize-target.ts";
import type { Step } from "../flow/types.ts";
import { dispatchResolved, mayHaveDispatched } from "./dispatch.ts";
import { resolveL0 } from "./l0.ts";
import { actionVerbForStep, buildBatchStep, type L1Options, resolveL1 } from "./l1.ts";
import { attemptRepair, type RepairOptions } from "./repair.ts";
import type {
  AiHooks,
  Ladder,
  LadderResult,
  ResolutionAttempt,
  ResolveContext,
  StepExecution,
} from "./types.ts";

/** Options threaded into the orchestrator (L1 tunables + auto-repair bounds). */
export interface OrchestratorOptions {
  l1?: L1Options;
  /** Auto-repair bounds (covered/disabled/missing). Defaulted inside `repair.ts` when omitted. */
  repair?: RepairOptions;
  /**
   * Which tier `resolveStep` starts at (CLI `--start-tier`). Defaults to `"L0"` (the normal
   * L0→L1→…→L4 ladder — omitting this option is byte-identical to before). `"L3"` is the
   * "AI-only baseline" mode: L0 (lock replay) and L1 (deterministic DOM heuristics) are SKIPPED
   * entirely — no attempts are recorded for them — and resolution starts directly at L3 (vision:
   * screenshot + AI locates the element), still falling through to the L4 advisor if L3
   * escalates. This is a fair-comparison baseline against the tiered resolver, NOT a crippled
   * mode: the same driver, fixtures, and assertion/repair machinery are available: L3 itself
   * still gets a full snapshot + ranked candidates + acts via the normal driver actions.
   */
  startTier?: "L0" | "L3";
}

/** Record one tier attempt from a `StepExecution`. */
function attemptOf(exec: StepExecution, durationMs: number): ResolutionAttempt {
  const a: ResolutionAttempt = {
    tier: exec.tier,
    ok: exec.ok,
    escalated: exec.escalate,
    durationMs,
  };
  if (exec.selectorUsed !== undefined) a.selectorUsed = exec.selectorUsed;
  if (exec.strategy !== undefined) a.strategy = exec.strategy;
  if (exec.failureReason !== undefined) a.failureReason = exec.failureReason;
  if (exec.dispatchState !== undefined) a.dispatchState = exec.dispatchState;
  if (exec.retrySafe !== undefined) a.retrySafe = exec.retrySafe;
  if (exec.matchedConditions !== undefined) a.matchedConditions = exec.matchedConditions;
  if (exec.attempts !== undefined) a.attempts = exec.attempts;
  if (exec.retryDecisionReason !== undefined) a.retryDecisionReason = exec.retryDecisionReason;
  if (exec.retryReason !== undefined) a.retryReason = exec.retryReason;
  if (exec.receipt !== undefined) a.receipt = exec.receipt;
  if (exec.effect !== undefined) a.effect = exec.effect;
  if (exec.anchor !== undefined) a.anchor = exec.anchor;
  if (exec.error !== undefined) a.note = exec.error;
  return a;
}

/**
 * Which AI hook (if any) handles the given prior tier's escalation.
 *
 * Pillar (c) — vision is the one capability wall (PLAN_v003 §2 (c)): when `visionHinted`
 * (`step.tier_hint === "vision"`), an L1 escalation SKIPS the L2 text tier and goes STRAIGHT to
 * L3 (vision), because text tiers can't resolve the marked target (an unlabeled icon / Nth glyph)
 * and burning them first only wastes a paid call. The free/deterministic L0+L1 tiers still run
 * ahead of this hook — a vision hint only reroutes the *AI* climb. The L3→L4 escalation is
 * unchanged for both hinted and non-hinted steps.
 */
function nextAiHook(
  ai: AiHooks | undefined,
  priorTier: StepExecution["tier"],
  visionHinted: boolean,
): keyof AiHooks | undefined {
  if (!ai) return undefined;
  // Vision-hinted: L1 → L3 directly (skip L2 text), falling back to L2 only if no L3 is wired.
  if (priorTier === "L1" && visionHinted) {
    if (ai.resolveL3) return "resolveL3";
    if (ai.resolveL2) return "resolveL2";
  }
  if (priorTier === "L1" && ai.resolveL2) return "resolveL2";
  if (priorTier === "L2" && ai.resolveL3) return "resolveL3";
  // After L3 (or an L2 with no L3), the advisor classifies.
  if ((priorTier === "L2" || priorTier === "L3") && ai.classifyL4) return "classifyL4";
  return undefined;
}

/**
 * Resolve + execute one step through the ladder. See the file header for the walk. Always
 * returns at least one attempt (L0); the final `execution` is the deepest tier reached.
 */
export async function resolveStep(
  step: Step,
  ctx: ResolveContext,
  opts: OrchestratorOptions = {},
): Promise<LadderResult> {
  const now = ctx.now ?? Date.now;
  const attempts: ResolutionAttempt[] = [];

  // --- Cross-origin frame bypass (switch_frame context) ------------------------------------
  // browser-pilot 0.2.1 can dispatch fill/click/select (and more) inside a cross-origin OOPIF
  // once `switchToFrame` has entered it, but `snapshot`/`resolveAll` throw `assertOopifUnsupported`
  // there — so the normal ladder (which ALWAYS opens with a snapshot) can never resolve a step
  // while a frame is active. `driver.currentFrame()` is the single source of truth for "are we
  // inside a switched frame right now" (set by `switchToFrame`/cleared by `switchToMain`/`goto` —
  // see `Driver.currentFrame`'s doc). When it reports an active frame AND the step is a targeting
  // verb, skip the ladder entirely: an explicit single `css:` target is dispatched straight to the
  // driver (no snapshot, no ranking, no lock write-back — mirroring how `eval`/`emit` steps are
  // ladder-exempt); anything else (a bare selector, `ref:`/`role:`/`text:`, or natural language)
  // fails clean with a message pointing at `css:`, because AI resolution cannot see into the frame
  // to pick a target for it.
  // Narrow the bypass to genuine cross-origin frames when the driver can actually tell (Item 3):
  // `isCrossOriginFrame()` is OPTIONAL and best-effort (see its doc in `driver/types.ts`) — browser-
  // pilot exposes no PUBLIC signal for this today, so `BrowserPilotDriver` always reports `undefined`
  // ("unknown") and the bypass keeps firing for EVERY framed context exactly as before (a same-origin
  // iframe therefore still loses healing/lock write-back on the real driver — a known, documented
  // limitation, not a silent one). A driver that CAN answer (e.g. `MockDriver` in tests, or a future
  // browser-pilot release) narrows the bypass to `true` (definite OOPIF); `false` (definite same-
  // origin) falls through to the normal ladder below, which snapshots/resolves/heals/locks exactly
  // as it would outside a frame.
  const crossOrigin =
    ctx.driver.currentFrame() !== null ? ctx.driver.isCrossOriginFrame?.() : undefined;
  if (ctx.driver.currentFrame() !== null && crossOrigin !== false) {
    const verb = actionVerbForStep(step);
    if (verb === "click" || verb === "fill" || verb === "select") {
      const target = "target" in step ? step.target : undefined;
      const selector = cssOnlyTarget(target);
      if (selector !== undefined) {
        // Explicit single `css:` target while framed → direct-dispatch, no snapshot, no ladder —
        // but STILL through `dispatchResolved` (Item 2) so a framed action gets the same
        // ActionReceipt/dispatch-state trace evidence as the normal ladder path, without
        // reintroducing any snapshot/ranking/lock behavior (the dispatch policy stays the default
        // `{ allowed: true }`; nothing above this call touches the driver).
        const batchStep = buildBatchStep(step, verb, [selector]);
        const dispatched = await dispatchResolved(ctx.driver, [batchStep], { onFail: "stop" });
        const stepResult = dispatched.stepResult;
        const ok =
          stepResult?.success === true &&
          stepResult.outcomeStatus !== "ambiguous" &&
          dispatched.dispatchState !== "not_dispatched";
        const exec: StepExecution = {
          ok,
          tier: "L1",
          selectorUsed: selector,
          strategy: "css",
          escalate: false,
          dispatchState: dispatched.dispatchState,
          retrySafe: dispatched.retrySafe,
          attempts: dispatched.attempts,
          ...(dispatched.retryDecisionReason !== undefined
            ? { retryDecisionReason: dispatched.retryDecisionReason }
            : {}),
          ...(dispatched.retryReason !== undefined ? { retryReason: dispatched.retryReason } : {}),
          receipt: dispatched.receipt,
          ...(ok
            ? {}
            : {
                error:
                  stepResult?.error ?? `${step.do} ${selector} failed inside the current frame`,
              }),
        };
        return { execution: exec, attempts };
      }
      // Not a single `css:` target: a target carrying at least one real selector entry
      // (`ref:`/`role:`/`text:`/bare `[attr]`/multiple selectors) still has a chance through the
      // NORMAL ladder — L1 already relaxes its iframe mis-resolution guard while `currentFrame()`
      // is set (same-origin iframes snapshot fine; a genuine cross-origin OOPIF will fail there
      // exactly as it did before this change — unchanged behavior, no new capability claimed for
      // it). Only a PURE natural-language target (no selector entries at all) is rejected up
      // front: no AI/ladder tier can see into a frame to resolve free-text intent, and letting it
      // fall through would just burn an expensive, guaranteed-to-fail climb before failing anyway.
      const hasSelectorEntry = normalizeTarget(target).selectors.length > 0;
      if (!hasSelectorEntry) {
        const exec: StepExecution = {
          ok: false,
          tier: "L1",
          escalate: false,
          error:
            `step ${step.id}: inside a frame context (after switch_frame), a natural-language-` +
            "only target cannot be resolved — AI resolution can't see into a frame. Use an " +
            "explicit `css:`-prefixed selector for this target.",
        };
        return { execution: exec, attempts };
      }
    }
  }

  // --- AI-only baseline (`--start-tier l3`): skip L0 + L1 entirely, start at L3 ------------
  // No L0/L1 `ResolutionAttempt`s are recorded (they never ran) so a baseline run's trace.jsonl
  // shows only the tiers that actually executed (L3, and L4 on an L3 escalation) — `flightplan
  // report` reads tier labels unchanged. Falls through to L4 exactly like the normal ladder.
  if (opts.startTier === "L3") {
    if (!ctx.ai?.resolveL3) {
      const exec: StepExecution = {
        ok: false,
        tier: "L1",
        escalate: true,
        error: "--start-tier l3 requires an AI runtime (resolveL3 hook); none configured",
      };
      return { execution: exec, attempts };
    }
    // A synthetic, non-recorded "prior" — L3 (`vision-l3.ts`) ignores `prior` and resolves from
    // its own fresh screenshot + snapshot, so this is purely a placeholder for the hook's shape.
    const syntheticPrior: StepExecution = { ok: false, tier: "L1", escalate: true };
    let t0 = now();
    const l3 = await ctx.ai.resolveL3(step, syntheticPrior, ctx);
    attempts.push(attemptOf(l3, now() - t0));
    if (l3.ok || !l3.escalate) return { execution: l3, attempts };

    if (ctx.ai.classifyL4) {
      t0 = now();
      const l4 = await ctx.ai.classifyL4(step, l3, ctx);
      attempts.push(attemptOf(l4, now() - t0));
      return { execution: l4, attempts };
    }
    return { execution: l3, attempts };
  }

  // ONE shared snapshot for this resolveStep: attribute-enriched so testid/label derivation and
  // the driver's native ranking see real DOM attributes. L0's pre-replay gates (lookup + url_glob
  // + sig) use it; on a clean L0 miss, L1 REUSES it (single-snapshot discipline, PLAN.md §7).
  //
  // NOTE (Item 8, investigated + intentionally NOT deferred): the attribute enrichment is NOT wasted
  // on an L0 lock hit. L0's target-identity replay plan (`buildReplayPlan` → `classifyReplaySelector`
  // → `elementMatchesParsed`) reads `element.attributes` to match a recipe's `[data-testid=…]` /
  // `[attr=val]` primary against the live snapshot; without `{ attributes: true }` those identity
  // checks would silently fail and every testid/attr recipe would drift-heal. So the enriched
  // snapshot is required BEFORE the L0 gate — deferring enrichment to the L0-miss path is unsafe.
  const sharedSnapshot = await ctx.driver.snapshot({ attributes: true });

  // --- L0 (locked-recipe validate + replay) ---
  let t0 = now();
  const l0 = await resolveL0(step, ctx, sharedSnapshot);
  attempts.push(attemptOf(l0, now() - t0));
  if (l0.ok) return { execution: l0, attempts };
  // A failed L0 replay that may have crossed the effect boundary is terminal for this logical
  // step. Do not hand it to L1/repair/AI, which would turn a transport ambiguity into a replay.
  if (mayHaveDispatched(l0.dispatchState)) return { execution: l0, attempts };

  // CRITICAL: if L0 VALIDATED then REPLAYED and the replay FAILED (`l0.replayed`), the page may
  // have mutated → L1 must take a FRESH snapshot. A clean pre-replay L0 miss did NOT act, so L1
  // REUSES the shared snapshot.
  const l1Snapshot = l0.replayed ? undefined : sharedSnapshot;
  // On a clean pre-replay L0 miss, L0 already computed the page-signature basis for this same
  // snapshot — hand it to L1 so it reuses it instead of recomputing `capturePageSignature` (Item 4).
  const l1Basis = l0.replayed ? undefined : l0.signatureBasis;

  // --- L1 (deterministic strategy race) ---
  t0 = now();
  const l1 = await resolveL1(step, ctx, opts.l1 ?? {}, l1Snapshot, l1Basis);
  attempts.push(attemptOf(l1, now() - t0));
  if (l1.ok || !l1.escalate) return { execution: l1, attempts };
  if (mayHaveDispatched(l1.dispatchState)) return { execution: l1, attempts };

  // --- Auto-repair (Unit D — Phase 5): deterministic, pre-model recovery (PLAN §5 / §7) ---
  // On an L1 escalation carrying a structured `failureReason` (covered/disabled/missing), attempt a
  // bounded, model-FREE repair and re-run L1 BEFORE the AI climb. A no-op when the failure is not
  // repairable (no `failureReason`, or an unhandled class) → `attemptRepair` returns the L1 exec
  // unchanged with zero attempts, so the no-repair path is byte-identical to before.
  let prior: StepExecution = l1;
  const rep = await attemptRepair(step, l1, ctx, opts.l1 ?? {}, opts.repair);
  if (rep.attempts.length > 0) attempts.push(...rep.attempts);
  if (rep.execution.ok || !rep.execution.escalate) {
    return { execution: rep.execution, attempts };
  }
  prior = rep.execution; // repaired-but-still-failed → feed the latest exec into the AI climb.

  // --- L2/L3/L4 (Phase 4 — reached only through ctx.ai hooks) ---
  // Bounded climb: at most L2 → L3 → L4 (3 AI tiers). A `tier_hint = "vision"` step (pillar c)
  // skips L2 on the first hop and climbs straight to L3 (see `nextAiHook`).
  const visionHinted = "tier_hint" in step && step.tier_hint === "vision";
  for (let i = 0; i < 3; i++) {
    const hookName = nextAiHook(ctx.ai, prior.tier, visionHinted);
    if (!hookName) break;
    const hook = ctx.ai![hookName]!;
    t0 = now();
    const next = await hook(step, prior, ctx);
    attempts.push(attemptOf(next, now() - t0));
    if (next.ok || !next.escalate) return { execution: next, attempts };
    if (mayHaveDispatched(next.dispatchState)) return { execution: next, attempts };
    prior = next;
  }

  // No AI hook available (Phase 2 default) or all escalated: return the deepest failed execution.
  // It carries `escalate:true` + the `L2Handoff` so the runner can surface/fail it.
  return { execution: prior, attempts };
}

// ===========================================================================
// Vision batching (PLAN_v003 §4 v003-3): resolve N same-page vision targets in ONE call
// ===========================================================================
//
// When ≥2 targets on the SAME page are routed to vision (an explicit `tier_hint = vision`, or an
// AI-only baseline where every target is a vision target), one screenshot + one vision call can
// answer all of them (measured: 1 batch for 8 icons == 8 singles at 8/8, ~79.5% cheaper). The
// orchestrator groups the batchable steps and delegates the shared call to a `BatchVisionResolve`
// callback — which is `ai/vision-l3.ts`'s `resolveBatchL3`, injected by the caller so this file
// keeps importing NOTHING from `ai/` (the extension-point invariant in the file header). The
// callback OWNS the per-target fallback: it returns one `StepExecution` per input step, in order,
// resolving any target the batch could not cleanly answer via its own single-target vision call.

/**
 * The batch-vision resolver the orchestrator delegates to. Injected by the caller (bound to
 * `ai/vision-l3.ts`'s `resolveBatchL3`), so the ladder never imports `ai/`. Contract: returns
 * exactly one `StepExecution` per input step, in the SAME order; a malformed/partial batch answer
 * is recovered per-target INSIDE the callback (never surfaced as a whole-batch failure).
 */
export type BatchVisionResolve = (steps: Step[], ctx: ResolveContext) => Promise<StepExecution[]>;

/**
 * Resolve a group of same-page steps through a SINGLE batched vision call, returning one
 * `LadderResult` per input step (same order). Each result carries a single `L3` attempt (the tier
 * the batch resolved at) so the runner emits `resolution_attempt` events exactly as for a
 * single-target L3, plus — when the batched L3 escalated AND an `classifyL4` hook exists — an L4
 * advisor attempt per still-failing target (mirroring `resolveStep`'s L3→L4 fall-through).
 *
 * A one-step group degrades to the callback's own single-target path. This function is a peer of
 * `resolveStep`, invoked by the runner when it has grouped ≥2 vision-hinted steps on one page.
 */
export async function resolveVisionBatch(
  steps: Step[],
  ctx: ResolveContext,
  batchResolve: BatchVisionResolve,
): Promise<LadderResult[]> {
  const now = ctx.now ?? Date.now;
  if (steps.length === 0) return [];

  const t0 = now();
  const execs = await batchResolve(steps, ctx);
  const dt = now() - t0;

  const results: LadderResult[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const l3 = execs[i] ?? {
      ok: false,
      tier: "L3" as const,
      escalate: true,
      error: "vision batch returned no result for this target",
    };
    const attempts: ResolutionAttempt[] = [attemptOf(l3, dt)];

    // L3 escalated → climb to the advisor exactly like `resolveStep`'s tail (if wired).
    if (!l3.ok && l3.escalate && !mayHaveDispatched(l3.dispatchState) && ctx.ai?.classifyL4) {
      const t1 = now();
      const l4 = await ctx.ai.classifyL4(step, l3, ctx);
      attempts.push(attemptOf(l4, now() - t1));
      results.push({ execution: l4, attempts });
      continue;
    }
    results.push({ execution: l3, attempts });
  }
  return results;
}

/** A `Ladder` object binding `resolveStep` to fixed options (the runner's handle). */
export function createLadder(opts: OrchestratorOptions = {}): Ladder {
  return {
    resolveStep: (step: Step, ctx: ResolveContext) => resolveStep(step, ctx, opts),
  };
}
