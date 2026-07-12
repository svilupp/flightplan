// Flightplan — the ON-DISK lock-file format (committed per-flow artifact).
//
// These types describe the TOML lock file VERBATIM per PLAN.md §4 ("Lock"). They are kept
// deliberately DISTINCT from the ladder's in-memory `CachedRecipe` (`src/ladder/types.ts`):
// the on-disk shape carries bookkeeping (`green_runs`, `last_seen`, `pinned_choice`, provenance
// at compose time) that the runtime cache does not, and the runtime cache is a recursive
// `selector/strategy/match/candidates` tree. The converters in `./recipe.ts` translate between
// the two; nothing else should construct a `CachedRecipe` from a `LockTarget` directly.
//
// The lock is a COMMITTED artifact: it stores learned, re-resolvable selector recipes per flow
// step, keyed by `step` id, gated by `match { url_glob, sig }`. It is strictly 1:1 file↔lock on
// disk; multi-module composition happens only at runtime (see `./compose.ts`).
//
// Canonical references: PLAN.md §4 (the `LockFile`/`LockTarget`/`Recipe` shapes + the `sig`
// composite), §5 Phase 3 (read/compose/write + signatures + write policy).

import type { Strategy } from "../types.ts";

// ---------------------------------------------------------------------------
// LockMatch — the trust gate L0 validates before replaying a recipe
// ---------------------------------------------------------------------------

/**
 * The `match` gate stored on every target. L0 validates BOTH fields against the current page
 * before trusting (replaying) the recipe; a mismatch on either forces escalation to L1.
 *
 *  - `url_glob` — an anchored glob (only `*` wildcard) the current URL must match. See
 *    `urlGlobMatches` in `./signature.ts`.
 *  - `sig` — the COMPOSITE page signature: the driver's text-hash `captureStateSignature`
 *    result combined with Flightplan's structural-skeleton hash. The exact composite format is
 *    defined + documented in `./signature.ts` (`computeMatchSignature`):
 *      `"text:<url>|<texthash>;struct:<urlPath>|<structhash>"`.
 */
export interface LockMatch {
  url_glob: string;
  sig: string;
}

// ---------------------------------------------------------------------------
// LockCandidate — one ranked fallback recipe under a target
// ---------------------------------------------------------------------------

/**
 * A ranked fallback recipe (the on-disk projection of `Recipe & { green_runs? }` from PLAN.md
 * §4). Candidates are tried in order if the winning recipe fails; they are kept sorted
 * `green_runs` desc then `strategy` for minimal committed diffs (see `./write.ts`).
 *
 *  - `strategy` — the stored selector strategy (`role_name`/`label`/…). Never derived from a ref.
 *  - `selector` — a RE-RESOLVABLE selector string. NEVER a bare `ref:eN` (enforced in
 *    `./recipe.ts` via `assertDurableSelector`).
 *  - `green_runs` — how many times this candidate has resolved+acted green (most-proven first).
 */
export interface LockCandidate {
  strategy: Strategy;
  selector: string;
  green_runs?: number;
}

// ---------------------------------------------------------------------------
// StrategyEntry — one member of a target's learned strategy PORTFOLIO (v2)
// ---------------------------------------------------------------------------

/**
 * One member of a target's ranked strategy PORTFOLIO (the "learned selector playbook", DESIGN
 * §3). A portfolio replaces the v1 single-winner `{ strategy + selector + candidates }` shape: the
 * target now remembers EVERY way it has successfully found an element, each carrying its own track
 * record, and self-orders by a deterministic recency-weighted score (see `./portfolio.ts`). The
 * top-ranked entry is "the winner"; the rest are ranked fallbacks the L0 portfolio race tries over
 * the SAME snapshot.
 *
 *  - `kind`      — the selector strategy (`testid`/`role_name`/`label`/`scoped_text`/
 *                  `structural_fingerprint`/`css`). Same enum as the v1 `strategy` field.
 *  - `selector`  — the RE-RESOLVABLE selector string (never a bare `ref:eN`).
 *  - `greens`    — how many times THIS strategy has resolved+acted green (its track record).
 *  - `last_ok`   — ISO-8601 timestamp of the last green resolution via this strategy (drives the
 *                  recency weight). Absent for a never-yet-green entry (e.g. a fresh candidate).
 *  - `last_drift`— ISO-8601 timestamp of the last time this strategy DRIFTED (resolved to the
 *                  wrong element or failed to resolve while the target still resolved another way).
 *                  A `last_drift` newer than `last_ok` caps the entry's effective rank (DESIGN §3.3
 *                  "drift resets confidence").
 */
export interface StrategyEntry {
  kind: Strategy;
  selector: string;
  greens: number;
  last_ok?: string;
  last_drift?: string;
}

// ---------------------------------------------------------------------------
// TargetMemory — advisory "note-to-future-self" for the AI tiers (DESIGN §4)
// ---------------------------------------------------------------------------

/**
 * The advisory MEMORY block for a target (the `[targets.memory]` sub-table, DESIGN §3.1/§4). It is
 * NOT part of the durable WHAT (the step `intent`) nor the disposable HOW (the `strategies`
 * portfolio) — it is a sparse, freeform "note-to-future-self" that ONLY matters when an AI tier
 * (L2/L3) already runs:
 *
 *   - On INPUT, a fresh (non-stale) `note` is prepended to the resolver/vision prompt as extra
 *     context ("last time: icon-only toolbar, floppy-disk glyph top-right, no testid") so the model
 *     spends fewer tokens rediscovering the page.
 *   - On OUTPUT, the model MAY emit an updated note (structured output), which is REDACTED then
 *     persisted here in `auto` mode.
 *
 * The note is advisory only: it NEVER gates correctness (assertions stay authoritative), NEVER
 * changes tier routing (the prescribed L0→L1 path always runs first), and DECAYS — a note older
 * than {@link NOTE_TTL_DAYS} is not fed back into prompts and is dropped on the next write.
 *
 *  - `note`         — the sparse freeform diagnostic prose (never a selector or a routing directive).
 *                     Already REDACTED before it reaches disk (secrets/PII masked; see the session).
 *  - `note_updated` — ISO-8601 timestamp of when the note was last (re)written (drives staleness).
 */
export interface TargetMemory {
  note?: string;
  note_updated?: string;
}

/**
 * The staleness WINDOW (in days) for an advisory `note`. A note whose `note_updated` is older than
 * this is considered stale: it is NOT fed back into an AI prompt and is dropped on the next lock
 * write. Mirrors the portfolio's decay notion (`STALE_WINDOW_DAYS` in `./portfolio.ts`) — a note is
 * cheaper to re-derive than a selector, and a months-old hint about a since-redesigned page is more
 * likely to mislead than help, so notes decay a touch faster than the 90-day strategy window.
 */
export const NOTE_TTL_DAYS = 45;

// ---------------------------------------------------------------------------
// LockTarget — one resolved step's portfolio + match gate + bookkeeping
// ---------------------------------------------------------------------------

/**
 * One `[[targets]]` entry: the learned strategy PORTFOLIO for a single flow step, gated by `match`.
 *
 *  - `step`          — the flow step id this target is keyed by (unique within a lock file).
 *  - `target`        — the step's NL target (for human-readability / re-derivation context).
 *  - `kind`          — `'ai_pick'` for an AI-pick target carrying `pinned_choice` (Phase 4 fills
 *                      the pin/replay logic; Phase 3 keeps the field round-tripping). Absent for
 *                      ordinary deterministic targets.
 *  - `match`         — the `{ url_glob, sig }` trust gate L0 validates before replay.
 *  - `strategies`    — the ranked strategy portfolio (v2). Self-ordered by the deterministic
 *                      recency-weighted score (`./portfolio.ts`); the top entry is the winner. A
 *                      loaded v1 lock is normalized into this shape (`normalizeTarget`).
 *  - `pinned_choice` — the pinned AI-pick recipe (+ optional `label`), replayed deterministically
 *                      on later runs. Only meaningful for `kind:'ai_pick'`.
 *  - `memory`        — the advisory {@link TargetMemory} block (the AI-step `note`). Optional +
 *                      decayed; consulted by L2/L3 on input, (re)written by them on output. Never
 *                      affects routing or correctness (DESIGN §4).
 *  - `last_seen`     — ISO-8601 timestamp of the last green resolution of the target as a whole
 *                      (injected clock — deterministic in tests). Kept for at-a-glance diffs.
 *
 * The v1 fields (`selector`/`strategy`/`candidates`/`green_runs`) are RETAINED as optional so an
 * old lock round-trips losslessly through the parser BEFORE normalization; after `normalizeTarget`
 * they are gone and only `strategies` carries the HOW. New writes never emit them.
 */
export interface LockTarget {
  step: string;
  target: string;
  kind?: "ai_pick";
  match: LockMatch;
  strategies?: StrategyEntry[];
  pinned_choice?: LockPinnedChoice;
  memory?: TargetMemory;
  last_seen?: string;
  // --- v1 (pre-portfolio) fields — accepted on load for migration, never written by v2 ---
  selector?: string;
  strategy?: Strategy;
  candidates?: LockCandidate[];
  green_runs?: number;
}

/**
 * The pinned AI-pick recipe (PLAN.md §4 `pinned_choice = Recipe & { label? }`). Structurally a
 * candidate plus an optional human label naming the chosen option. Phase 4 owns pin/replay; here
 * it just round-trips without loss.
 */
export interface LockPinnedChoice {
  strategy: Strategy;
  selector: string;
  green_runs?: number;
  label?: string;
}

// ---------------------------------------------------------------------------
// LockFile — the whole document (header + targets)
// ---------------------------------------------------------------------------

/**
 * The whole committed lock document.
 *
 *  - `version`     — lock-format version (currently {@link LOCK_VERSION}).
 *  - `source`      — the flow file this lock belongs to (path/id recorded by the writer).
 *  - `source_hash` — the flow's `source_hash` (`sha256:<hex>`, from `flow/load.ts`); a mismatch
 *                    is the lint-time "lock stale vs source" warning (PLAN.md §5 Phase 1).
 *  - `description` — human description (mirrors the flow's, for at-a-glance committed diffs).
 *  - `targets`     — the per-step recipes. Kept sorted by `step` on write for stable diffs.
 */
export interface LockFile {
  version: number;
  source: string;
  source_hash: string;
  description: string;
  targets: LockTarget[];
}

/**
 * The current lock-format version written by this module. Bumped 1 → 2 for the strategy-portfolio
 * evolution (DESIGN §3): the single-winner `{ strategy + selector + candidates + green_runs }`
 * shape became a ranked `strategies[]` portfolio with per-strategy track records. A v1 lock still
 * LOADS (the parser accepts the old fields) and is auto-migrated on load (`normalizeLock`).
 */
export const LOCK_VERSION = 2;
