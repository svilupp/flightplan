// Flightplan — L0: locked-recipe cache replay (Phase 3).
//
// L0 is the cheapest rung: read the composed lock (via `ctx.lock`), VALIDATE the recipe's
// `match{url_glob,sig}` against the current page, and REPLAY the cached recipe deterministically
// (PLAN.md §2 mermaid (b) / §5 Phase 3). On any validation/replay failure it returns a clean
// MISS (`escalate:true`) so the orchestrator climbs to L1 to re-resolve (and, on a real drift,
// heal).
//
// Validation (the trust gate — both must pass):
//   1. `urlGlobMatches(match.url_glob, snapshot.url)` — a cheap anchored-glob URL check.
//   2. `signatureMatches(match.sig, currentSig)` — the composite page signature (text-hash +
//      structural skeleton), recomputed from ONE snapshot via `capturePageSignature`.
//
// Replay: pass the ordered selector array `[winner, ...candidates]` to `driver.batch` (ref-first
// then ordered fallbacks, in-process), exactly as L1 would. A successful replay returns
// `{ ok:true, tier:'L0', … }` carrying the validated `signatureBasis` so the runner can refresh
// `green_runs`/`last_seen` bookkeeping (it does NOT rewrite a stable recipe — see §write policy).
//
// A recipe with NO `match` gate (a forward-compat shape, or a hand-built test recipe) cannot be
// trusted → MISS. This module imports `lock/signature.ts` (pure; driver-types-only) — the
// `ladder → lock` direction PLAN.md §2 sanctions; there is no runtime import cycle.

import type { InteractiveElement, PageSnapshot } from "../driver/index.ts";
import { selectorUsedToStrategy } from "../driver/index.ts";
import type { Step } from "../flow/types.ts";
import { signatureMatches, urlGlobMatches } from "../lock/signature.ts";
import type { StrategyEntry } from "../lock/types.ts";
import type { Strategy } from "../types.ts";
import { dispatchResolved } from "./dispatch.ts";
import { isInteractiveRole } from "./fuzzy.ts";
import { actionVerbForStep, buildBatchStep } from "./l1.ts";
import { capturePageSignature } from "./page-signature.ts";
import { parseDurableSelector, racePortfolio, resolveSelectorToElement } from "./revalidate.ts";
import type {
  CachedRecipe,
  PortfolioExecOutcome,
  PortfolioVerdict,
  ResolveContext,
  StepExecution,
} from "./types.ts";

/** A clean L0 cache MISS (before any replay) → escalate to L1, which may REUSE the shared snapshot. */
function miss(note: string): StepExecution {
  return { ok: false, tier: "L0", escalate: true, error: note };
}

/**
 * An L0 miss AFTER a validated recipe was replayed (the batch acted then failed). Flags `replayed`
 * so the orchestrator has L1 take a FRESH snapshot — the replay may have mutated the page.
 */
function replayMiss(
  note: string,
  dispatch?: Awaited<ReturnType<typeof dispatchResolved>>,
): StepExecution {
  return {
    ok: false,
    tier: "L0",
    // A failed replay is eligible for a fresh L1 attempt only when browser-pilot explicitly proves
    // that no input was dispatched. Missing metadata is normalized to `uncertain` and stops here.
    escalate: dispatch?.dispatchState === "not_dispatched",
    error: note,
    replayed: true,
    ...(dispatch
      ? {
          dispatchState: dispatch.dispatchState,
          retrySafe: dispatch.retrySafe,
          attempts: dispatch.attempts,
          ...(dispatch.retryDecisionReason !== undefined
            ? { retryDecisionReason: dispatch.retryDecisionReason }
            : {}),
          ...(dispatch.retryReason !== undefined ? { retryReason: dispatch.retryReason } : {}),
          receipt: dispatch.receipt,
        }
      : {}),
  };
}

/**
 * Pick the recipe (selector + strategy) that actually carried the replay. browser-pilot resolves
 * the ordered array ref-first then walks fallbacks, reporting the winner via `selectorUsed`:
 *   - matches the head recipe → the head.
 *   - matches a candidate → that candidate.
 *   - some other durable selector → map it via `selectorUsedToStrategy`.
 *   - absent/unmappable → fall back to the head (informational only — an L0 hit never rewrites).
 */
function learnReplay(
  cached: CachedRecipe,
  selectorUsed: string | undefined,
): { selector: string; strategy: Strategy } {
  if (selectorUsed && selectorUsed === cached.selector) {
    return { selector: cached.selector, strategy: cached.strategy };
  }
  if (selectorUsed) {
    const candidate = cached.candidates?.find((c) => c.selector === selectorUsed);
    if (candidate) return { selector: candidate.selector, strategy: candidate.strategy };
    const mapped = selectorUsedToStrategy(selectorUsed);
    if (mapped !== null) return { selector: selectorUsed, strategy: mapped };
  }
  return { selector: cached.selector, strategy: cached.strategy };
}

/**
 * Attempt L0 cache replay. Returns a HIT (`ok:true, tier:'L0'`) only when the lock has a recipe
 * for the step, its `match{url_glob,sig}` validates against the current page, AND the recipe
 * replays successfully. Any miss returns `escalate:true` so the orchestrator falls through to L1.
 */
export async function resolveL0(
  step: Step,
  ctx: ResolveContext,
  snapshot?: PageSnapshot,
): Promise<StepExecution> {
  // No lock hook wired → clean miss (no lock manager available).
  if (!ctx.lock) {
    return miss("L0 miss: no lock hook");
  }

  const cached = await ctx.lock.lookup(step, ctx);
  if (!cached) {
    return miss("L0 miss: no cached recipe for step");
  }
  // A recipe without a match gate cannot be trusted (it was never validated against a page).
  if (!cached.match) {
    return miss("L0 miss: cached recipe has no match gate — cannot validate");
  }

  const action = actionVerbForStep(step);
  if (!action) {
    return miss(`L0 miss: non-targeting step (do=${step.do}) — nothing to replay`);
  }

  // ONE snapshot serves both the signature validation and the replay context: reuse the
  // orchestrator's shared attribute-enriched snapshot when provided, else take a fresh one.
  const snap = snapshot ?? (await ctx.driver.snapshot({ attributes: true }));

  // (1) url_glob gate (cheap).
  if (!urlGlobMatches(cached.match.url_glob, snap.url)) {
    return miss(
      `L0 miss: url ${snap.url} does not match url_glob ${cached.match.url_glob} — re-resolve at L1`,
    );
  }

  // (2) composite page-signature gate (masked-text hash + structural skeleton). `ctx.cache`
  // threads `[cache] ignore_regions` (excluded from BOTH hashes) + the `signature` match mode.
  const basis = await capturePageSignature(ctx.driver, snap, ctx.cache);
  const sigMode = ctx.cache?.signature ?? "full";
  const signatureHit = signatureMatches(cached.match.sig, basis.sig, sigMode);

  // (2b) TARGET-IDENTITY REPLAY PLAN (Fix 1). Anchor the replay on the recipe's PRIMARY (top-ranked)
  // strategy — the element the recipe INTENDS — and NEVER let a loosely-related fuzzy sibling that
  // merely resolves lead/win the replay (the measured admin-crud bug: the polluted portfolio's
  // `[data-testid="bulk-delete"]` won a disagreement race for the `check_row_u2` checkbox step). See
  // `buildReplayPlan`: it leads with the primary, keeps only SAME-element strategies as fallbacks,
  // drops rival-element ones, and drift-heals only when the primary itself no longer resolves.
  const now = ctx.now ? ctx.now() : Date.now();
  const plan = buildReplayPlan(cached, snap.interactiveElements, now);

  let revalidated = false;
  if (!signatureHit) {
    // On a signature MISS, only replay when the recipe's PRIMARY target is still present (or a
    // same-element strategy re-resolves it). A rival sibling resolving must NOT rescue the recipe.
    if (!plan.present) {
      // Clean pre-replay miss: hand the freshly-computed basis to the orchestrator so L1 reuses it
      // (same page, same snapshot) instead of recomputing `capturePageSignature` (Item 4).
      return {
        ...miss("L0 miss: page signature changed — re-resolve at L1"),
        signatureBasis: basis,
      };
    }
    revalidated = true;
  } else if (!plan.present) {
    // Signature matched but the primary target no longer uniquely resolves and no remembered
    // strategy heals it (e.g. a persisted non-discriminating `role:button` over an icon toolbar) →
    // clean MISS so the step re-resolves at L1/vision rather than mis-clicking the first match.
    return {
      ...miss(
        "L0 miss: cached recipe's primary target is not uniquely resolvable — re-resolve at L1",
      ),
      signatureBasis: basis,
    };
  }

  // Actionability demotion (disabled → back). Rivals were already dropped by the identity gate, so
  // this is a pre-dispatch policy gate. Do not put unsafe fallbacks back into the batch: a failed
  // safe selector must not silently fall through to a disabled/non-discriminating side effect.
  // Structural fingerprints are Flightplan identity tokens, not browser-pilot action selectors.
  // Once the snapshot proves which element they identify, replay through its ephemeral ref instead
  // of letting the token fall through to CSS lookup and fail as an invalid selector.
  const replaySelectors = plan.ordered
    .map((selector) => selectorForReplay(selector, snap.interactiveElements))
    .filter((selector): selector is string => selector !== undefined);
  if (replaySelectors.length === 0) {
    return {
      ...miss("L0 miss: cached target has no browser-actionable selector"),
      signatureBasis: basis,
    };
  }
  const { acceptable } = partitionByActionability(replaySelectors, snap.interactiveElements);
  if (acceptable.length === 0) {
    return {
      ...miss("L0 miss: cached target has no unique actionable selector — dispatch vetoed"),
      retrySafe: true,
      dispatchState: "not_dispatched",
      attempts: 0,
      retryDecisionReason: "retry_unsafe",
      retryReason: "dispatch vetoed before input: all cached selectors are unsafe",
      receipt: {
        dispatchState: "not_dispatched",
        retrySafe: true,
        inputEventsSent: [],
        attempts: 0,
        retryDecisionReason: "retry_unsafe",
        retryReason: "dispatch vetoed before input: all cached selectors are unsafe",
      },
    };
  }
  const orderedSelectors = acceptable;
  const batchStep = buildBatchStep(step, action, orderedSelectors);
  const dispatched = await dispatchResolved(
    ctx.driver,
    [batchStep],
    { onFail: "stop" },
    {
      allowed: true,
    },
  );
  const stepResult = dispatched.stepResult;
  if (!stepResult) {
    return replayMiss("L0 miss: cached recipe returned no step result", dispatched);
  }
  if (!stepResult?.success || stepResult.outcomeStatus === "ambiguous") {
    return replayMiss("L0 miss: cached recipe failed to replay — re-resolve at L1", dispatched);
  }
  // SAFETY NET: reject a replay that acted via a selector we KNOW resolves to a DIFFERENT element
  // than the primary (a rival that somehow led) → escalate rather than trust a wrong click.
  if (
    stepResult.selectorUsed !== undefined &&
    plan.drifted.some((d) => d.selector === stepResult.selectorUsed)
  ) {
    return replayMiss(
      "L0 miss: replay resolved a different element than the recipe's primary — re-resolve at L1",
      dispatched,
    );
  }

  const learned = learnReplay(cached, stepResult.selectorUsed);
  const exec: StepExecution = {
    ok: true,
    tier: "L0",
    strategy: learned.strategy,
    durableSelector: learned.selector,
    escalate: false,
    dispatchState: dispatched.dispatchState,
    retrySafe: dispatched.retrySafe,
    attempts: dispatched.attempts,
    ...(dispatched.retryDecisionReason !== undefined
      ? { retryDecisionReason: dispatched.retryDecisionReason }
      : {}),
    ...(dispatched.retryReason !== undefined ? { retryReason: dispatched.retryReason } : {}),
    receipt: dispatched.receipt,
    ...(stepResult.matchedConditions !== undefined
      ? { matchedConditions: stepResult.matchedConditions }
      : {}),
    ...(stepResult.outcomeStatus !== undefined ? { outcomeStatus: stepResult.outcomeStatus } : {}),
    // Carry the FRESH basis so a non-frozen run refreshes a (possibly stale) stored sig and updates
    // track records (the runner's write-back reads `signatureBasis` + `portfolio`).
    signatureBasis: basis,
  };
  if (stepResult.selectorUsed !== undefined) exec.selectorUsed = stepResult.selectorUsed;
  // Attach the portfolio outcome so the write-back credits the SAME-element strategies (agreed) and
  // stamps drift on the rival siblings (drifted → they sink and never lead a future replay). Only
  // when there is a real portfolio or a non-trivial verdict (keeps a pure legacy single-selector
  // recipe a no-op write, as before).
  if (cached.strategies || plan.drifted.length > 0 || plan.agreed.length > 1) {
    exec.portfolio = buildPortfolioOutcome(plan, learned.strategy, learned.selector);
  }
  if (revalidated) {
    exec.revalidated = true;
    exec.error =
      "l0_revalidated: signature miss, primary target re-validated against fresh snapshot";
  }
  return exec;
}

// ---------------------------------------------------------------------------
// Target-identity replay plan (Fix 1)
// ---------------------------------------------------------------------------

/** The ordered replay plan: what to send to `driver.batch`, plus the per-strategy verdict. */
interface ReplayPlan {
  /** Is the recipe's intended target present/replayable at all (else L0 must miss → L1)? */
  present: boolean;
  /** Ordered replay selectors — the PRIMARY first, then verified SAME-element fallbacks only. */
  ordered: string[];
  /** The primary/winning verdict (leads the replay). */
  winner: PortfolioVerdict;
  /** Strategies confirmed on the anchor element (bump track records on the write-back). */
  agreed: PortfolioVerdict[];
  /** Strategies that uniquely resolved to a DIFFERENT element (rivals) — stamp drift, never lead. */
  drifted: PortfolioVerdict[];
  /** Count of identity-bearing (parseable) strategies, for the `agreement` trace string. */
  parseableCount: number;
}

/** The recipe's PRIMARY strategy: the top-ranked portfolio entry, else the legacy head. */
function primaryOf(cached: CachedRecipe): PortfolioVerdict {
  const top = cached.strategies?.[0];
  return top
    ? { kind: top.kind, selector: top.selector }
    : { kind: cached.strategy, selector: cached.selector };
}

/** Every remembered strategy EXCEPT the primary (portfolio + legacy head/candidates), deduped. */
function otherVerdicts(cached: CachedRecipe, primarySelector: string): PortfolioVerdict[] {
  const out: PortfolioVerdict[] = [];
  const seen = new Set<string>([primarySelector]);
  const add = (kind: PortfolioVerdict["kind"], selector: string): void => {
    if (seen.has(selector)) return;
    seen.add(selector);
    out.push({ kind, selector });
  };
  for (const s of cached.strategies ?? []) add(s.kind, s.selector);
  add(cached.strategy, cached.selector);
  for (const c of cached.candidates ?? []) add(c.strategy, c.selector);
  return out;
}

/**
 * Build the target-identity replay plan (Fix 1). Three cases:
 *
 *  - ANCHORED — the parseable primary uniquely resolves to element E: lead with the primary, keep
 *    only the strategies that ALSO resolve to E (same ref) as fallbacks, and DROP every strategy
 *    that resolves to a DIFFERENT element (a rival) → it can never lead/win the replay.
 *  - COMPOUND — the primary is a precise compound/descendant CSS selector (e.g. a scoped
 *    `[data-row-id='u2'] [data-testid='row-check']` author hint) that the AX snapshot can't map to
 *    an element identity: lead with the PRIMARY ALONE and drop every clean rival, so browser-pilot
 *    resolves the author's exact selector, not a fuzzy sibling that merely resolves.
 *  - DRIFT-HEAL — the parseable primary no longer uniquely resolves (real drift): race the
 *    remembered portfolio (role/name-corroborated) to re-find the SAME target via another strategy.
 *    `present:false` when nothing resolves → L0 misses and re-resolves at L1.
 */
function buildReplayPlan(
  cached: CachedRecipe,
  elements: readonly InteractiveElement[],
  now: number,
): ReplayPlan {
  const primary = primaryOf(cached);
  const others = otherVerdicts(cached, primary.selector);
  const parseableCount = [primary, ...others].filter(
    (v) => parseDurableSelector(v.selector) !== undefined,
  ).length;

  const primaryParsed = parseDurableSelector(primary.selector);
  const anchor = resolveSelectorToElement(primary.selector, elements);

  // CASE A — anchored on the uniquely-resolved parseable primary.
  if (anchor) {
    const anchorKey = anchor.ref ?? anchor.selector;
    const ordered = [primary.selector];
    const agreed: PortfolioVerdict[] = [primary];
    const drifted: PortfolioVerdict[] = [];
    for (const o of others) {
      const el = resolveSelectorToElement(o.selector, elements);
      if (el && (el.ref ?? el.selector) === anchorKey) {
        ordered.push(o.selector);
        agreed.push(o);
      } else if (el) {
        drifted.push(o); // uniquely resolves ELSEWHERE → rival → drop from the replay
      }
      // else: non-identity / non-unique → never used to lead the batch (dropped from `ordered`).
    }
    return {
      present: true,
      ordered: dedupeStrings(ordered),
      winner: primary,
      agreed,
      drifted,
      parseableCount,
    };
  }

  // CASE B — compound/non-identity primary: lead with the precise author selector alone.
  if (!primaryParsed) {
    const drifted = others.filter(
      (o) => resolveSelectorToElement(o.selector, elements) !== undefined,
    );
    return {
      present: true,
      ordered: [primary.selector],
      winner: primary,
      agreed: [primary],
      drifted,
      parseableCount,
    };
  }

  // CASE C — the parseable primary drifted (gone/ambiguous). Drift-heal via a corroborated race.
  const portfolio: StrategyEntry[] =
    cached.strategies ??
    [{ kind: cached.strategy, selector: cached.selector, greens: 0 } as StrategyEntry].concat(
      (cached.candidates ?? []).map((c) => ({ kind: c.strategy, selector: c.selector, greens: 0 })),
    );
  const race = racePortfolio(portfolio, elements, now);
  if (!race.ok || !race.winner) {
    return {
      present: false,
      ordered: [],
      winner: primary,
      agreed: [],
      drifted: [],
      parseableCount,
    };
  }
  return {
    present: true,
    ordered: dedupeStrings([race.winner.selector, ...race.agreed.map((a) => a.selector)]),
    winner: race.winner,
    agreed: race.agreed,
    drifted: race.drifted,
    parseableCount,
  };
}

/** Build the {@link PortfolioExecOutcome} the write-back reads from a replay plan. */
function buildPortfolioOutcome(
  plan: ReplayPlan,
  learnedStrategy: Strategy,
  learnedSelector: string,
): PortfolioExecOutcome {
  // Credit the selector that actually carried the replay as the winner when it is one of the
  // agreeing same-element strategies; otherwise the plan's primary/race winner.
  const acted = plan.agreed.find((v) => v.selector === learnedSelector) ?? plan.winner;
  return {
    winner: {
      kind: acted.kind === learnedStrategy ? learnedStrategy : acted.kind,
      selector: acted.selector,
    },
    agreed: plan.agreed,
    drifted: plan.drifted,
    agreement: `${plan.agreed.length}/${plan.parseableCount}`,
  };
}

/** De-duplicate an ordered selector list, preserving first-seen order. */
function dedupeStrings(selectors: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of selectors) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Replay actionability + discrimination gate (Tasks B/C)
// ---------------------------------------------------------------------------
//
// A local mirror of `revalidate.ts`'s element-identity matcher, kept here because the replay gate
// needs to COUNT a selector's matches (>1 ⇒ non-discriminating) and inspect `disabled` — the
// portfolio race collapses "0 matches" and ">1 matches" both into a single "miss" and never looks
// at actionability. If `revalidate.ts` ever EXPORTS its `elementMatches`, delete this and reuse it.

/** Does a snapshot element satisfy the identity a parsed durable selector asserts? */
function elementMatchesParsed(
  el: InteractiveElement,
  p: NonNullable<ReturnType<typeof parseDurableSelector>>,
): boolean {
  if (p.testid !== undefined) {
    const attrs = el.attributes;
    if (!attrs) return false;
    const v = attrs["data-testid"] ?? attrs["data-test"] ?? attrs["data-qa"];
    return v === p.testid;
  }
  if (p.attr !== undefined) {
    const attrs = el.attributes;
    if (!attrs) return false;
    return attrs[p.attr.key] === p.attr.value;
  }
  if (p.text !== undefined) {
    return isInteractiveRole(el.role) && el.name === p.text;
  }
  if (p.fingerprint !== undefined) {
    return (
      (el.role ?? "").toLowerCase() === p.fingerprint.role.toLowerCase() &&
      (el.name ?? "") === p.fingerprint.name
    );
  }
  if (p.role !== undefined) {
    if ((el.role ?? "").toLowerCase() !== p.role.toLowerCase()) return false;
    // role-only selector (`role:button`): matches ANY element of that role → non-discriminating.
    return p.name === undefined ? true : (el.name ?? "") === p.name;
  }
  return false;
}

/**
 * Classify a replay selector against the shared snapshot for the L0 replay ORDER (Tasks B/C):
 *  - a POSITIONAL / identity selector that resolves to exactly ONE element → `"acceptable"` unless
 *    that element is DISABLED (→ `"unsafe"`, a hang risk). A positional `role:button[N]` resolves to
 *    the Nth same-role element → DISCRIMINATING (Fix 2), never the "non-discriminating" case.
 *  - resolves to >1 element  → `"unsafe"` (NON-DISCRIMINATING; browser-pilot would resolve the
 *    FIRST/wrong match — e.g. a bare `role:button` over an icon toolbar). [C]
 *  - unparseable (css/ref) OR 0 matches in the AX snapshot → `"acceptable"` (we cannot PROVE it
 *    bad — browser-pilot may still resolve it; never demote what we can't classify, so a warm hit
 *    on a GOOD selector stays byte-identical).
 */
function classifyReplaySelector(
  selector: string,
  elements: readonly InteractiveElement[],
): "acceptable" | "unsafe" {
  const parsed = parseDurableSelector(selector);
  if (!parsed) return "acceptable"; // css/ref/unparseable — trust it (can't classify)
  // Uniquely resolves (incl. a positional `role:button[N]`) → judge on the resolved element's state.
  const el = resolveSelectorToElement(selector, elements);
  if (el) return el.disabled === true ? "unsafe" : "acceptable"; // disabled → hang risk (Task B)
  // Not a single element: distinguish non-discriminating (>1 ⇒ unsafe) from absent (0 ⇒ trust bp).
  if (parsed.index !== undefined) return "acceptable"; // positional out of range — harmless
  const matches = elements.filter((e) => elementMatchesParsed(e, parsed));
  return matches.length > 1 ? "unsafe" : "acceptable"; // >1 non-discriminating (Task C); 0 trust bp
}

/**
 * Split the ordered replay selectors into `acceptable` (unique-enabled / unparseable / absent) and
 * `unsafe` (non-discriminating or disabled), each preserving its ORIGINAL relative order. The
 * caller leads the replay with `acceptable`; when `acceptable` is empty the recipe cannot be
 * replayed without risking a wrong/blocked click and L0 must MISS (→ re-resolve at L1/vision).
 */
function partitionByActionability(
  selectors: readonly string[],
  elements: readonly InteractiveElement[],
): { acceptable: string[]; unsafe: string[] } {
  const acceptable: string[] = [];
  const unsafe: string[] = [];
  for (const s of selectors) {
    if (classifyReplaySelector(s, elements) === "unsafe") unsafe.push(s);
    else acceptable.push(s);
  }
  return { acceptable, unsafe };
}

/** Convert Flightplan-only selector tokens into a selector browser-pilot can execute. */
function selectorForReplay(
  selector: string,
  elements: readonly InteractiveElement[],
): string | undefined {
  // `label:` is a legacy Flightplan strategy spelling, not a browser-pilot selector. Fail closed
  // so a stale lock escalates to L1 rather than being parsed as CSS.
  if (/^label:/i.test(selector)) return undefined;
  if (!/^(?:fingerprint|fp|structure):/i.test(selector)) return selector;
  const element = resolveSelectorToElement(selector, elements);
  return element ? `ref:${element.ref}` : undefined;
}
