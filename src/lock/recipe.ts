// Flightplan — the recipe model + converters between the on-disk lock and the ladder cache.
//
// This module owns:
//   1. CONVERTERS — `lockTargetToRecipe` (on-disk LockTarget → in-memory `CachedRecipe` that L0
//      replays) and `recipeFromExecution` (a successful `StepExecution` → a persistable
//      `LockTarget`). They are the ONLY sanctioned bridge between the two shapes.
//   2. THE ref:eN INVARIANT — a stored recipe selector is NEVER a bare `ref:eN` (refs are
//      ephemeral, page-scoped backendNodeIds — PLAN.md §3/§4, FINDINGS §3). `recipeFromExecution`
//      uses the StepExecution's `durableSelector` (the re-derived stable selector), NOT
//      `selectorUsed` when the latter is a ref, and `assertDurableSelector` hard-guards every
//      selector that flows into a target/candidate.
//   3. CANDIDATE RANKING — `green_runs` desc (most-proven first), and `mergeWinningRecipe` to fold
//      a freshly-learned winner into an existing target (promote winner → demote prior winner into
//      candidates → bump `green_runs` on a repeat green → set `last_seen` via an INJECTED clock).
//   4. ai_pick SUPPORT — round-trips `kind:'ai_pick'` + `pinned_choice` structurally (Phase 4
//      fills the pin/replay logic).
//
// Canonical references: PLAN.md §4 (Recipe/LockTarget, the never-ref invariant), §5 Phase 3
// (recipe model, green_runs/last_seen), §7 (candidate ranking feeds lock candidates 1:1).

import type { CachedRecipe } from "../ladder/index.ts";
import type { RankedCandidate, StepExecution } from "../ladder/index.ts";
import type { Strategy } from "../types.ts";
import type { LockCandidate, LockMatch, LockTarget } from "./types.ts";

// ---------------------------------------------------------------------------
// The ref:eN invariant
// ---------------------------------------------------------------------------

/** A selector is a bare ref (`ref:e12`) — ephemeral, page-scoped, NEVER persistable. */
export function isRefSelector(selector: string): boolean {
  return /^\s*ref:/i.test(selector);
}

/**
 * Raised when a non-re-resolvable selector is about to be persisted into a lock recipe. The lock
 * stores ONLY durable selectors; a `ref:eN` (or empty) selector is a programming error in the
 * caller (it should have re-derived a durable selector from the matched element).
 */
export class NonDurableSelectorError extends Error {
  constructor(
    readonly selector: string,
    readonly context: string,
  ) {
    super(
      `Refusing to persist a non-durable selector into the lock (${context}): ` +
        `${JSON.stringify(selector)}. Lock recipes must be re-resolvable (never a bare 'ref:eN'). ` +
        `Use the StepExecution's durableSelector instead of selectorUsed.`,
    );
    this.name = "NonDurableSelectorError";
  }
}

/**
 * Guard: assert `selector` is a durable, re-resolvable selector string (non-empty, not a `ref:`).
 * Throws {@link NonDurableSelectorError} otherwise. Every selector that enters a `LockTarget` /
 * `LockCandidate` passes through here, so the never-ref invariant is enforced in ONE place.
 */
export function assertDurableSelector(selector: string, context: string): string {
  const trimmed = selector.trim();
  if (trimmed.length === 0 || isRefSelector(trimmed)) {
    throw new NonDurableSelectorError(selector, context);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Candidate ranking
// ---------------------------------------------------------------------------

/**
 * Stable ranking key for candidates: `green_runs` DESC (most-proven first), then `strategy`
 * ascending, then `selector` ascending — fully deterministic so committed locks have minimal
 * diffs. Used by the writer and by merge.
 */
export function compareCandidates(a: LockCandidate, b: LockCandidate): number {
  const ga = a.green_runs ?? 0;
  const gb = b.green_runs ?? 0;
  if (ga !== gb) return gb - ga; // most-proven first
  if (a.strategy !== b.strategy) return a.strategy < b.strategy ? -1 : 1;
  if (a.selector !== b.selector) return a.selector < b.selector ? -1 : 1;
  return 0;
}

/** Return a new candidate array sorted by {@link compareCandidates} (does not mutate input). */
export function rankLockCandidates(candidates: LockCandidate[]): LockCandidate[] {
  return [...candidates].sort(compareCandidates);
}

// ---------------------------------------------------------------------------
// LockTarget → CachedRecipe (what L0 replays)
// ---------------------------------------------------------------------------

/**
 * Convert an on-disk {@link LockTarget} into the ladder's in-memory {@link CachedRecipe} that L0
 * replays. The winning `selector`/`strategy` become the recipe head; `candidates` (ranked
 * most-proven first) become the recipe's `candidates[]`; `match` is carried through so L0 can
 * validate `url_glob` + `sig` before trusting the recipe.
 *
 * For an `ai_pick` target the `pinned_choice` is treated as the winning recipe when no explicit
 * `selector`/`strategy` is present (Phase 4 owns the richer pin/replay; here we just make the pin
 * replayable as a recipe). Returns `undefined` when the target has no replayable recipe at all
 * (neither a winning selector nor a pin) — L0 then treats it as a miss.
 */
export function lockTargetToRecipe(target: LockTarget): CachedRecipe | undefined {
  const head = resolveHeadRecipe(target);
  if (!head) return undefined;

  const candidates = (target.candidates ? rankLockCandidates(target.candidates) : []).map(
    (c): CachedRecipe => ({ selector: c.selector, strategy: c.strategy }),
  );

  const recipe: CachedRecipe = {
    selector: head.selector,
    strategy: head.strategy,
    match: { url_glob: target.match.url_glob, sig: target.match.sig },
  };
  if (candidates.length > 0) recipe.candidates = candidates;
  return recipe;
}

/** The winning recipe head for a target: explicit `selector`/`strategy`, else the pin. */
function resolveHeadRecipe(
  target: LockTarget,
): { selector: string; strategy: Strategy } | undefined {
  if (target.selector !== undefined && target.strategy !== undefined) {
    return { selector: target.selector, strategy: target.strategy };
  }
  if (target.pinned_choice) {
    return { selector: target.pinned_choice.selector, strategy: target.pinned_choice.strategy };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// StepExecution → LockTarget (what we persist after a green resolution)
// ---------------------------------------------------------------------------

/**
 * Resolve the durable winning recipe from a `StepExecution`. Prefers `durableSelector` (the
 * re-derived stable selector the L1 resolver produced); the `strategy` comes from `execution.strategy`
 * when it is a concrete `Strategy`, otherwise it is inferred from the durable selector via the
 * provided `inferStrategy` (the driver's `selectorUsedToStrategy`, injected to avoid a driver
 * dependency in this pure module). Throws {@link NonDurableSelectorError} if no durable selector
 * exists or it is a ref.
 */
function winningRecipeFromExecution(
  execution: StepExecution,
  inferStrategy: (selector: string) => Strategy | null,
  context: string,
): { selector: string; strategy: Strategy } {
  const durable = execution.durableSelector;
  if (durable === undefined) {
    throw new NonDurableSelectorError(
      String(execution.selectorUsed ?? ""),
      `${context}: execution has no durableSelector`,
    );
  }
  const selector = assertDurableSelector(durable, context);
  // Prefer the learned strategy when it is concrete; null/undefined → infer from the selector.
  const strategy: Strategy =
    execution.strategy ?? inferStrategy(selector) ?? "css";
  return { selector, strategy };
}

/** Map a ladder {@link RankedCandidate} to a durable {@link LockCandidate}, dropping ref-only ones. */
function rankedToLockCandidate(rc: RankedCandidate): LockCandidate | undefined {
  if (isRefSelector(rc.selector) || rc.selector.trim().length === 0) return undefined;
  return { strategy: rc.strategy, selector: rc.selector.trim() };
}

/**
 * Build a persistable {@link LockTarget} from a freshly-resolved {@link StepExecution}.
 *
 *  - `step`/`target` — identity from the flow step (`step.id`, `step.target`).
 *  - `match`         — the `{ url_glob, sig }` gate the caller computed for THIS page (the runner
 *                      builds it from `urlGlobMatches`/`computeMatchSignature` inputs).
 *  - winning recipe  — from `execution.durableSelector` (NEVER `selectorUsed` when that is a ref);
 *                      `assertDurableSelector` guards it.
 *  - `candidates`    — `execution.candidates` projected to durable {@link LockCandidate}s
 *                      (ref-only candidates dropped), ranked most-proven first; the winner is NOT
 *                      duplicated into candidates.
 *  - `green_runs`    — initialised to 1 (this is its first recorded green).
 *  - `last_seen`     — ISO timestamp from the INJECTED clock (deterministic in tests).
 *  - `kind`/`pinned_choice` — set when `opts.kind === 'ai_pick'`; the pin defaults to the winning
 *                      recipe (Phase 4 may override with the explicit AI choice + label).
 *
 * @param step    `{ id, target? }` identity from the flow step.
 * @param execution the successful resolution+action result.
 * @param match   the precomputed match gate for the current page.
 * @param opts    `inferStrategy` (required — inject `selectorUsedToStrategy`), `now` (clock,
 *                defaults to `Date.now`), `kind`, and optional `pinnedLabel`.
 */
export function recipeFromExecution(
  step: { id: string; target?: string },
  execution: StepExecution,
  match: LockMatch,
  opts: {
    inferStrategy: (selector: string) => Strategy | null;
    now?: () => number;
    kind?: "ai_pick";
    pinnedLabel?: string;
  },
): LockTarget {
  const ctx = `step "${step.id}"`;
  const now = opts.now ?? Date.now;
  const winner = winningRecipeFromExecution(execution, opts.inferStrategy, ctx);

  const candidates = rankLockCandidates(
    (execution.candidates ?? [])
      .map(rankedToLockCandidate)
      .filter((c): c is LockCandidate => c !== undefined)
      // The winner is the head recipe, not a fallback — don't duplicate it.
      .filter((c) => !(c.selector === winner.selector && c.strategy === winner.strategy)),
  );

  const target: LockTarget = {
    step: step.id,
    target: step.target ?? "",
    match: { url_glob: match.url_glob, sig: match.sig },
    selector: winner.selector,
    strategy: winner.strategy,
    green_runs: 1,
    last_seen: new Date(now()).toISOString(),
  };
  if (candidates.length > 0) target.candidates = candidates;

  if (opts.kind === "ai_pick") {
    target.kind = "ai_pick";
    target.pinned_choice = {
      strategy: winner.strategy,
      selector: winner.selector,
      ...(opts.pinnedLabel !== undefined ? { label: opts.pinnedLabel } : {}),
    };
  }
  return target;
}

// ---------------------------------------------------------------------------
// Merge a freshly-learned winner into an existing target (the heal path)
// ---------------------------------------------------------------------------

/**
 * Fold a freshly-resolved {@link StepExecution} into an EXISTING {@link LockTarget} (the auto-heal
 * write path). Semantics:
 *
 *  - REPEAT GREEN (the new winner equals the existing winning recipe): bump `green_runs` by 1,
 *    refresh `match` + `last_seen`, keep candidates as-is. The lock is stable across repeated
 *    green runs (no churn except the counter + timestamp).
 *  - NEW WINNER (a heal — the recipe drifted): PROMOTE the new winner to `selector`/`strategy`,
 *    DEMOTE the prior winner into `candidates` (carrying its accumulated `green_runs`), merge in
 *    the execution's fresh candidates, drop the new winner from candidates, re-rank, refresh
 *    `match` + `last_seen`, and reset the head `green_runs` to 1 (its first green AS the winner).
 *    If the new winner already exists among the prior candidates, its accumulated `green_runs` is
 *    carried up (+1) rather than reset.
 *
 * Returns a NEW target (does not mutate `existing`). `last_seen` uses the injected clock.
 */
export function mergeWinningRecipe(
  existing: LockTarget,
  step: { id: string; target?: string },
  execution: StepExecution,
  match: LockMatch,
  opts: {
    inferStrategy: (selector: string) => Strategy | null;
    now?: () => number;
  },
): LockTarget {
  const ctx = `step "${step.id}" (merge)`;
  const now = opts.now ?? Date.now;
  const winner = winningRecipeFromExecution(execution, opts.inferStrategy, ctx);
  const lastSeen = new Date(now()).toISOString();

  const isRepeat =
    existing.selector === winner.selector && existing.strategy === winner.strategy;

  if (isRepeat) {
    return {
      ...existing,
      target: step.target ?? existing.target,
      match: { url_glob: match.url_glob, sig: match.sig },
      green_runs: (existing.green_runs ?? 0) + 1,
      last_seen: lastSeen,
    };
  }

  // ---- New winner (a heal) ----
  // Start the candidate pool from the existing candidates.
  const pool: LockCandidate[] = existing.candidates ? [...existing.candidates] : [];

  // Demote the prior winner into the pool (carrying its green_runs), if there was one.
  if (existing.selector !== undefined && existing.strategy !== undefined) {
    pool.push({
      strategy: existing.strategy,
      selector: existing.selector,
      ...(existing.green_runs !== undefined ? { green_runs: existing.green_runs } : {}),
    });
  }

  // Fold in the execution's freshly-observed candidates.
  for (const rc of execution.candidates ?? []) {
    const lc = rankedToLockCandidate(rc);
    if (lc) pool.push(lc);
  }

  // Did the new winner previously live in the pool? Carry its green_runs up (+1).
  let promotedGreenRuns = 1;
  const dedupedPool: LockCandidate[] = [];
  const seen = new Set<string>();
  for (const c of pool) {
    if (c.selector === winner.selector && c.strategy === winner.strategy) {
      promotedGreenRuns = (c.green_runs ?? 0) + 1;
      continue; // the winner becomes the head, not a candidate
    }
    const key = `${c.strategy} ${c.selector}`;
    if (seen.has(key)) {
      // Merge duplicate candidates by taking the max green_runs.
      const idx = dedupedPool.findIndex((d) => `${d.strategy} ${d.selector}` === key);
      const prev = dedupedPool[idx];
      if (prev) {
        dedupedPool[idx] = {
          ...prev,
          green_runs: Math.max(prev.green_runs ?? 0, c.green_runs ?? 0) || undefined,
        };
      }
      continue;
    }
    seen.add(key);
    dedupedPool.push(c);
  }

  const merged: LockTarget = {
    ...existing,
    target: step.target ?? existing.target,
    match: { url_glob: match.url_glob, sig: match.sig },
    selector: winner.selector,
    strategy: winner.strategy,
    green_runs: promotedGreenRuns,
    last_seen: lastSeen,
  };
  const ranked = rankLockCandidates(dedupedPool);
  if (ranked.length > 0) merged.candidates = ranked;
  else delete merged.candidates;

  // For an ai_pick target, re-pin to the new winner (Phase 4 may refine).
  if (existing.kind === "ai_pick") {
    merged.pinned_choice = {
      strategy: winner.strategy,
      selector: winner.selector,
      ...(existing.pinned_choice?.label !== undefined
        ? { label: existing.pinned_choice.label }
        : {}),
    };
  }
  return merged;
}
