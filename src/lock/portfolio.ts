// Flightplan — the learned strategy PORTFOLIO (the "selector playbook", DESIGN §3).
//
// A lock target no longer stores ONE winning selector plus a whole-page gate; it stores a RANKED
// PORTFOLIO of every strategy that has successfully found the element, each with a per-strategy
// track record (`greens` / `last_ok` / `last_drift`). This module owns everything about that
// portfolio EXCEPT the on-disk shape (that is `types.ts`) and the snapshot race (that is the
// ladder's `revalidate.ts`):
//
//   1. NORMALIZATION — `normalizeTarget` / `normalizeLock` migrate a v1 single-winner lock (winner
//      + candidates + green_runs) into a v2 portfolio, invoked on lock LOAD (`parse.ts`). Old
//      committed locks (e.g. `examples/flows/wizard.lock.toml`) load unchanged and self-migrate.
//   2. SCORING + RANKING — `scoreEntry` is the DETERMINISTIC recency-weighted success score;
//      `rankPortfolio` sorts a portfolio by it (ties broken by a fixed strategy-kind priority) so a
//      committed lock re-orders deterministically across runs.
//   3. DECAY / PRUNE — `rankPortfolio` demotes drift-capped + stale entries below fresh ones and
//      caps the portfolio at `K_MAX`, dropping the lowest-scored.
//   4. TRACK-RECORD UPDATES — `applyOutcome` bumps `greens`/`last_ok` on the strategies that
//      agreed/won and stamps `last_drift` on the ones that resolved wrong or failed to resolve.
//
// EVERYTHING here is PURE (no `Date`/`Math.random`): timestamps flow in as ISO strings / a `now`
// number so tests are deterministic and committed diffs are stable.

import type { Strategy } from "../types.ts";
import {
  LOCK_VERSION,
  type LockCandidate,
  type LockTarget,
  NOTE_TTL_DAYS,
  type StrategyEntry,
  type TargetMemory,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Tunable constants (DESIGN §9 "Portfolio K and decay window")
// ---------------------------------------------------------------------------

/**
 * The maximum number of strategies a target's portfolio retains. On write the portfolio is ranked
 * and capped to this many, dropping the lowest-scored — a target that has drifted through many
 * selectors does not grow without bound. Chosen at 6: enough to cover testid + role_name + label +
 * scoped_text + structural + one spare, which is the full deterministic ladder plus a fallback.
 */
export const K_MAX = 6;

/**
 * The recency HALF-LIFE (in days) for the exponential recency weight in {@link scoreEntry}. A green
 * this many days old contributes half the weight of a green today. 30 days ≈ "a strategy proven a
 * month ago is worth half a fresh one" — long enough that a healthy weekly-run flow never decays,
 * short enough that a year-stale selector sinks below fresh L1 candidates. See DESIGN §3.3 "decay".
 */
export const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * The staleness WINDOW (in days): an entry whose last green is older than this — with no offsetting
 * recent activity — is considered stale and demoted below fresher entries (its recency weight has
 * decayed to near zero by construction, but the window makes the "not green within a window" prune
 * from DESIGN §3.3 explicit and testable). 90 days = three half-lives (weight ≈ 0.125).
 */
export const STALE_WINDOW_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Overridable portfolio tuning (optional, from `[cache]` config — additive, all default above). */
export interface PortfolioOptions {
  kMax?: number;
  recencyHalfLifeDays?: number;
}

// ---------------------------------------------------------------------------
// Strategy-kind priority (deterministic tie-breaker)
// ---------------------------------------------------------------------------

/**
 * The fixed strategy-kind priority used to break score ties (DESIGN §3.2): testid > role_name >
 * label > scoped_text > css > structural_fingerprint. Lower number = higher priority. This is the
 * durability order — a `testid` is the most stable identity, a structural fingerprint the least —
 * so when two strategies are equally proven we prefer the more durable one, deterministically.
 */
const KIND_PRIORITY: Record<Strategy, number> = {
  testid: 0,
  role_name: 1,
  label: 2,
  scoped_text: 3,
  css: 4,
  structural_fingerprint: 5,
};

// ---------------------------------------------------------------------------
// Scoring — the DETERMINISTIC recency-weighted success score
// ---------------------------------------------------------------------------

/**
 * The deterministic recency-weighted success score for a portfolio entry. Formula:
 *
 *     score = greens * 2^(-ageDays / halfLife)     [recency-decayed track record]
 *     if last_drift is NEWER than last_ok:  score *= DRIFT_PENALTY   (0.1)
 *     if never green (no last_ok):          ageDays = 0  → weight 1  → score = greens (usually 0)
 *
 * where `ageDays` is the wall-clock age of `last_ok` relative to `now`. The exponential factor
 * halves the contribution every {@link RECENCY_HALF_LIFE_DAYS}, so a long-proven-but-now-stale
 * strategy decays below a freshly-green one WITHOUT deleting its history. A `last_drift` stamp
 * newer than the last green caps the entry (DESIGN §3.3 "drift resets confidence") regardless of
 * how many historical greens it has — a drifting strategy cannot float back to the top on legacy
 * greens alone; it must earn a fresh `last_ok` first. Pure: same inputs → same score.
 */
export function scoreEntry(
  entry: StrategyEntry,
  now: number,
  halfLifeDays: number = RECENCY_HALF_LIFE_DAYS,
): number {
  const greens = entry.greens > 0 ? entry.greens : 0;
  const lastOk = entry.last_ok ? Date.parse(entry.last_ok) : Number.NaN;
  const ageDays = Number.isNaN(lastOk) ? 0 : Math.max(0, (now - lastOk) / MS_PER_DAY);
  const recency = 2 ** (-ageDays / halfLifeDays);
  let score = greens * recency;
  if (isDriftCapped(entry)) score *= DRIFT_PENALTY;
  return score;
}

/** The multiplicative penalty applied to a drift-capped entry's score. */
const DRIFT_PENALTY = 0.1;

/**
 * Is this entry drift-capped — a `last_drift` at least as new as `last_ok` (or with no `last_ok`)?
 * A drift stamped in the SAME run as (or after) the last green caps the entry: a strategy that just
 * resolved to the wrong element must not out-rank a fresh winner on legacy greens (DESIGN §3.3).
 */
export function isDriftCapped(entry: StrategyEntry): boolean {
  if (!entry.last_drift) return false;
  const drift = Date.parse(entry.last_drift);
  if (Number.isNaN(drift)) return false;
  const ok = entry.last_ok ? Date.parse(entry.last_ok) : Number.NaN;
  return Number.isNaN(ok) || drift >= ok;
}

/** Is this entry STALE — no green within the {@link STALE_WINDOW_DAYS} window? */
export function isStale(entry: StrategyEntry, now: number): boolean {
  if (!entry.last_ok) return true; // never green → stale by construction
  const ok = Date.parse(entry.last_ok);
  if (Number.isNaN(ok)) return true;
  return now - ok > STALE_WINDOW_DAYS * MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Note decay (the advisory "note-to-future-self", DESIGN §4)
// ---------------------------------------------------------------------------

/**
 * Is a target's advisory note STALE — its `note_updated` older than {@link NOTE_TTL_DAYS} (or
 * missing/unparseable)? A stale note is neither fed back into an AI prompt nor kept on the next
 * write (deterministic, driven by the injected `now`). A note with no timestamp is treated as stale
 * (we cannot vouch for its freshness), so an old lock's untimestamped note never leaks forward.
 */
export function isNoteStale(memory: TargetMemory | undefined, now: number): boolean {
  if (!memory?.note) return true;
  if (!memory.note_updated) return true;
  const updated = Date.parse(memory.note_updated);
  if (Number.isNaN(updated)) return true;
  return now - updated > NOTE_TTL_DAYS * MS_PER_DAY;
}

/**
 * The target's FRESH advisory note (the note to feed into an AI prompt as `note_in`), or `undefined`
 * when there is no note or it has decayed past {@link NOTE_TTL_DAYS}. Pure (staleness relative to
 * the injected `now`).
 */
export function activeNote(target: LockTarget, now: number): string | undefined {
  if (isNoteStale(target.memory, now)) return undefined;
  return target.memory?.note;
}

// ---------------------------------------------------------------------------
// Ranking + decay/prune
// ---------------------------------------------------------------------------

/**
 * Rank a portfolio by the recency-weighted score DESC, applying decay + prune (DESIGN §3.2/§3.3):
 *
 *   - Sort by {@link scoreEntry} descending (most-proven-and-recent first).
 *   - Ties broken by: fresh (non-stale) before stale, then the fixed {@link KIND_PRIORITY}, then
 *     `selector` ascending — fully deterministic so a committed lock re-orders reproducibly.
 *   - Cap at `kMax` (default {@link K_MAX}), dropping the lowest-scored entries.
 *
 * Does not mutate the input. Returns a NEW ranked, capped array.
 */
export function rankPortfolio(
  strategies: readonly StrategyEntry[],
  now: number,
  opts: PortfolioOptions = {},
): StrategyEntry[] {
  const halfLife = opts.recencyHalfLifeDays ?? RECENCY_HALF_LIFE_DAYS;
  const kMax = opts.kMax ?? K_MAX;
  const scored = strategies.map((e) => ({ e, score: scoreEntry(e, now, halfLife) }));
  scored.sort((a, b) => {
    // A drift-capped entry ALWAYS sinks below a non-capped one — even when recency has decayed
    // every score toward zero, a strategy that drifted must never out-rank one that did not on the
    // alphabetical tie-break alone (DESIGN §3.3 "drift resets confidence"). This dominates score.
    const driftA = isDriftCapped(a.e);
    const driftB = isDriftCapped(b.e);
    if (driftA !== driftB) return driftA ? 1 : -1;
    if (a.score !== b.score) return b.score - a.score;
    // Tie: a stale entry sinks below a fresh one (decay/prune).
    const staleA = isStale(a.e, now);
    const staleB = isStale(b.e, now);
    if (staleA !== staleB) return staleA ? 1 : -1;
    const pa = KIND_PRIORITY[a.e.kind];
    const pb = KIND_PRIORITY[b.e.kind];
    if (pa !== pb) return pa - pb;
    return a.e.selector < b.e.selector ? -1 : a.e.selector > b.e.selector ? 1 : 0;
  });
  return scored.slice(0, kMax).map((s) => s.e);
}

// ---------------------------------------------------------------------------
// Normalization / v1 → v2 migration (invoked on lock LOAD)
// ---------------------------------------------------------------------------

/**
 * Normalize ONE target into the v2 portfolio shape. Idempotent:
 *
 *   - A target that already has `strategies` is left as-is (aside from dropping stray v1 fields).
 *   - A v1 target (`strategy`+`selector` [+`candidates`] [+`green_runs`]) is MIGRATED: the winner
 *     becomes the first strategy carrying its `green_runs`→`greens` and `last_seen`→`last_ok`; each
 *     candidate becomes a further strategy (candidates have no per-strategy track record in v1, so
 *     they seed at `greens:0` with no `last_ok`). The result is ranked so the migrated winner leads.
 *   - An `ai_pick` target with only a `pinned_choice` seeds a single-entry portfolio from the pin.
 *
 * The v1 fields are STRIPPED from the returned target so the migrated lock re-serializes in pure v2
 * form (no dual shape on disk). Does not mutate the input.
 */
export function normalizeTarget(target: LockTarget, now: number): LockTarget {
  const alreadyPortfolio = Array.isArray(target.strategies);

  const entries: StrategyEntry[] = alreadyPortfolio
    ? [...(target.strategies ?? [])]
    : migrateV1Entries(target, now);

  const ranked = rankPortfolio(dedupeEntries(entries), now);

  const normalized: LockTarget = {
    step: target.step,
    target: target.target,
    match: { url_glob: target.match.url_glob, sig: target.match.sig },
    strategies: ranked,
  };
  if (target.kind !== undefined) normalized.kind = target.kind;
  if (target.pinned_choice !== undefined) normalized.pinned_choice = target.pinned_choice;
  // Carry the advisory memory forward, but DROP a stale note (decay is applied on load so a
  // decayed note never re-serializes nor reaches a prompt). A note-less memory is dropped entirely.
  const memory = normalizeMemory(target.memory, now);
  if (memory !== undefined) normalized.memory = memory;
  if (target.last_seen !== undefined) normalized.last_seen = target.last_seen;
  return normalized;
}

/**
 * Normalize a target's advisory {@link TargetMemory} on load: DROP a stale/empty note (decay,
 * DESIGN §4) and return `undefined` when nothing worth keeping remains, so a decayed note neither
 * re-serializes nor feeds a prompt. Does not mutate the input.
 */
export function normalizeMemory(
  memory: TargetMemory | undefined,
  now: number,
): TargetMemory | undefined {
  if (isNoteStale(memory, now)) return undefined;
  const note = memory?.note;
  if (note === undefined || note.length === 0) return undefined;
  const out: TargetMemory = { note };
  if (memory?.note_updated !== undefined) out.note_updated = memory.note_updated;
  return out;
}

/** Migrate a v1 target's winner + candidates (+ pin) into un-ranked v2 strategy entries. */
function migrateV1Entries(target: LockTarget, _now: number): StrategyEntry[] {
  const entries: StrategyEntry[] = [];
  // The v1 winner → first strategy, carrying its accumulated track record.
  if (target.selector !== undefined && target.strategy !== undefined) {
    const winner: StrategyEntry = {
      kind: target.strategy,
      selector: target.selector,
      greens: target.green_runs ?? 1,
    };
    if (target.last_seen !== undefined) winner.last_ok = target.last_seen;
    entries.push(winner);
  } else if (target.pinned_choice) {
    // ai_pick with only a pin → seed from the pin.
    const pin = target.pinned_choice;
    const winner: StrategyEntry = {
      kind: pin.strategy,
      selector: pin.selector,
      greens: pin.green_runs ?? 1,
    };
    if (target.last_seen !== undefined) winner.last_ok = target.last_seen;
    entries.push(winner);
  }
  // v1 candidates → further strategies (no per-candidate track record existed → seed greens:0).
  for (const c of target.candidates ?? []) {
    entries.push({ kind: c.strategy, selector: c.selector, greens: c.green_runs ?? 0 });
  }
  return entries;
}

/**
 * Normalize a whole lock (v1 → v2 migration on load): bump `version` to {@link LOCK_VERSION} and
 * normalize every target into the portfolio shape. So a migrated lock, once re-serialized, is a
 * pure v2 document (version bumped, `strategies` populated, v1 fields gone). Does not mutate input.
 */
export function normalizeLock<T extends { version: number; targets: LockTarget[] }>(
  lock: T,
  now: number,
): T {
  return {
    ...lock,
    version: LOCK_VERSION,
    targets: lock.targets.map((t) => normalizeTarget(t, now)),
  };
}

// ---------------------------------------------------------------------------
// De-dup (a portfolio never carries two entries for the same selector)
// ---------------------------------------------------------------------------

/** A stable identity key for a strategy entry (kind + selector). */
function entryKey(e: { kind: Strategy; selector: string }): string {
  return `${e.kind} ${e.selector}`;
}

/**
 * De-duplicate entries by (kind, selector), merging track records: max `greens`, latest `last_ok`,
 * latest `last_drift`. Keeps the FIRST occurrence's position for determinism (callers rank after).
 */
export function dedupeEntries(entries: readonly StrategyEntry[]): StrategyEntry[] {
  const byKey = new Map<string, StrategyEntry>();
  for (const e of entries) {
    const key = entryKey(e);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...e });
      continue;
    }
    prev.greens = Math.max(prev.greens, e.greens);
    prev.last_ok = laterIso(prev.last_ok, e.last_ok);
    prev.last_drift = laterIso(prev.last_drift, e.last_drift);
  }
  // Drop undefined optionals so they round-trip as absent.
  return [...byKey.values()].map((e) => {
    const out: StrategyEntry = { kind: e.kind, selector: e.selector, greens: e.greens };
    if (e.last_ok !== undefined) out.last_ok = e.last_ok;
    if (e.last_drift !== undefined) out.last_drift = e.last_drift;
    return out;
  });
}

/** The later of two optional ISO timestamps (undefined if both absent). */
function laterIso(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Track-record updates (applied after a resolution outcome)
// ---------------------------------------------------------------------------

/**
 * The per-strategy verdict of ONE resolution: which selectors AGREED/WON (bump greens + last_ok),
 * and which DRIFTED — resolved to the wrong element or failed to resolve while the target still
 * resolved another way (stamp last_drift). Selectors are matched by their (kind, selector) identity.
 */
export interface PortfolioOutcome {
  /** Selectors that resolved to the winning element (or the sole/majority element) → greens+1. */
  agreed: ReadonlyArray<{ kind: Strategy; selector: string }>;
  /** Selectors that resolved to a DIFFERENT element or did not resolve → last_drift stamped. */
  drifted: ReadonlyArray<{ kind: Strategy; selector: string }>;
  /**
   * A freshly-learned winning selector NOT already in the portfolio (e.g. an L1 rebuild after a
   * clean miss). Added as a new entry (greens:1, last_ok:now) then ranked in.
   */
  learned?: ReadonlyArray<{ kind: Strategy; selector: string }>;
}

/**
 * Fold a resolution outcome into a portfolio and re-rank (DESIGN §3 track-record updates). Pure:
 *
 *   - `agreed` entries: `greens`+1, `last_ok` = now.
 *   - `drifted` entries: `last_drift` = now (their score is then drift-capped by `scoreEntry`).
 *   - `learned` selectors not already present: appended as fresh entries (greens:1, last_ok:now).
 *   - The result is de-duped, ranked, and capped at `kMax`.
 *
 * Returns a NEW portfolio (does not mutate the input entries).
 */
export function applyOutcome(
  strategies: readonly StrategyEntry[],
  outcome: PortfolioOutcome,
  now: number,
  opts: PortfolioOptions = {},
): StrategyEntry[] {
  const nowIso = new Date(now).toISOString();
  const agreed = new Set(outcome.agreed.map(entryKey));
  const drifted = new Set(outcome.drifted.map(entryKey));

  const next: StrategyEntry[] = strategies.map((e) => {
    const key = entryKey(e);
    if (agreed.has(key)) {
      return { ...e, greens: e.greens + 1, last_ok: nowIso };
    }
    if (drifted.has(key)) {
      return { ...e, last_drift: nowIso };
    }
    return { ...e };
  });

  const present = new Set(next.map(entryKey));
  for (const l of outcome.learned ?? []) {
    if (present.has(entryKey(l))) continue;
    next.push({ kind: l.kind, selector: l.selector, greens: 1, last_ok: nowIso });
    present.add(entryKey(l));
  }

  return rankPortfolio(dedupeEntries(next), now, opts);
}

// ---------------------------------------------------------------------------
// Projection helpers (portfolio ↔ v1-style candidate list, for L0 replay)
// ---------------------------------------------------------------------------

/** The ranked portfolio's winner (top entry), or undefined for an empty portfolio. */
export function portfolioWinner(target: LockTarget): StrategyEntry | undefined {
  return target.strategies?.[0];
}

/** Project a portfolio's non-winner entries to v1-style ranked candidates (for L0 replay batch). */
export function portfolioToCandidates(strategies: readonly StrategyEntry[]): LockCandidate[] {
  return strategies.slice(1).map((e) => ({ strategy: e.kind, selector: e.selector }));
}
