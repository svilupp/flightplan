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

import { selectorUsedToStrategy } from "../driver/index.ts";
import type { PageSnapshot } from "../driver/index.ts";
import type { Step } from "../flow/types.ts";
import type { Strategy } from "../types.ts";
import { signatureMatches, urlGlobMatches } from "../lock/signature.ts";
import { actionVerbForStep, buildBatchStep } from "./l1.ts";
import { capturePageSignature } from "./page-signature.ts";
import type { CachedRecipe, ResolveContext, StepExecution } from "./types.ts";

/** A clean L0 cache MISS (before any replay) → escalate to L1, which may REUSE the shared snapshot. */
function miss(note: string): StepExecution {
  return { ok: false, tier: "L0", escalate: true, error: note };
}

/**
 * An L0 miss AFTER a validated recipe was replayed (the batch acted then failed). Flags `replayed`
 * so the orchestrator has L1 take a FRESH snapshot — the replay may have mutated the page.
 */
function replayMiss(note: string): StepExecution {
  return { ok: false, tier: "L0", escalate: true, error: note, replayed: true };
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

  // (2) composite page-signature gate (text-hash + structural skeleton).
  const basis = await capturePageSignature(ctx.driver, snap);
  if (!signatureMatches(cached.match.sig, basis.sig)) {
    return miss("L0 miss: page signature changed — re-resolve at L1");
  }

  // Validated → replay the recipe (ordered: winning selector, then ranked candidates). From here
  // a miss is a REPLAY miss (the batch acted): the orchestrator will re-snapshot for L1.
  const selectors = [cached.selector, ...(cached.candidates ?? []).map((c) => c.selector)];
  const batchStep = buildBatchStep(step, action, selectors);
  const result = await ctx.driver.batch([batchStep], { onFail: "stop" });
  const stepResult = result.steps[0];
  if (!stepResult || !stepResult.success || stepResult.outcomeStatus === "ambiguous") {
    return replayMiss("L0 miss: cached recipe failed to replay — re-resolve at L1");
  }

  const learned = learnReplay(cached, stepResult.selectorUsed);
  const exec: StepExecution = {
    ok: true,
    tier: "L0",
    strategy: learned.strategy,
    durableSelector: learned.selector,
    escalate: false,
    signatureBasis: basis,
  };
  if (stepResult.selectorUsed !== undefined) exec.selectorUsed = stepResult.selectorUsed;
  return exec;
}
