// Flightplan — L5 path-repair: divergence detection + the bounded cheap→escalate repair loop.
//
// This is the RUNNER-LEVEL glue for the L5 planner (PLAN_v003 §4 Phase C / v003-6). The planner
// itself lives in `ai/planner-l5.ts` (SDK-free, offline-testable through the `generate` seam); this
// module owns the two things the RUNNER needs:
//
//   detectDivergence(...) — after a navigating/mutating step settles, decide whether the run has
//     DIVERGED from its recorded path: capture the post-action page signature and compare it to the
//     NEXT targeted step's recorded lock `match.sig`. Diverged = a real recorded expectation exists
//     AND the current page does not match it. Returns `null` (no divergence) when there is NO
//     recorded expectation to compare against — the planner stays INERT so a prod run never
//     false-positive-replans on a page it has simply never learned.
//
//   runPathRepair(...) — the bounded cheap→escalate loop: gather the current page, call the CHEAP
//     planner, escalate to the capable arm only on the low-confidence / repeated-replan signal,
//     validate each proposed step against the real `StepSchema`, assign synthetic namespaced ids
//     (`<divergedStepId>:repair:<n>`), and hand the repair steps back to the runner to execute
//     through the NORMAL ladder. Gives up after `PLANNER_MAX_ATTEMPTS_PER_DIVERGENCE`.
//
// ENABLED-BY-DEFAULT SAFETY (PLAN_v003 v003-6): the runner only calls into here when BOTH an AI
// runtime is present AND `[plan].enabled`. Detection additionally requires a recorded expectation,
// so a no-AI-runtime run is byte-identical to before and a prod run with no lock never replans.

import type { AiRuntime, PlannerPlan, PlannerStep, RecentAction } from "../ai/index.ts";
import {
  isBudgetExceeded,
  PLANNER_MAX_ATTEMPTS_PER_DIVERGENCE,
  shouldEscalate,
} from "../ai/index.ts";
import type { Driver } from "../driver/index.ts";
import { StepSchema } from "../flow/index.ts";
import type { Step } from "../flow/types.ts";
import type { CachedRecipe, ResolveContext } from "../ladder/index.ts";
import { capturePageSignature } from "../ladder/page-signature.ts";
import { type CacheOptions, type LockSession, signatureMatches } from "../lock/index.ts";

/**
 * The step verbs a divergence check hangs off — a successful one of these can NAVIGATE or MUTATE the
 * page, so the NEXT recorded step's expectation may no longer hold. A `goto` always navigates; a
 * `click`/`fill`/`select`/`ai_pick` may. `press`/`wait`/`assert` do not trigger a check.
 */
export function isPathMutatingStep(step: Step): boolean {
  return (
    step.do === "goto" ||
    step.do === "click" ||
    step.do === "fill" ||
    step.do === "select" ||
    step.do === "ai_pick"
  );
}

/** A detected divergence: the next recorded step whose expectation the current page fails. */
export interface Divergence {
  /** The recorded step the run diverged AT (its `match.sig` no longer matches the page). */
  nextStep: Step;
  /** The current page URL (from the post-action signature capture). */
  currentUrl: string;
}

/**
 * Look up the recorded lock recipe for `step` (the L0 cache view), returning its `match` gate when
 * present. This is the "recorded expectation" divergence compares against — no recipe / no `match`
 * ⇒ no expectation ⇒ the planner stays inert. Swallows any lookup error (best-effort — an unreadable
 * lock is treated as "no expectation", never a divergence).
 */
async function recordedRecipe(
  step: Step,
  session: LockSession | undefined,
  ctx: ResolveContext,
): Promise<CachedRecipe | undefined> {
  if (!session) return undefined;
  try {
    return (await session.hook.lookup(step, ctx)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect whether the run has diverged from its recorded path after a navigating/mutating step.
 *
 * `nextStep` is the NEXT step the runner is about to execute (the cursor's successor). Divergence
 * fires ONLY when:
 *   1. `nextStep` is a targeting step with a RECORDED expectation (a lock recipe carrying
 *      `match.sig`) — otherwise there is nothing to compare against, so we return `null` (inert);
 *   2. the current post-action page signature does NOT match that recorded `match.sig`
 *      (via `signatureMatches`, honoring the `[cache].signature` mode).
 *
 * Captures ONE fresh signature from a single snapshot (no extra round-trips beyond the driver
 * calls `capturePageSignature` already makes). Returns the {@link Divergence} on a mismatch, else
 * `null`. Never throws for a lookup/signature error — a best-effort detector must not break a run.
 *
 * PERF (Item 2): this takes a CHEAP `snapshot()` — signature capture only reads the accessibility
 * tree + URL (the structural component is a separate driver call), so the full-DOM `attributes:true`
 * enrichment the ladder needs is pure waste here. The snapshot is deliberately NOT shared with the
 * next step's `resolveStep`, which must take its OWN fresh snapshot AFTER that step's before-phase
 * assertions may have waited/polled (the page can change in between — reusing this one would resolve
 * against a stale DOM). So the two snapshots are distinct on purpose; only the wasted enrichment is
 * dropped. Only the (before-recorded) recipe expectation is compared, so semantics are unchanged.
 */
export async function detectDivergence(
  driver: Driver,
  nextStep: Step,
  session: LockSession | undefined,
  ctx: ResolveContext,
  cache?: CacheOptions,
): Promise<Divergence | null> {
  // Only a targeting step can carry a recorded page expectation worth comparing.
  if (!("target" in nextStep)) return null;

  const recipe = await recordedRecipe(nextStep, session, ctx);
  const expectedSig = recipe?.match?.sig;
  // No recorded expectation → the planner stays INERT (avoids false-positive prod replans).
  if (!expectedSig) return null;

  let current: { sig: string; url: string };
  try {
    const snapshot = await driver.snapshot();
    current = await capturePageSignature(driver, snapshot, cache);
  } catch {
    // A signature-capture failure is inconclusive — treat as "no divergence" (fail-safe).
    return null;
  }

  const mode = cache?.signature ?? "full";
  if (signatureMatches(expectedSig, current.sig, mode)) return null; // on-path — no repair needed.

  return { nextStep, currentUrl: current.url };
}

/** The outcome of one bounded path-repair loop. */
export interface PathRepairResult {
  /**
   * `"repaired"` — the planner proposed repair steps (in `steps`) the runner should splice in and
   * execute; `"give_up"` — the planner could not repair (or exhausted its attempts): the diverged
   * step fails normally.
   */
  decision: "repaired" | "give_up";
  /** The validated, id-namespaced repair steps to execute (empty on `give_up`). */
  steps: Step[];
  /** How many planner attempts (cheap + escalated) this divergence consumed. */
  attempts: number;
  /** Whether the capable (escalation-only) arm was used at any point. */
  escalated: boolean;
  /** A short human note for the trace/log. */
  reason?: string;
}

/** Options for {@link runPathRepair}. */
export interface RunPathRepairOpts {
  runtime: AiRuntime;
  /** The durable flow goal (load-bearing for non-local repairs; keyed for the prompt cache). */
  goal: string;
  /** The detected divergence (the diverged next step + current URL). */
  divergence: Divergence;
  /** The resolve context (driver + lock hook + clock) for gathering the current page. */
  ctx: ResolveContext;
  /** The recent action history handed to the planner (redaction-safe ids + verbs). */
  recent: RecentAction[];
  /** `[plan].escalate_confidence` override (defaults to the planner constant). */
  escalateConfidence?: number;
  /** `[plan].escalate_attempts` override (defaults to the planner constant). */
  escalateAttempts?: number;
}

/**
 * Run the bounded, cheap-first repair loop for one divergence (PLAN_v003 v003-6).
 *
 * Loop (≤ {@link PLANNER_MAX_ATTEMPTS_PER_DIVERGENCE} attempts):
 *   - Gather the current page (URL + ranked candidates) via the planner runtime.
 *   - Call the CHEAP `planRepair`. On the low-confidence / repeated-replan signal ({@link
 *     shouldEscalate}) RE-ISSUE the same plan on the ESCALATION-ONLY capable arm (never standing).
 *   - `decision:"repair"` with usable steps → validate each against `StepSchema`, namespace their
 *     ids (`<divergedStepId>:repair:<n>`), and return them for the runner to execute.
 *   - `decision:"give_up"` / no usable steps → try again (cheap), until the attempt ceiling.
 *
 * The RUN-LEVEL `max_replans` budget is checked by the CALLER (`budget.noteReplan()`) BEFORE this
 * loop, so a `BudgetExceededError` never originates here; a per-planner-call budget overflow
 * (`max_model_calls` / `max_cost_usd`) DOES propagate so the runner maps it to `inconclusive`.
 */
export async function runPathRepair(opts: RunPathRepairOpts): Promise<PathRepairResult> {
  const { runtime, goal, divergence, ctx, recent } = opts;
  const planner = runtime.planner;
  let escalated = false;

  for (let attempt = 1; attempt <= PLANNER_MAX_ATTEMPTS_PER_DIVERGENCE; attempt += 1) {
    // Gather the current page fresh each attempt (a prior repair may have changed it). Budget
    // errors from the underlying driver/AI calls propagate to the runner's `inconclusive` handler.
    const page = await planner.gatherPlannerPage(divergence.nextStep, ctx, recent);

    // CHEAP arm first (mandatory cheap-first).
    let result = await planner.planRepair(goal, { page });

    // ESCALATION-ONLY: re-issue on the capable arm on the low-confidence / repeated-replan signal.
    if (shouldEscalate(result.plan, attempt, opts.escalateConfidence, opts.escalateAttempts)) {
      result = await planner.planRepairEscalated(goal, { page });
      escalated = true;
    }

    const repairSteps = usableRepairSteps(result.plan, divergence.nextStep.id, attempt);
    if (result.plan.decision === "repair" && repairSteps.length > 0) {
      return {
        decision: "repaired",
        steps: repairSteps,
        attempts: attempt,
        escalated,
        ...(result.plan.reason ? { reason: result.plan.reason } : {}),
      };
    }

    // give_up (or repair with no usable steps): stop the loop if the planner explicitly gave up;
    // otherwise let the next attempt try again (bounded by the ceiling).
    if (result.plan.decision === "give_up") {
      return {
        decision: "give_up",
        steps: [],
        attempts: attempt,
        escalated,
        ...(result.plan.reason ? { reason: result.plan.reason } : {}),
      };
    }
  }

  return {
    decision: "give_up",
    steps: [],
    attempts: PLANNER_MAX_ATTEMPTS_PER_DIVERGENCE,
    escalated,
    reason: "planner exhausted attempts for this divergence",
  };
}

/**
 * Convert a plan's proposed steps into validated, id-namespaced flow {@link Step}s. Each proposed
 * step is shaped into the full step form (`id` + verb-specific fields) and validated against the
 * REAL `StepSchema` — a proposal that fails validation (missing a required field, an out-of-vocab
 * verb) is DROPPED, never executed. Ids are `<divergedStepId>:repair:<n>` so injected steps are
 * traceable and never collide with authored ids. Returns only the steps that validated.
 */
export function usableRepairSteps(
  plan: PlannerPlan,
  divergedStepId: string,
  attempt: number,
): Step[] {
  if (plan.decision !== "repair" || !plan.steps) return [];
  const out: Step[] = [];
  plan.steps.forEach((proposed, i) => {
    const shaped = shapeProposedStep(proposed, syntheticRepairStepId(divergedStepId, attempt, i));
    if (!shaped) return;
    const parsed = StepSchema.safeParse(shaped);
    if (parsed.success) out.push(parsed.data);
  });
  return out;
}

/**
 * The synthetic id scheme for a planner-injected repair step: `<divergedStepId>:repair:<attempt>.<i>`
 * (attempt = the 1-based planner attempt for this divergence; i = the 0-based step index within that
 * attempt's plan). The SINGLE source of truth for both minting these ids ({@link usableRepairSteps})
 * and recognising them ({@link isSyntheticRepairStepId}), so the two can never drift.
 */
export function syntheticRepairStepId(divergedStepId: string, attempt: number, i: number): string {
  return `${divergedStepId}:repair:${attempt}.${i}`;
}

/**
 * Is `id` a synthetic planner-injected repair step id (Fix 3)? Matches the `:repair:<int>.<int>`
 * suffix {@link syntheticRepairStepId} mints. Used by the runner to REFUSE persisting a lock recipe
 * keyed to such an id: a repair step is a throwaway, planner-proposed action (it may be a `do=fill` on
 * an unrelated element), so crediting its resolution would poison the lock with junk that a warm run
 * then replays. A genuine flow/import step id (even a namespaced `parent:child`) never ends in
 * `:repair:<int>.<int>`, so this never false-positives on an authored step.
 */
export function isSyntheticRepairStepId(id: string): boolean {
  return /:repair:\d+\.\d+$/.test(id);
}

/**
 * Shape one {@link PlannerStep} into a candidate full-step object for `StepSchema` validation.
 * Returns `undefined` when the proposal is obviously incomplete for its verb (a `goto` without a
 * `url`, a `fill`/`select` without a `value`, a `press` without a `key`, a targeting verb without a
 * `target`) — those are dropped before validation to keep the error path quiet.
 */
function shapeProposedStep(step: PlannerStep, id: string): Record<string, unknown> | undefined {
  switch (step.do) {
    case "goto":
      return step.url ? { id, do: "goto", url: step.url } : undefined;
    case "press":
      return step.key ? { id, do: "press", key: step.key } : undefined;
    case "click":
      return step.target ? { id, do: "click", target: step.target } : undefined;
    case "fill":
      return step.target && step.value !== undefined
        ? { id, do: "fill", target: step.target, value: step.value }
        : undefined;
    case "select":
      return step.target && step.value !== undefined
        ? { id, do: "select", target: step.target, value: step.value }
        : undefined;
  }
}

/** Re-export so the runner can guard planner-loop calls without importing `ai/budget.ts` directly. */
export { isBudgetExceeded };
