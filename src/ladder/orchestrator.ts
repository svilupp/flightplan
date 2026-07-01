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

import type { Step } from "../flow/types.ts";
import type {
  AiHooks,
  Ladder,
  LadderResult,
  ResolutionAttempt,
  ResolveContext,
  StepExecution,
} from "./types.ts";
import { resolveL0 } from "./l0.ts";
import { type L1Options, resolveL1 } from "./l1.ts";
import { attemptRepair, type RepairOptions } from "./repair.ts";

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
  if (exec.error !== undefined) a.note = exec.error;
  return a;
}

/** Which AI hook (if any) handles the given prior tier's escalation. */
function nextAiHook(
  ai: AiHooks | undefined,
  priorTier: StepExecution["tier"],
): keyof AiHooks | undefined {
  if (!ai) return undefined;
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
  const sharedSnapshot = await ctx.driver.snapshot({ attributes: true });

  // --- L0 (locked-recipe validate + replay) ---
  let t0 = now();
  const l0 = await resolveL0(step, ctx, sharedSnapshot);
  attempts.push(attemptOf(l0, now() - t0));
  if (l0.ok) return { execution: l0, attempts };

  // CRITICAL: if L0 VALIDATED then REPLAYED and the replay FAILED (`l0.replayed`), the page may
  // have mutated → L1 must take a FRESH snapshot. A clean pre-replay L0 miss did NOT act, so L1
  // REUSES the shared snapshot.
  const l1Snapshot = l0.replayed ? undefined : sharedSnapshot;

  // --- L1 (deterministic strategy race) ---
  t0 = now();
  const l1 = await resolveL1(step, ctx, opts.l1 ?? {}, l1Snapshot);
  attempts.push(attemptOf(l1, now() - t0));
  if (l1.ok || !l1.escalate) return { execution: l1, attempts };

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
  // Bounded climb: at most L2 → L3 → L4 (3 AI tiers).
  for (let i = 0; i < 3; i++) {
    const hookName = nextAiHook(ctx.ai, prior.tier);
    if (!hookName) break;
    const hook = ctx.ai![hookName]!;
    t0 = now();
    const next = await hook(step, prior, ctx);
    attempts.push(attemptOf(next, now() - t0));
    if (next.ok || !next.escalate) return { execution: next, attempts };
    prior = next;
  }

  // No AI hook available (Phase 2 default) or all escalated: return the deepest failed execution.
  // It carries `escalate:true` + the `L2Handoff` so the runner can surface/fail it.
  return { execution: prior, attempts };
}

/** A `Ladder` object binding `resolveStep` to fixed options (the runner's handle). */
export function createLadder(opts: OrchestratorOptions = {}): Ladder {
  return {
    resolveStep: (step: Step, ctx: ResolveContext) => resolveStep(step, ctx, opts),
  };
}
