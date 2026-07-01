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
// LockTarget — one resolved step's recipe + match gate + bookkeeping
// ---------------------------------------------------------------------------

/**
 * One `[[targets]]` entry: the learned recipe for a single flow step, gated by `match`.
 *
 *  - `step`          — the flow step id this target is keyed by (unique within a lock file).
 *  - `target`        — the step's NL target (for human-readability / re-derivation context).
 *  - `kind`          — `'ai_pick'` for an AI-pick target carrying `pinned_choice` (Phase 4 fills
 *                      the pin/replay logic; Phase 3 keeps the field round-tripping). Absent for
 *                      ordinary deterministic targets.
 *  - `match`         — the `{ url_glob, sig }` trust gate L0 validates before replay.
 *  - `selector`      — the WINNING recipe's selector (re-resolvable; never `ref:eN`).
 *  - `strategy`      — the winning recipe's strategy. (`selector` + `strategy` are present
 *                      together for a resolved deterministic target.)
 *  - `candidates`    — ranked fallbacks, most-proven first.
 *  - `pinned_choice` — the pinned AI-pick recipe (+ optional `label`), replayed deterministically
 *                      on later runs. Only meaningful for `kind:'ai_pick'`.
 *  - `green_runs`    — how many times the WINNING recipe has resolved green (bumped on a repeat
 *                      green; reset to 1 when a new winner is promoted).
 *  - `last_seen`     — ISO-8601 timestamp of the last green resolution (injected clock — see
 *                      `./recipe.ts`; deterministic in tests).
 */
export interface LockTarget {
  step: string;
  target: string;
  kind?: "ai_pick";
  match: LockMatch;
  selector?: string;
  strategy?: Strategy;
  candidates?: LockCandidate[];
  pinned_choice?: LockPinnedChoice;
  green_runs?: number;
  last_seen?: string;
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

/** The current lock-format version written by this module. */
export const LOCK_VERSION = 1;
