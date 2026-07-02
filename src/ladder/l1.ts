// Flightplan — L1: the deterministic strategy ladder.
//
// L1 is free, synchronous, in-process, and carries the overwhelming majority of resolutions
// (PLAN.md §7 cost ladder). Its contract (PLAN.md §5 Phase 2):
//
//   1. Work off EXACTLY ONE snapshot per resolution attempt (cost discipline — the whole point).
//      The orchestrator hoists a single `snapshot({ attributes: true })` and threads it in; L1
//      takes its own attribute-enriched snapshot only when none is supplied (direct call, an
//      auto-repair re-run, or after an L0 replay-then-fail may have mutated the page).
//   2. RANK candidates via the driver's native `resolveAll(intent, { snapshot, action })`
//      (browser-pilot's L1 race, scored against that same snapshot — it executes nothing) and
//      pick the best target element from the snapshot by its ref.
//   3. Build the ORDERED selector-candidate array (author hints first, then the §4 strategy
//      ladder for the best element: ref → testid → role_name → label → scoped_text).
//   4. Pass that array to `driver.batch(...)` (one step) so bp tries them in order, then read
//      `StepResult.selectorUsed` → `Strategy` (via `selectorUsedToStrategy`) to learn which won.
//   5. Compute a DURABLE selector for the lock (never `ref:eN`): if bp returned only a ref,
//      re-derive a stable selector from the matched element's role/name/etc.
//   6. Surface `failureReason`/`coveringElement` as escalation signals; set `escalate:true` when
//      L1 can't resolve OR the match is ambiguous (→ orchestrator hands off to L2 in Phase 4).

import type { BatchStep, InteractiveElement, PageSnapshot, StepResult } from "../driver/index.ts";
import { selectorUsedToStrategy } from "../driver/index.ts";
import { normalizeTarget } from "../flow/normalize-target.ts";
import type { Step } from "../flow/types.ts";
import { buildHandoff, isAmbiguous } from "./fuzzy.ts";
import { capturePageSignature } from "./page-signature.ts";
import {
  buildHintCandidates,
  buildStrategyArray,
  durableSelectorForElement,
  strategyForElement,
} from "./strategy-array.ts";
import type {
  BatchActionVerb,
  RankedCandidate,
  ResolveContext,
  StepExecution,
  StrategyCandidate,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Step → action verb
// ---------------------------------------------------------------------------

/**
 * Map a flow `Step.do` onto the batch action verb L1 drives. Only TARGETED steps reach L1
 * (`click`/`fill`/`select`/`ai_pick`); `goto`/`wait`/`press`/`assert` are not target-resolution
 * steps. `ai_pick` is treated as a `click` target for L1 (Phase 4 owns the real ai_pick flow).
 */
export function actionVerbForStep(step: Step): BatchActionVerb | undefined {
  switch (step.do) {
    case "click":
      return "click";
    case "fill":
      return "fill";
    case "select":
      return "select";
    case "ai_pick":
      return "click";
    default:
      return undefined;
  }
}

/** The NL query text used for fuzzy matching: the target list's `nl` entry, else the step id. */
function queryTextForStep(step: Step): string {
  const target = "target" in step ? step.target : undefined;
  return normalizeTarget(target).nl ?? step.id;
}

/** A step's explicit author selector entries (empty when none / not a targeting step). */
function hintsForStep(step: Step): readonly string[] {
  const target = "target" in step ? step.target : undefined;
  return normalizeTarget(target).selectors;
}

// ---------------------------------------------------------------------------
// Building the batch step
// ---------------------------------------------------------------------------

/**
 * Build the single browser-pilot `BatchStep` for the action, given the ordered selector array.
 * Carries the fill/select value where relevant. Navigation settling is the driver's default for
 * navigating verbs (PLAN.md §3), so we don't set `waitForNavigation` here. Exported so L0
 * (cache replay) builds the identical batch step it would for L1.
 */
export function buildBatchStep(
  step: Step,
  action: BatchActionVerb,
  selectors: string[],
): BatchStep {
  const base: BatchStep = { action, selector: selectors };
  if ((step.do === "fill" || step.do === "select") && "value" in step) {
    return { ...base, value: step.value };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Picking the target element
// ---------------------------------------------------------------------------

/**
 * Pick the best target element from the ranked candidates. Returns the matched element (looked
 * up from the snapshot by ref) so we can build its strategy array, or `undefined` when there is
 * no plausible interactive match (→ escalate; hints may still carry the step).
 */
function pickTarget(
  ranked: RankedCandidate[],
  elements: InteractiveElement[],
  minScore: number,
): { element: InteractiveElement; candidate: RankedCandidate } | undefined {
  const top = ranked[0];
  if (!top || top.score < minScore) return undefined;
  const element = elements.find((e) => e.ref === top.ref);
  if (!element) return undefined;
  return { element, candidate: top };
}

// ---------------------------------------------------------------------------
// Reading the result
// ---------------------------------------------------------------------------

/**
 * Given the batch's first StepResult and the ordered candidate list we sent, derive the learned
 * strategy + a DURABLE selector (never `ref:eN`).
 *
 *  - If `selectorUsed` is a durable selector → strategy = `selectorUsedToStrategy(selectorUsed)`
 *    and durableSelector = `selectorUsed`.
 *  - If `selectorUsed` is a `ref:eN` (or absent) → strategy is re-derived from the matched
 *    element and durableSelector is RE-DERIVED via `durableSelectorForElement` (this is the
 *    "bp returned only a ref → re-resolve a stable selector" path the lock relies on).
 */
function learnFromResult(
  result: StepResult,
  candidates: StrategyCandidate[],
  matchedElement: InteractiveElement | undefined,
): {
  selectorUsed?: string;
  strategy: ReturnType<typeof selectorUsedToStrategy>;
  durableSelector?: string;
} {
  const selectorUsed = result.selectorUsed;

  if (selectorUsed) {
    const mapped = selectorUsedToStrategy(selectorUsed);
    if (mapped !== null) {
      // A durable selector won outright.
      return { selectorUsed, strategy: mapped, durableSelector: selectorUsed };
    }
    // selectorUsed was a ref → not persistable. Re-derive from the matched element, or from the
    // strategy-array entry that carried the ref.
    const refEntry = candidates.find((c) => c.selector === selectorUsed);
    const el = matchedElement ?? refEntry?.element;
    if (el) {
      return {
        selectorUsed,
        strategy: strategyForElement(el),
        durableSelector: durableSelectorForElement(el),
      };
    }
    // No element to re-derive from: report the ref was used but no durable selector.
    return { selectorUsed, strategy: null, durableSelector: undefined };
  }

  // No selectorUsed reported. Fall back to the first durable candidate we sent (best effort).
  const firstDurable = candidates.find((c) => !c.selector.startsWith("ref:"));
  if (firstDurable) {
    return { strategy: firstDurable.strategy, durableSelector: firstDurable.selector };
  }
  if (matchedElement) {
    return {
      strategy: strategyForElement(matchedElement),
      durableSelector: durableSelectorForElement(matchedElement),
    };
  }
  return { strategy: null, durableSelector: undefined };
}

// ---------------------------------------------------------------------------
// The L1 resolver
// ---------------------------------------------------------------------------

/** Tunables for L1 (defaults chosen conservatively; the orchestrator passes these through). */
export interface L1Options {
  /** Minimum fuzzy score to accept a target without escalating. Default 0.4. */
  minScore?: number;
  /** Ambiguity gap threshold (top vs second). Default 0.1. */
  ambiguityGap?: number;
}

/**
 * Resolve + execute a step at L1. Returns a `StepExecution` tagged `tier:'L1'`. Works off EXACTLY
 * ONE snapshot — the shared `snapshot` the orchestrator threads in, or a fresh attribute-enriched
 * one when none is supplied. Sets `escalate:true` (with a `handoff`) when it cannot resolve OR the
 * match is ambiguous OR the action failed.
 */
export async function resolveL1(
  step: Step,
  ctx: ResolveContext,
  opts: L1Options = {},
  snapshot?: PageSnapshot,
): Promise<StepExecution> {
  const minScore = opts.minScore ?? 0.4;
  const action = actionVerbForStep(step);

  // Non-targeting step reached L1 — nothing for the strategy ladder to do; escalate cleanly.
  if (!action) {
    return {
      ok: false,
      tier: "L1",
      escalate: true,
      error: `L1 cannot resolve a non-targeting step (do=${step.do})`,
    };
  }

  const intentText = queryTextForStep(step);
  const hints = hintsForStep(step);

  // (1) ONE snapshot: reuse the orchestrator's shared attribute-enriched snapshot when provided,
  // else take a fresh one (with attributes so testid/label + native ranking see real DOM attrs).
  const snap = snapshot ?? (await ctx.driver.snapshot({ attributes: true }));
  const elements = snap.interactiveElements;

  // Capture the PRE-ACTION page-signature basis (composite match.sig + url) so a successful
  // resolution can be written back to the lock against the page it was learned on (Phase 3).
  // Computed here, before the batch acts, because a navigating action would mutate the page.
  const signatureBasis = await capturePageSignature(ctx.driver, snap, ctx.cache);

  // (2) Native ranking: the driver's `resolveAll` runs browser-pilot's L1 race against the SAME
  // snapshot and executes nothing. `minConfidence:0` returns all candidates; L1's own `minScore`
  // gate (in `pickTarget`) and `isAmbiguous` policy then decide the target/escalation.
  const ranked: RankedCandidate[] = await ctx.driver.resolveAll(intentText, {
    snapshot: snap,
    action,
    minConfidence: 0,
  });

  // (3) Build the ordered array: author hints first, then the §4 ladder for the best element.
  const hintCandidates = buildHintCandidates(hints);
  const target = pickTarget(ranked, elements, minScore);
  const derivedCandidates = target ? buildStrategyArray(target.element, action) : [];
  const allCandidates: StrategyCandidate[] = [...hintCandidates, ...derivedCandidates];

  // Nothing to try (no hints, no plausible target) → escalate with whatever ranking we have.
  if (allCandidates.length === 0) {
    return {
      ok: false,
      tier: "L1",
      candidates: ranked,
      escalate: true,
      handoff: buildHandoff({ intent: intentText, action, ranked }),
      error: "L1: no candidate selectors (no hints and no interactive target matched)",
    };
  }

  // (4) Act: one batch, ordered selectors.
  const selectors = allCandidates.map((c) => c.selector);
  const batchStep = buildBatchStep(step, action, selectors);
  const result = await ctx.driver.batch([batchStep], { onFail: "stop" });
  const stepResult = result.steps[0];

  // Defensive: a driver should always return one step for one batch step.
  if (!stepResult) {
    return {
      ok: false,
      tier: "L1",
      candidates: ranked,
      escalate: true,
      handoff: buildHandoff({ intent: intentText, action, ranked }),
      error: "L1: driver returned no step result",
    };
  }

  // (5) Learn the winning strategy + durable selector FIRST — we need it to decide ambiguity.
  const learned = learnFromResult(stepResult, allCandidates, target?.element);

  // The native `ranked` list scores candidates against the fuzzy INTENT text — it says nothing
  // about which element actually won the batch. bp's batch RACES the ordered selector array and
  // the `ref:eN` entry (prepended for same-cycle precision, see `buildStrategyArray`) typically
  // wins that race on raw speed, so `stepResult.selectorUsed` is very often `ref:eN` even when an
  // author hint (e.g. an exact testid) targets the very same element. Comparing the raw
  // `selectorUsed` string against the hint candidates therefore misses the common case. What
  // actually matters is the LEARNED strategy: a `testid` selector (`[data-testid=...]`) identifies
  // at most one element in the DOM by construction, so once we've re-derived that the winning
  // element resolves via `testid` (whether from a hint or the derived ladder), unrelated ambiguity
  // in the fuzzy intent-ranked list must not override that exact, DOM-unique match.
  const resolvedViaTestid = learned.strategy === "testid";
  const ambiguous = !resolvedViaTestid && isAmbiguous(ranked, { gap: opts.ambiguityGap ?? 0.1 });
  const succeeded = stepResult.success && stepResult.outcomeStatus !== "ambiguous";

  // (6) Decide escalation.
  if (succeeded && !ambiguous) {
    return {
      ok: true,
      tier: "L1",
      selectorUsed: learned.selectorUsed,
      strategy: learned.strategy,
      durableSelector: learned.durableSelector,
      candidates: ranked,
      escalate: false,
      signatureBasis,
    };
  }

  // Failed OR ambiguous → escalate. Attach the cheap signals + the L2 handoff.
  const exec: StepExecution = {
    ok: false,
    tier: "L1",
    selectorUsed: learned.selectorUsed,
    strategy: learned.strategy,
    durableSelector: learned.durableSelector,
    candidates: ranked,
    escalate: true,
    handoff: buildHandoff({
      intent: intentText,
      action,
      ranked,
      ...(stepResult.failureReason !== undefined
        ? { failureReason: stepResult.failureReason }
        : {}),
      ...(stepResult.coveringElement !== undefined
        ? { coveringElement: stepResult.coveringElement }
        : {}),
    }),
  };
  if (stepResult.failureReason !== undefined) exec.failureReason = stepResult.failureReason;
  if (stepResult.coveringElement !== undefined) exec.coveringElement = stepResult.coveringElement;
  if (ambiguous && stepResult.success) {
    exec.error = "L1: ambiguous match (top two candidates too close) — escalating to disambiguate";
  } else if (stepResult.error) {
    exec.error = stepResult.error;
  }
  return exec;
}
