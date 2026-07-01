// Flightplan — the ladder resolution/execution contract.
//
// This module defines the result of RESOLVING + EXECUTING a single flow step through the
// L0–L4 escalation ladder, plus the orchestration interface the runner programs against.
// Canonical references: PLAN.md §2 (ladder module map), §3 (driver boundary), §4 (the
// `Strategy` enum + `selectorUsed`→Strategy table), §5 Phase 2 (L0/L1 deliverables), §7
// (cost ladder + own fuzzy match), §8 risks #7/#8/#11.
//
// =========================================================================================
// The L1 coupling principle (PLAN.md §7 "Parallel L1 strategies")
// =========================================================================================
// At L1, RESOLUTION and ACTION are coupled: Flightplan takes exactly ONE `snapshot()`, builds
// an ORDERED array of candidate selector strings (the strategy ladder), and passes that array
// to `driver.batch(...)` / a single action. browser-pilot resolves ref-first then walks the
// ordered fallbacks in-process and reports which one won via `StepResult.selectorUsed`. The
// act of acting IS the resolution — there is no separate "resolve then act" round-trip. We
// then map `selectorUsed` → `Strategy` (via `selectorUsedToStrategy`) to learn which strategy
// carried the step, and derive a durable (re-resolvable, never `ref:eN`) selector for the lock.
//
// =========================================================================================
// Enriched snapshots (browser-pilot 0.1.0, Phase 7 Change 3a) — the full strategy ladder
// =========================================================================================
// Ladder snapshots are taken with `snapshot({ attributes: true })`, so each
// `interactiveElement` carries real DOM attributes (`data-testid`/`data-test`/`data-qa`/
// `id`/`class`/`name`/`type`, plus `aria-label`/`placeholder`). The `testid` and `label`
// rungs are derived directly from those attributes (see `src/ladder/strategy-array.ts`), so
// `testid` sorts to the top of the ladder whenever the element carries one. `role_name`,
// `scoped_text`, and `structural_fingerprint` (built from role + accessible name) cover the
// rest. Candidate RANKING is delegated to the driver's native `resolveAll` (browser-pilot's
// L1 race over the same shared snapshot); the ladder builds the durable selector array for
// the chosen element and learns the winning strategy from `StepResult.selectorUsed`.

import type { Step } from "../flow/types.ts";
import type { AdvisoryVerdict, Strategy } from "../types.ts";
import type {
  BatchResult,
  CoveringElement,
  Driver,
  FailureReason,
  InteractiveElement,
  StepResult,
} from "../driver/index.ts";
import type { LadderTier } from "../artifacts/index.ts";

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

// `LadderTier` (`'L0'|'L1'|'L2'|'L3'|'L4'`) is owned by `artifacts/` as the cross-agent trace
// contract (so a `resolution_attempt` event and a `StepExecution` agree by construction). The
// ladder re-uses it rather than redefining it (avoids an `export *` collision in `src/index.ts`
// and keeps one source of truth):
//   L0 — locked-recipe replay (cache); free, synchronous (stub in Phase 2).
//   L1 — deterministic strategy race; free, synchronous (built in Phase 2).
//   L2 — resolver text model (Phase 4) · L3 — vision (Phase 4) · L4 — advisor (Phase 4).
export type { LadderTier } from "../artifacts/index.ts";

// ---------------------------------------------------------------------------
// RankedCandidate — Flightplan's OWN ranking from the snapshot
// ---------------------------------------------------------------------------

/**
 * One ranked candidate element. This is the unit of the L1 candidate list and the L2 handoff
 * `topMatches`. Ranking is produced by the driver's native `resolveAll` (browser-pilot's L1
 * race); this type is field-IDENTICAL to the driver's `RankedCandidate` (`src/driver/types.ts`)
 * so the ladder consumes native ranking with no adaptation.
 *
 *  - `ref`     — the snapshot ref (`eN`); valid ONLY within this resolve cycle, never persisted.
 *  - `role`    — accessibility role of the matched element.
 *  - `name`    — accessible name of the matched element.
 *  - `selector`— a candidate selector string for this element (a DURABLE strategy selector
 *                where one can be derived: `role:Role:Name`, `[aria-label=…]`, `text:…`, …; or
 *                the element's own synthetic selector as a last resort — see note below).
 *  - `strategy`— the `Strategy` this candidate's selector represents (what would be stored).
 *  - `score`   — 0..1 fuzzy score (1 = exact role+name match).
 */
export interface RankedCandidate {
  ref?: string;
  role: string;
  name: string;
  selector: string;
  strategy: Strategy;
  score: number;
}

// ---------------------------------------------------------------------------
// L2Handoff — the fuzzy-match packet handed to the (Phase-4) L2 resolver
// ---------------------------------------------------------------------------

/**
 * The handoff packet Flightplan builds when L1 fails or is ambiguous, consumed by the Phase-4
 * L2 text resolver. It is the result of Flightplan's OWN fuzzy match over snapshot
 * `interactiveElements` (NOT browser-pilot `hints[]`, which are empty for dash-y testids —
 * PLAN.md §8 risk #7 / FINDINGS §6) plus the cheap escalation signals from the StepResult.
 *
 *  - `intent`         — the step's NL intent (or target) fed to the resolver.
 *  - `action`         — the step verb (`click`/`fill`/…), so the resolver knows what to pick for.
 *  - `topMatches`     — the top fuzzy candidates (role + accessible name + a candidate selector
 *                       + score), ranked best-first. A compact projection of `RankedCandidate`.
 *  - `failureReason`  — the StepResult's structured failure category, if L1 acted and failed.
 *  - `coveringElement`— the blocking element when `failureReason === 'covered'`.
 */
export interface L2Handoff {
  intent?: string;
  action: BatchActionVerb;
  topMatches: Array<{ role: string; name: string; selector: string; score: number }>;
  failureReason?: FailureReason;
  coveringElement?: CoveringElement;
}

// ---------------------------------------------------------------------------
// StepExecution / Resolution — the result of resolving + executing a step
// ---------------------------------------------------------------------------

/**
 * The verb a resolved step maps onto when acting. A narrow subset of browser-pilot's
 * `ActionType` — the verbs the ladder actually drives for a targeted step. Matches the
 * `Driver` single-action method names.
 */
export type BatchActionVerb =
  | "click"
  | "fill"
  | "select"
  | "check"
  | "hover"
  | "press"
  | "submit";

/**
 * The result of resolving AND executing one step through the ladder (resolution and action are
 * coupled at L1 — see the file header). The runner consumes this to decide heal/assert/escalate
 * and to emit `resolution_attempt` trace events; the lock manager (Phase 3) consumes
 * `strategy`/`durableSelector`/`candidates` to write the recipe.
 *
 *  - `ok`             — did the step resolve AND act successfully at `tier`?
 *  - `tier`           — which tier produced this result (`L0`|`L1`|`L2`|`L3`|`L4`).
 *  - `selectorUsed`   — the raw browser-pilot `StepResult.selectorUsed` (which array entry won).
 *  - `strategy`       — the learned `Strategy` (via `selectorUsedToStrategy`). `null` when the
 *                       winner was a bare `ref:eN` (not a persistable strategy) — in that case
 *                       `durableSelector` is re-derived from the matched element (see below).
 *  - `durableSelector`— a RE-RESOLVABLE selector string for the lock recipe. NEVER a `ref:eN`
 *                       (PLAN.md §4 `Recipe.selector` invariant). When bp returns only a ref, the
 *                       L1 resolver re-derives a stable selector from the matched element's
 *                       role/name/etc. `undefined` when no durable selector could be derived.
 *  - `candidates`     — Flightplan's own ranked candidates from the snapshot (best-first). Feeds
 *                       the lock's ranked `candidates[]` and the L2 handoff.
 *  - `failureReason`  — cheap escalation signal from the StepResult (`covered`/`disabled`/…).
 *  - `coveringElement`— the blocking element when `failureReason === 'covered'`.
 *  - `handoff`        — the L2Handoff packet, attached when `escalate === true`.
 *  - `escalate`       — true when this tier could NOT resolve (or the match is ambiguous) and the
 *                       orchestrator should climb to the next tier (L2 in Phase 4).
 *  - `error`          — optional human-readable detail (e.g. the StepResult error).
 *  - `signatureBasis` — the PRE-ACTION page-signature basis for Phase-3 lock write-back: the
 *                       composite `match.sig` (`computeMatchSignature`) plus the page URL, both
 *                       captured from the snapshot the resolving tier worked against (L0 on a
 *                       validated hit, L1 on a successful resolve). The runner builds the lock
 *                       `match` gate from it (`url_glob` derived from `url`, `sig` verbatim) so a
 *                       healed recipe is stored against the page it was learned on — NEVER the
 *                       post-action page (a navigating click would otherwise capture the wrong
 *                       page). Undefined when the tier did not compute it (a clean escalation, a
 *                       non-resolving tier, or an AI tier in Phase 4).
 *  - `replayed`       — set by L0 when it VALIDATED a cached recipe and attempted the batch replay
 *                       before missing. The orchestrator reads it to decide L1's snapshot: a
 *                       replay-then-fail may have mutated the page, so L1 must take a FRESH
 *                       snapshot; a clean pre-replay L0 miss lets L1 REUSE the shared snapshot
 *                       (single-snapshot discipline). Absent on L1+/non-replaying L0 misses.
 */
export interface StepExecution {
  ok: boolean;
  tier: LadderTier;
  selectorUsed?: string;
  strategy?: Strategy | null;
  durableSelector?: string;
  candidates?: RankedCandidate[];
  failureReason?: FailureReason;
  coveringElement?: CoveringElement;
  handoff?: L2Handoff;
  escalate: boolean;
  error?: string;
  signatureBasis?: { sig: string; url: string };
  /** L0-only: true when a cached recipe was validated and its replay ran (see the field doc). */
  replayed?: boolean;
  /**
   * The TERMINAL advisor (L4) verdict, attached by `classifyL4` (Phase 4). Present only on an L4
   * result (`tier:'L4'`, `escalate:false`). The advisor never acts — it classifies — so this is
   * data the runner (Round 2) acts on (heal-write / proposed-patch / fail), never an action the
   * tier took. Additive: no existing field changes.
   */
  advisory?: AdvisoryVerdict;
  /**
   * The accessible NAME of the candidate an AI tier (L2/L3) chose, carried so the Round-2 runner
   * can forward it as `pinnedLabel` when persisting an `ai_pick` `pinned_choice` (PLAN.md §5
   * Phase 4 `ai_pick`; `lock/recipe.ts` `recipeFromExecution(..., {pinnedLabel})`). Set only by the
   * AI tiers on a successful pick; absent for L0/L1. Additive.
   */
  pinnedLabel?: string;
}

/** Alias: a `Resolution` IS a `StepExecution` (resolution and action are coupled). */
export type Resolution = StepExecution;

// ---------------------------------------------------------------------------
// L0 cache hooks (Phase 3 drops in the real lock manager behind these)
// ---------------------------------------------------------------------------

/**
 * A cached recipe the L0 tier would attempt to replay (Phase 3 lock manager fills these in).
 * Mirrors the relevant slice of `LockTarget` (PLAN.md §4) — a winning recipe plus the match
 * gate. In Phase 2 this is a forward-compat shape only; nothing populates it yet.
 */
export interface CachedRecipe {
  /** A re-resolvable selector string (never `ref:eN`). */
  selector: string;
  /** The strategy that selector represents. */
  strategy: Strategy;
  /** The match gate the lock validates before trusting the recipe (Phase 3 §4 `match`). */
  match?: { url_glob: string; sig: string };
  /** Ranked fallbacks to try if the winning recipe fails. */
  candidates?: CachedRecipe[];
}

/**
 * The L0 lock hook the orchestrator calls before L1. Phase 3 provides a real implementation
 * that reads the composed lock, validates `match.url_glob` + `match.sig` against the current
 * page, and returns a recipe to replay (or `undefined` for a miss). In Phase 2 it is absent or
 * always returns `undefined` (→ L0 miss → escalate to L1).
 */
export interface LockHook {
  /** Look up a cached recipe for this step. `undefined` (or absent hook) = cache miss. */
  lookup(step: Step, ctx: ResolveContext): Promise<CachedRecipe | undefined> | CachedRecipe | undefined;
}

// ---------------------------------------------------------------------------
// AI hooks (Phase 4 plugs L2/L3/L4 in behind these — stubbed in Phase 2)
// ---------------------------------------------------------------------------

/**
 * The AI-tier extension interface. Phase 4 supplies an implementation on `ctx.ai`; Phase 2
 * leaves it `undefined` so the orchestrator returns the failed L1 `StepExecution` with
 * `escalate:true` and the `L2Handoff` attached. The orchestrator NEVER imports `ai/` — it only
 * sees this interface — which is what lets Phase 4 wire the AI tiers in without touching the
 * orchestrator's core (PLAN.md §5 Phase 4 "wired into the orchestrator").
 *
 * Each hook receives the failed/ambiguous `StepExecution` (carrying the `handoff` packet) and
 * returns a fresh `StepExecution` for its tier (which may itself escalate further). All hooks
 * are optional: a host can wire only `resolveL2`, or all three.
 */
export interface AiHooks {
  /** L2 — resolver text model: consume the fuzzy `handoff`, pick a candidate, act. */
  resolveL2?(step: Step, prior: StepExecution, ctx: ResolveContext): Promise<StepExecution>;
  /** L3 — vision model: resolve from a screenshot when the resolver lost / asked for one. */
  resolveL3?(step: Step, prior: StepExecution, ctx: ResolveContext): Promise<StepExecution>;
  /** L4 — advisor: classify a persistent failure (`heal`|`bug`|`flake`|`intent_changed`). */
  classifyL4?(step: Step, prior: StepExecution, ctx: ResolveContext): Promise<StepExecution>;
}

// ---------------------------------------------------------------------------
// ResolveContext — what `resolveStep` needs to do its job
// ---------------------------------------------------------------------------

/**
 * Everything a single `resolveStep` call needs. The runner builds this per step.
 *  - `driver` — the `Driver` (real `BrowserPilotDriver` or `MockDriver`); the ONLY browser seam.
 *  - `lock`   — optional L0 lock hook (Phase 3). Absent in Phase 2 → L0 always misses.
 *  - `ai`     — optional AI hooks (Phase 4). Absent in Phase 2 → L1 escalation returns the
 *               failed StepExecution with the handoff attached.
 *  - `currentUrl` — the page URL, used by L0's `match.url_glob` gate (Phase 3) and for context.
 *  - `now`    — injectable clock for deterministic tests (defaults to `Date.now`).
 *  - `sleep`  — injectable delay (ms) for auto-repair's bounded waits (`disabled` poll / `missing`
 *               settle — see `repair.ts`). Defaults inside repair.ts to a real `setTimeout`-based
 *               sleep when unset, so the runner needs no change; a runner with a fake clock may set
 *               `ctx.sleep = (ms) => clock.sleep(ms)` for deterministic tests. Additive/optional.
 */
export interface ResolveContext {
  driver: Driver;
  lock?: LockHook;
  ai?: AiHooks;
  currentUrl?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Per-tier attempt record (for `resolution_attempt` trace events)
// ---------------------------------------------------------------------------

/**
 * One tier's attempt, recorded so the runner can emit a `resolution_attempt` trace event
 * (PLAN.md §5 Phase 2 artifacts; §7 explain UX). The ladder RETURNS these; it never writes
 * artifacts itself (the runner owns artifact emission).
 */
export interface ResolutionAttempt {
  tier: LadderTier;
  ok: boolean;
  escalated: boolean;
  selectorUsed?: string;
  strategy?: Strategy | null;
  failureReason?: FailureReason;
  /** Wall-clock duration of the attempt in ms (best-effort; 0 in pure-mock tests). */
  durationMs?: number;
  /** Short human note (e.g. "L0 miss: no cached recipe", "L1: role_name won"). */
  note?: string;
}

/**
 * The orchestrator's full return: the final `StepExecution` plus the ordered per-tier attempts
 * the runner emits as trace events. (The bare `StepExecution` is also returned from each tier
 * resolver; this wrapper is what `resolveStep` returns.)
 */
export interface LadderResult {
  execution: StepExecution;
  attempts: ResolutionAttempt[];
}

// ---------------------------------------------------------------------------
// The Ladder / Resolver orchestration interface
// ---------------------------------------------------------------------------

/**
 * The orchestration surface the runner programs against. `resolveStep` walks the ladder for one
 * (post-templating) step: try L0 (stub → miss) → L1; on L1 escalation, call the L2 hook if
 * present (Phase 4) else return the failed result with `escalate:true` + the handoff.
 */
export interface Ladder {
  resolveStep(step: Step, ctx: ResolveContext): Promise<LadderResult>;
}

// ---------------------------------------------------------------------------
// Internal helper shapes (shared by l1 / strategy-array / fuzzy)
// ---------------------------------------------------------------------------

/**
 * A built strategy candidate: an ordered selector-array entry plus the strategy it represents
 * and the snapshot element it came from. The L1 resolver builds an ordered list of these,
 * passes the `.selector`s to `driver.batch`, and uses the list to map `selectorUsed` back to a
 * `Strategy` + element (for `durableSelector` re-derivation).
 */
export interface StrategyCandidate {
  selector: string;
  strategy: Strategy;
  /** The snapshot element this candidate targets (undefined for author hints with no match). */
  element?: InteractiveElement;
}

/** A `BatchResult` whose first step result is the one the ladder reads. */
export type SingleStepBatch = BatchResult & { steps: [StepResult, ...StepResult[]] };
