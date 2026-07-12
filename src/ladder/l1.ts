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
//   4. Apply ambiguity and actionability policy before dispatch; a veto returns without browser
//      input. A unique author hint, exact testid, or positional selector may clear the veto.
//   5. Pass the approved array to the shared dispatch owner, which makes the one `driver.batch(...)`
//      call; then read `StepResult.selectorUsed` → `Strategy` (via `selectorUsedToStrategy`) to
//      learn which selector won.
//   6. Compute a DURABLE selector for the lock (never `ref:eN`): if bp returned only a ref,
//      re-derive a stable selector from the matched element's role/name/etc.
//   7. Surface `failureReason`/`coveringElement` and dispatch metadata. A post-dispatch failure is
//      terminal; only a known pre-dispatch failure may escalate to another tier.

import type {
  BatchStep,
  Driver,
  InteractiveElement,
  PageSnapshot,
  StepResult,
} from "../driver/index.ts";
import { selectorUsedToStrategy } from "../driver/index.ts";
import { normalizeTarget } from "../flow/normalize-target.ts";
import type { Step } from "../flow/types.ts";
import { dispatchResolved } from "./dispatch.ts";
import { buildHandoff, isAmbiguous } from "./fuzzy.ts";
import { capturePageSignature } from "./page-signature.ts";
import { resolveSelectorToElement, snapshotMatchCount } from "./revalidate.ts";
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
  const normalizedTarget = "target" in step ? normalizeTarget(step.target) : undefined;
  const anchor = "anchor" in step && step.anchor ? step.anchor : normalizedTarget?.nl;
  const base: BatchStep = {
    action,
    selector: selectors,
    ...(step.effect !== undefined ? { effect: step.effect } : {}),
    ...(anchor !== undefined ? { anchor } : {}),
  };
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
// Iframe mis-resolution guard (failure-path only)
// ---------------------------------------------------------------------------

/**
 * Detect an author hint that exists ONLY inside a same-origin iframe the AX snapshot does not
 * pierce. browser-pilot snapshots never descend into iframes, so a testid/attribute hint whose true
 * match lives in an iframe `contentDocument` matches NOTHING in the snapshot; L1 would then fall
 * through to a weaker (name/NL) candidate and silently resolve a LOOK-ALIKE parent element, clicking
 * it and reporting ok:true (a false positive that only trips a later assert).
 *
 * This is strictly off the happy path: it feature-detects `driver.locateSelectorFrame` (absent →
 * returns `undefined`, no behaviour change) and probes ONLY a PLAIN CSS/attribute hint (leading
 * `[`; `ref:`/`role:`/`text:` are not iframe-scoped) that matched ZERO snapshot elements. It returns
 * the first such hint the driver reports as iframe-bound, or `undefined`.
 */
async function detectIframeOnlyHint(
  hints: readonly string[],
  elements: InteractiveElement[],
  driver: Driver,
): Promise<string | undefined> {
  if (typeof driver.locateSelectorFrame !== "function") return undefined;
  for (const hint of hints) {
    const sel = hint.trim();
    // Only plain CSS/attribute selectors are iframe-scoped by locateSelectorFrame.
    if (!sel.startsWith("[")) continue;
    // Probe ONLY a hint that matched NOTHING in the snapshot (count 0). Unparseable compound CSS
    // (count undefined) is left alone — we cannot prove it absent from the AX snapshot.
    if (snapshotMatchCount(sel, elements) !== 0) continue;
    if ((await driver.locateSelectorFrame(sel)) === "iframe") return sel;
  }
  return undefined;
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
// Winner correlation (for the ambiguity veto)
// ---------------------------------------------------------------------------

/** Find an author hint that is provably unique without dispatching it. */
async function uniqueAuthorHint(
  hints: readonly StrategyCandidate[],
  elements: InteractiveElement[],
  driver: Driver,
): Promise<StrategyCandidate | undefined> {
  for (const hint of hints) {
    if (resolveSelectorToElement(hint.selector, elements)) return hint;
    const count = snapshotMatchCount(hint.selector, elements);
    if (count === 1) return hint;
    // CSS/compound selectors are not identity-parseable in the AX snapshot. When the optional
    // live-DOM probe exists, a count of exactly one is enough to prove the author hint is unique.
    if (count !== 1 && driver.elementState) {
      try {
        const state = await driver.elementState(hint.selector);
        if (state.count === 1) return hint;
      } catch {
        // A failed probe is not evidence of uniqueness; keep the ambiguity veto closed.
      }
    }
  }
  return undefined;
}

function dispatchMetadataFields(result: Awaited<ReturnType<typeof dispatchResolved>>): {
  dispatchState: NonNullable<StepExecution["dispatchState"]>;
  retrySafe: boolean;
  attempts: number;
  retryDecisionReason?: string;
  retryReason?: string;
  receipt: NonNullable<StepExecution["receipt"]>;
} {
  return {
    dispatchState: result.dispatchState,
    retrySafe: result.retrySafe,
    attempts: result.attempts,
    ...(result.retryDecisionReason !== undefined
      ? { retryDecisionReason: result.retryDecisionReason }
      : {}),
    ...(result.retryReason !== undefined ? { retryReason: result.retryReason } : {}),
    receipt: result.receipt,
  };
}

function stepMetadata(step: Step): Pick<StepExecution, "effect" | "anchor"> {
  const normalizedTarget = "target" in step ? normalizeTarget(step.target) : undefined;
  const anchor = "anchor" in step && step.anchor ? step.anchor : normalizedTarget?.nl;
  return {
    ...(step.effect !== undefined ? { effect: step.effect } : {}),
    ...(anchor !== undefined ? { anchor } : {}),
  };
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
  /** Ambiguity score floor: below this, close scores are not "plausible enough" to veto. Default 0.4. */
  ambiguityFloor?: number;
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
  /**
   * The PRE-ACTION signature basis L0 already computed for this exact page/snapshot (Item 4). Passed
   * ONLY when L1 is REUSING the shared snapshot (a clean pre-replay L0 miss), so it is safe to reuse
   * verbatim instead of recomputing `capturePageSignature`. Ignored when L1 takes a fresh snapshot.
   */
  precomputedBasis?: { sig: string; url: string },
): Promise<StepExecution> {
  const minScore = opts.minScore ?? 0.4;
  const action = actionVerbForStep(step);

  // Non-targeting step reached L1 — nothing for the strategy ladder to do; escalate cleanly.
  if (!action) {
    return {
      ok: false,
      tier: "L1",
      escalate: true,
      ...stepMetadata(step),
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
  // Reuse L0's basis when it handed one down for THIS shared snapshot (Item 4): same page, same
  // snapshot, same `ctx.cache` → identical result, so recomputing it is pure waste.
  const signatureBasis =
    snapshot !== undefined && precomputedBasis !== undefined
      ? precomputedBasis
      : await capturePageSignature(ctx.driver, snap, ctx.cache);

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
      ...stepMetadata(step),
      candidates: ranked,
      escalate: true,
      handoff: buildHandoff({ intent: intentText, action, ranked }),
      error: "L1: no candidate selectors (no hints and no interactive target matched)",
    };
  }

  // IFRAME MIS-RESOLUTION GUARD (failure path only). Before acting, catch the silent trap where a
  // CSS/attribute hint matched NOTHING in the snapshot because its true match lives inside an iframe
  // (not pierced). Acting would resolve a weaker (name/NL) fallback → a look-alike parent element,
  // reporting ok:true. Fail HARD with a clear, hint-naming error instead, and do NOT escalate:
  // every AI tier picks from the same snapshot-derived candidate list, which cannot contain iframe
  // content either, so escalation only burns L2–L4 latency/cost before failing with a worse error.
  // Probed only for zero-match hints, so the happy path (hint matched, or no iframe-capable driver)
  // is untouched.
  //
  // RELAXATION: skip the guard entirely once we have SWITCHED INTO a frame (a `switch_frame` step
  // ran). While switched, browser-pilot routes the batch action into the frame root and its
  // `locateSelectorFrame` probes the frame's OWN document, so an in-frame target is legitimately
  // reachable — rejecting it would defeat the whole point of frame switching. The guard still fires
  // for the genuine "target lives in an iframe you never entered" case (`currentFrame() === null`),
  // whose error already points authors at frame switching.
  const inFrame = ctx.driver.currentFrame?.() != null;
  const iframeHint = inFrame ? undefined : await detectIframeOnlyHint(hints, elements, ctx.driver);
  if (iframeHint) {
    const base =
      `L1: target '${iframeHint}' exists only inside an iframe; iframes are not pierced` +
      " — restructure the flow or use frame switching";
    return {
      ok: false,
      tier: "L1",
      ...stepMetadata(step),
      candidates: ranked,
      escalate: false,
      error:
        target !== undefined
          ? `${base} (a weaker candidate would otherwise mis-resolve to a look-alike element)`
          : base,
    };
  }

  // Resolve ambiguity and policy BEFORE dispatch. A unique author hint, an exact testid, or an
  // explicit positional selector is enough to override an ambiguity in the natural-language
  // ranking. Otherwise the close top cluster is a hard pre-dispatch veto.
  const selectors = allCandidates.map((c) => c.selector);
  const batchStep = buildBatchStep(step, action, selectors);
  const uniqueHint = await uniqueAuthorHint(hintCandidates, elements, ctx.driver);
  const targetStrategy = target ? strategyForElement(target.element) : null;
  const ambiguous =
    isAmbiguous(ranked, {
      gap: opts.ambiguityGap ?? 0.1,
      floor: opts.ambiguityFloor ?? 0.4,
    }) &&
    uniqueHint === undefined &&
    targetStrategy !== "testid";
  if (ambiguous) {
    const veto = await dispatchResolved(
      ctx.driver,
      [batchStep],
      { onFail: "stop" },
      { allowed: false, reason: "dispatch vetoed before input: candidate ranking is ambiguous" },
    );
    return {
      ok: false,
      tier: "L1",
      ...stepMetadata(step),
      candidates: ranked,
      escalate: true,
      handoff: buildHandoff({ intent: intentText, action, ranked }),
      ...dispatchMetadataFields(veto),
      error: "L1: ambiguous candidates — dispatch vetoed before browser input",
    };
  }

  // This is the sole L1 dispatch point. All candidate resolution and policy checks above are pure
  // or observation-only; once this call happens, the result controls whether escalation is allowed.
  const dispatched = await dispatchResolved(ctx.driver, [batchStep], { onFail: "stop" });
  const stepResult = dispatched.stepResult;

  // Defensive: a driver should always return one step for one batch step.
  if (!stepResult) {
    return {
      ok: false,
      tier: "L1",
      ...stepMetadata(step),
      candidates: ranked,
      escalate: false,
      handoff: buildHandoff({ intent: intentText, action, ranked }),
      ...dispatchMetadataFields(dispatched),
      error: "L1: driver returned no step result",
    };
  }

  // Learn the winning strategy + durable selector after the one dispatch. This is observation and
  // lock evidence only; it never authorizes a second action.
  const learned = learnFromResult(stepResult, allCandidates, target?.element);

  const succeeded =
    stepResult.success &&
    stepResult.outcomeStatus !== "ambiguous" &&
    dispatched.dispatchState !== "not_dispatched";

  // A post-dispatch failure/ambiguity is terminal for the ladder. It is observation evidence, not
  // permission for L2/L3/L4, repair, or on_fail to issue another side effect.
  if (succeeded) {
    return {
      ok: true,
      tier: "L1",
      ...stepMetadata(step),
      selectorUsed: learned.selectorUsed,
      strategy: learned.strategy,
      durableSelector: learned.durableSelector,
      candidates: ranked,
      escalate: false,
      signatureBasis,
      ...dispatchMetadataFields(dispatched),
    };
  }

  const mayHaveActed = dispatched.dispatchState !== "not_dispatched";
  const exec: StepExecution = {
    ok: false,
    tier: "L1",
    ...stepMetadata(step),
    selectorUsed: learned.selectorUsed,
    strategy: learned.strategy,
    durableSelector: learned.durableSelector,
    candidates: ranked,
    escalate: !mayHaveActed,
    ...dispatchMetadataFields(dispatched),
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
  if (stepResult.outcomeStatus === "ambiguous" || mayHaveActed) {
    exec.error =
      stepResult.error ??
      "L1: action result is post-dispatch/uncertain — stopping without replay or escalation";
  } else if (stepResult.error) {
    exec.error = stepResult.error;
  }
  return exec;
}
