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

import type { CachedRecipe, RankedCandidate, StepExecution } from "../ladder/index.ts";
import type { Strategy } from "../types.ts";
import {
  activeNote,
  applyOutcome,
  dedupeEntries,
  type PortfolioOutcome,
  portfolioToCandidates,
  portfolioWinner,
  rankPortfolio,
} from "./portfolio.ts";
import type { LockCandidate, LockMatch, LockTarget, StrategyEntry, TargetMemory } from "./types.ts";

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
 * replays. Targets are normalized to the v2 portfolio on load, so the recipe is built from
 * `strategies`: the ranked WINNER (top entry) becomes the recipe head, the rest become the
 * recipe's `candidates[]` (the ordered replay batch), the FULL portfolio is carried on
 * `strategies` so L0 can RACE it (agreement/track-record logic), and `match` is carried so L0
 * validates `url_glob` + `sig` before trusting the recipe.
 *
 * For an `ai_pick` target with an empty portfolio, the `pinned_choice` seeds the head (Phase 4
 * owns the richer pin/replay). Returns `undefined` when the target has no replayable recipe at all
 * (empty portfolio and no pin) — L0 then treats it as a miss.
 *
 * The target's FRESH advisory `note` (non-stale relative to `now`, DESIGN §4) is carried on the
 * recipe so an AI tier can read it as prompt context; a decayed/absent note is omitted. `now`
 * (defaulting to `Date.now`) drives that staleness check and is injectable for deterministic tests.
 */
export function lockTargetToRecipe(
  target: LockTarget,
  now: number = Date.now(),
): CachedRecipe | undefined {
  const winner = portfolioWinner(target);
  const head: { selector: string; strategy: Strategy } | undefined = winner
    ? { selector: winner.selector, strategy: winner.kind }
    : target.pinned_choice
      ? { selector: target.pinned_choice.selector, strategy: target.pinned_choice.strategy }
      : undefined;
  if (!head) return undefined;

  const strategies = target.strategies ?? [];
  const candidates = portfolioToCandidates(strategies).map(
    (c): CachedRecipe => ({ selector: c.selector, strategy: c.strategy }),
  );

  const recipe: CachedRecipe = {
    selector: head.selector,
    strategy: head.strategy,
    match: { url_glob: target.match.url_glob, sig: target.match.sig },
  };
  if (candidates.length > 0) recipe.candidates = candidates;
  if (strategies.length > 0) recipe.strategies = strategies;
  const note = activeNote(target, now);
  if (note !== undefined) recipe.note = note;
  return recipe;
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
      execution.selectorUsed ?? "",
      `${context}: execution has no durableSelector`,
    );
  }
  const selector = assertDurableSelector(durable, context);
  // Prefer the learned strategy when it is concrete; null/undefined → infer from the selector.
  const strategy: Strategy = execution.strategy ?? inferStrategy(selector) ?? "css";
  return { selector, strategy };
}

/** Map a ladder {@link RankedCandidate} to a durable {@link LockCandidate}, dropping ref-only ones. */
function rankedToLockCandidate(rc: RankedCandidate): LockCandidate | undefined {
  if (isRefSelector(rc.selector) || rc.selector.trim().length === 0) return undefined;
  return { strategy: rc.strategy, selector: rc.selector.trim() };
}

/**
 * Build a persistable {@link LockTarget} PORTFOLIO from a freshly-resolved {@link StepExecution}
 * (the FIRST-LEARN write path, DESIGN §3).
 *
 *  - `step`/`target` — identity from the flow step (`step.id`, `step.target`).
 *  - `match`         — the `{ url_glob, sig }` gate the caller computed for THIS page.
 *  - `strategies`    — a fresh portfolio: the winning strategy (from `execution.durableSelector` —
 *                      NEVER a ref; `assertDurableSelector` guards it) at `greens:1, last_ok:now`,
 *                      then every observed candidate (ref-only dropped) as a further strategy at
 *                      `greens:0`. Ranked so the winner leads. When L0 raced a portfolio, the
 *                      `execution.portfolio.agreed` strategies are all credited a green too.
 *  - `last_seen`     — ISO timestamp from the INJECTED clock (deterministic in tests).
 *  - `memory`        — the advisory note block, set when `opts.note` is a non-empty string (already
 *                      REDACTED by the caller) with `note_updated` = now (DESIGN §4).
 *  - `kind`/`pinned_choice` — set when `opts.kind === 'ai_pick'`; the pin defaults to the winner.
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
    /** The AI-emitted note-to-future-self, ALREADY REDACTED (secrets/PII masked). */
    note?: string;
  },
): LockTarget {
  const ctx = `step "${step.id}"`;
  const now = opts.now ?? Date.now;
  const nowMs = now();
  const winner = winningRecipeFromExecution(execution, opts.inferStrategy, ctx);
  const nowIso = new Date(nowMs).toISOString();

  const seedCandidates = (execution.candidates ?? [])
    .map(rankedToLockCandidate)
    .filter((c): c is LockCandidate => c !== undefined);

  const seeded: StrategyEntry[] = [
    { kind: winner.strategy, selector: winner.selector, greens: 1, last_ok: nowIso },
    ...seedCandidates.map(
      (c): StrategyEntry => ({ kind: c.strategy, selector: c.selector, greens: 0 }),
    ),
  ];
  const strategies = rankPortfolio(dedupeEntries(seeded), nowMs);

  const target: LockTarget = {
    step: step.id,
    target: step.target ?? "",
    match: { url_glob: match.url_glob, sig: match.sig },
    strategies,
    last_seen: nowIso,
  };

  const memory = buildMemory(opts.note, nowIso);
  if (memory !== undefined) target.memory = memory;

  if (opts.kind === "ai_pick") {
    target.kind = "ai_pick";
    // NOTE (Task C fail-safe): an ai_pick's winning `durableSelector` can be NON-DISCRIMINATING
    // (e.g. a role-only `role:button` when the picked element is an icon with no name/testid — see
    // `strategy-array.ts`). We persist it as-is (it still round-trips + carries the advisory note),
    // but the correctness guarantee lives at REPLAY time: `l0.ts`'s `classifyReplaySelector` detects
    // that the selector resolves to >1 element on the live page and SKIPS L0 (→ re-resolve via
    // vision) rather than clicking the wrong element. So a mis-discriminating pin can never mis-act.
    // TODO(browser-pilot positional): when a UNIQUE positional selector (`role:button[N]`) can be
    // derived for the picked element (see the TODO in `strategy-array.ts#roleNameSelectorForElement`),
    // pin THAT here so an icon-only ai_pick stays deterministically L0-replayable.
    target.pinned_choice = {
      strategy: winner.strategy,
      selector: winner.selector,
      ...(opts.pinnedLabel !== undefined ? { label: opts.pinnedLabel } : {}),
    };
  }
  return target;
}

// ---------------------------------------------------------------------------
// Advisory memory (the note-to-future-self, DESIGN §4)
// ---------------------------------------------------------------------------

/**
 * Build the advisory {@link TargetMemory} for a write, given a freshly-emitted (ALREADY REDACTED)
 * `note` and the current ISO timestamp. Returns `undefined` for an absent/empty note so no empty
 * memory block is stored. `existing` is the target's prior memory, PRESERVED when no new note was
 * emitted this run — so a note persists across green runs until the model overwrites it (or it
 * decays out on load).
 */
export function buildMemory(
  note: string | undefined,
  nowIso: string,
  existing?: TargetMemory,
): TargetMemory | undefined {
  const trimmed = note?.trim();
  if (trimmed) return { note: trimmed, note_updated: nowIso };
  // No new note this run: keep the prior note (if any) unchanged.
  if (existing?.note) {
    const out: TargetMemory = { note: existing.note };
    if (existing.note_updated !== undefined) out.note_updated = existing.note_updated;
    return out;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Merge an execution into an existing portfolio target (the track-record path)
// ---------------------------------------------------------------------------

/** The result of folding an execution into an existing portfolio target. */
export interface MergeResult {
  /** The new target (portfolio re-ranked). Does not mutate the input. */
  target: LockTarget;
  /** True when the top-ranked WINNER strategy CHANGED vs the prior portfolio (drives heal/drift). */
  winnerChanged: boolean;
}

/**
 * Fold a freshly-resolved {@link StepExecution} into an EXISTING {@link LockTarget} portfolio
 * (DESIGN §3 track-record update + re-rank). Builds a {@link PortfolioOutcome} from the execution
 * and applies it (`applyOutcome`):
 *
 *  - When L0 RACED the portfolio (`execution.portfolio` present), the race's `agreed`/`drifted`
 *    verdicts ARE the outcome: agreeing strategies get `greens`+1/`last_ok`, disagreeing/stale
 *    ones get `last_drift`. The winning selector is credited and floats to the top.
 *  - Otherwise (an L1 re-resolve after a clean miss), the durable winner is credited a green
 *    (learned if new) and the freshly-observed candidates are seeded (greens:0) — the classic
 *    "learn the resolved selector" path, now expressed as a portfolio update.
 *
 * `winnerChanged` reports whether the TOP strategy differs from the prior top — that (and only
 * that) is a heal/drift for the write policy, matching the v1 "winner drifted" semantics. Repeated
 * green runs (winner unchanged) are NOT heals even though track records tick over.
 *
 * Returns a NEW target (does not mutate `existing`). Timestamps use the injected clock.
 */
export function mergeWinningRecipe(
  existing: LockTarget,
  step: { id: string; target?: string },
  execution: StepExecution,
  match: LockMatch,
  opts: {
    inferStrategy: (selector: string) => Strategy | null;
    now?: () => number;
    /** A freshly-emitted note-to-future-self, ALREADY REDACTED. Overwrites the prior note when set. */
    note?: string;
  },
): MergeResult {
  const ctx = `step "${step.id}" (merge)`;
  const now = opts.now ?? Date.now;
  const nowMs = now();
  const lastSeen = new Date(nowMs).toISOString();
  const winner = winningRecipeFromExecution(execution, opts.inferStrategy, ctx);

  const priorWinner = portfolioWinner(existing);
  const existingStrategies = existing.strategies ?? [];

  // Build the per-strategy outcome. Prefer the L0 race verdicts when present; else derive from the
  // durable winner + freshly-observed candidates (the L1-rebuild-after-miss path).
  //
  // On the L1-rebuild path we reached L1 BECAUSE L0 missed — the prior portfolio failed to carry
  // the step (its winner's sig gate failed or its selector no longer resolved). If L1 then resolved
  // a DIFFERENT winning selector, the prior winner DRIFTED: stamp it so it demotes below the fresh
  // winner (matching the v1 "winner drifted → promote new, demote old" heal semantics). A repeat of
  // the same selector is just a green (no drift).
  const l1DriftedPrior =
    !execution.portfolio &&
    priorWinner &&
    !(priorWinner.kind === winner.strategy && priorWinner.selector === winner.selector)
      ? [{ kind: priorWinner.kind, selector: priorWinner.selector }]
      : [];

  const outcome: PortfolioOutcome = execution.portfolio
    ? {
        agreed: execution.portfolio.agreed.map((v) => ({ kind: v.kind, selector: v.selector })),
        drifted: execution.portfolio.drifted.map((v) => ({ kind: v.kind, selector: v.selector })),
        learned: [{ kind: winner.strategy, selector: winner.selector }],
      }
    : {
        agreed: [{ kind: winner.strategy, selector: winner.selector }],
        drifted: l1DriftedPrior,
        learned: [
          { kind: winner.strategy, selector: winner.selector },
          ...(execution.candidates ?? [])
            .map(rankedToLockCandidate)
            .filter((c): c is LockCandidate => c !== undefined)
            .map((c) => ({ kind: c.strategy, selector: c.selector })),
        ],
      };

  const strategies = applyOutcome(existingStrategies, outcome, nowMs);
  const newWinner = strategies[0];
  const winnerChanged =
    !priorWinner ||
    !newWinner ||
    priorWinner.kind !== newWinner.kind ||
    priorWinner.selector !== newWinner.selector;

  const merged: LockTarget = {
    step: existing.step,
    target: step.target ?? existing.target,
    match: { url_glob: match.url_glob, sig: match.sig },
    strategies,
    last_seen: lastSeen,
  };
  if (existing.kind !== undefined) merged.kind = existing.kind;

  // Advisory memory: a freshly-emitted note overwrites; otherwise the prior note is preserved
  // (decay is applied on the next LOAD via `normalizeTarget`, so a stale note self-drops there).
  const memory = buildMemory(opts.note, lastSeen, existing.memory);
  if (memory !== undefined) merged.memory = memory;

  // For an ai_pick target, re-pin to the (possibly new) top winner (Phase 4 may refine).
  if (existing.kind === "ai_pick" && newWinner) {
    merged.pinned_choice = {
      strategy: newWinner.kind,
      selector: newWinner.selector,
      ...(existing.pinned_choice?.label !== undefined
        ? { label: existing.pinned_choice.label }
        : {}),
    };
  }
  return { target: merged, winnerChanged };
}
