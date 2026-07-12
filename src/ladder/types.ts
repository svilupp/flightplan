// Flightplan — the ladder resolution/execution contract.
//
// This module defines the result of RESOLVING + EXECUTING a single flow step through the
// L0–L4 escalation ladder, plus the orchestration interface the runner programs against.
// Canonical references: PLAN.md §2 (ladder module map), §3 (driver boundary), §4 (the
// `Strategy` enum + `selectorUsed`→Strategy table), §5 Phase 2 (L0/L1 deliverables), §7
// (cost ladder + own fuzzy match), §8 risks #7/#8/#11.
//
// =========================================================================================
// The L1 resolution/dispatch boundary (PLAN.md §7 "Parallel L1 strategies")
// =========================================================================================
// L1 takes exactly ONE `snapshot()`, ranks candidates, and builds an ORDERED array of selector
// strings (the strategy ladder). Ambiguity and other policy vetoes are evaluated before the
// shared dispatch owner makes the one `driver.batch(...)` call. On an approved dispatch,
// browser-pilot resolves ref-first and walks the ordered fallbacks in-process, reporting which
// one won via `StepResult.selectorUsed`; Flightplan then maps that to `Strategy` and derives a
// durable (re-resolvable, never `ref:eN`) selector for the lock. A dispatched or uncertain
// failure is terminal and cannot be replayed by another ladder tier.
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

import type { LadderTier } from "../artifacts/index.ts";
import type {
  ActionReceipt,
  BatchResult,
  CoveringElement,
  DispatchState,
  Driver,
  FailureReason,
  InteractiveElement,
  MatchedCondition,
  StepResult,
} from "../driver/index.ts";
import type { Step } from "../flow/types.ts";
import type { CacheOptions } from "../lock/signature.ts";
import type { StrategyEntry } from "../lock/types.ts";
import type { AdvisoryVerdict, Strategy } from "../types.ts";

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

/** A side-effect-free candidate proposal produced before a dispatch owner acts. */
export interface ResolvedTarget {
  selector: string;
  confidence: number;
  ambiguous: boolean;
  alternatives: RankedCandidate[];
  strategy?: Strategy;
  signatureBasis?: { url: string; sig: string };
}

// ---------------------------------------------------------------------------
// PortfolioExecOutcome — the L0 portfolio-race result carried on a StepExecution
// ---------------------------------------------------------------------------

/** One strategy's identity in a portfolio verdict (kind + selector). */
export interface PortfolioVerdict {
  kind: Strategy;
  selector: string;
}

/**
 * The portfolio-race outcome L0 attaches to a `StepExecution` (DESIGN §3.2), consumed by the lock
 * write-back to update per-strategy track records:
 *
 *  - `winner`    — the strategy that carried the replay (its selector floats to the top).
 *  - `agreed`    — strategies that resolved to the SAME winning element (bump `greens`+`last_ok`).
 *  - `drifted`   — strategies that resolved ELSEWHERE or went stale (stamp `last_drift`, demote).
 *  - `agreement` — human summary `"<agreeing>/<parseable>"` (e.g. `"3/4"`) for the trace.
 */
export interface PortfolioExecOutcome {
  winner: PortfolioVerdict;
  agreed: PortfolioVerdict[];
  drifted: PortfolioVerdict[];
  agreement: string;
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
export type BatchActionVerb = "click" | "fill" | "select" | "check" | "hover" | "press" | "submit";

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
  /** browser-pilot's effect-boundary classification, when the step was attempted or vetoed. */
  dispatchState?: DispatchState;
  /** Dynamic permission to repeat the browser action. Missing metadata is handled fail-closed. */
  retrySafe?: boolean;
  /** Conditions observed by browser-pilot while evaluating the step outcome. */
  matchedConditions?: MatchedCondition[];
  /** Number of executor/dispatch attempts reported for this logical step. */
  attempts?: number;
  /** browser-pilot's retry decision reason, when available. */
  retryDecisionReason?: string;
  /** Why the executor allowed or denied a retry. */
  retryReason?: string;
  /** The low-level browser-pilot receipt, when available. */
  receipt?: ActionReceipt;
  /** Flow-level effect contract copied into the accepted driver batch step. */
  effect?: "observe" | "idempotent" | "at_most_once";
  /** Natural-language target anchor copied into the accepted driver batch step. */
  anchor?: string;
  /** browser-pilot's outcome classification, when present. */
  outcomeStatus?: "success" | "failed" | "ambiguous" | "unsafe_to_retry";
  signatureBasis?: { sig: string; url: string };
  /** L0-only: true when a cached recipe was validated and its replay ran (see the field doc). */
  replayed?: boolean;
  /**
   * L0-only (L0 cache-hit quality — Layer 3): true when the page SIGNATURE did NOT match but the
   * cached recipe's selector still uniquely resolved the locked target against the fresh snapshot,
   * so the recipe was replayed as an L0 hit anyway (0 AI, no L2/L3 re-escalation). Distinguished
   * from a pure signature hit so metrics can count "revalidated" replays separately (the trace
   * carries an `l0_revalidated` note). Absent on a pure signature hit or any miss.
   */
  revalidated?: boolean;
  /**
   * The PORTFOLIO race outcome (DESIGN §3.2), attached by L0 when it resolved a step by racing the
   * remembered strategy portfolio over the shared snapshot. Carries the per-strategy verdicts
   * (which strategies agreed on the winning element, which drifted to a different element or went
   * stale) so the write-back path (`recordResolution` → `applyOutcome`) updates track records, plus
   * the human-readable `agreement` (`"3/4"`) + winning `kind` the trace surfaces. Absent on L1+ or
   * a hand-built recipe with no portfolio.
   */
  portfolio?: PortfolioExecOutcome;
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
  /**
   * The advisory note-to-future-self an AI tier (L2/L3) EMITTED via structured output (DESIGN §4).
   * Sparse — set only when the model returned a genuinely-useful `note`, on a successful pick. The
   * lock write-back REDACTS it (secrets/PII) then persists it into `[targets.memory]` in `auto`
   * mode. Advisory only: it never affects the verdict, routing, or which selector was chosen.
   * Absent for L0/L1 and whenever the model emitted no note.
   */
  note?: string;
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
  /** A re-resolvable selector string (never `ref:eN`). The portfolio winner's selector. */
  selector: string;
  /** The strategy that selector represents. */
  strategy: Strategy;
  /** The match gate the lock validates before trusting the recipe (Phase 3 §4 `match`). */
  match?: { url_glob: string; sig: string };
  /** Ranked fallbacks to try if the winning recipe fails. */
  candidates?: CachedRecipe[];
  /**
   * The full learned strategy PORTFOLIO for this target (DESIGN §3), carried so L0 can RACE it over
   * the shared snapshot (agreement/disagreement logic) and report per-strategy track-record updates
   * back to the write path. `selector`/`strategy`/`candidates` are the winner+fallbacks projection
   * of this same portfolio (for the replay batch). Absent on a hand-built test recipe.
   */
  strategies?: StrategyEntry[];
  /**
   * The target's FRESH advisory note (the "note-to-future-self", DESIGN §4), carried so an AI tier
   * (L2/L3) can prepend it to its prompt as extra context when it runs. Only a non-stale note is
   * surfaced here (the lock hook applies decay); a decayed/absent note is `undefined`. Advisory
   * only — it never affects L0 replay, routing, or correctness.
   */
  note?: string;
}

/**
 * The L0 lock hook the orchestrator calls before L1. Phase 3 provides a real implementation
 * that reads the composed lock, validates `match.url_glob` + `match.sig` against the current
 * page, and returns a recipe to replay (or `undefined` for a miss). In Phase 2 it is absent or
 * always returns `undefined` (→ L0 miss → escalate to L1).
 */
export interface LockHook {
  /** Look up a cached recipe for this step. `undefined` (or absent hook) = cache miss. */
  lookup(
    step: Step,
    ctx: ResolveContext,
  ): Promise<CachedRecipe | undefined> | CachedRecipe | undefined;
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
  /**
   * L0 cache-hit quality tuning from `[cache]` config (Layer 2). Threaded into the page-signature
   * computation (`ignore_regions` excluded from BOTH hashes) and the L0 match (`signature` mode).
   * Absent → default full-signature matching with only the zero-config volatile-text masking
   * (Layer 1) active, so a run with no `[cache]` block behaves exactly as before this option.
   */
  cache?: CacheOptions;
  /**
   * Author-declared deterministic ATTRIBUTE-hook names from `[resolve] attributes` (e.g.
   * `["data-cmd"]`). Threaded from the resolved config so an AI-tier pick (`actOnPick`) can persist a
   * DISCRIMINATING durable selector for a nameless icon element: a unique attribute hook
   * `[data-cmd="c2"]` (PREFERRED over positional, Fix 1) that a WARM run replays at L0 with ZERO model
   * calls. Passed straight to `durableSelectorForElement`/`strategyForElement` as `attributeNames`.
   * Absent/empty → the positional `role:<role>[N]` fallback path (behavior unchanged).
   */
  resolveAttributes?: readonly string[];
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
  dispatchState?: DispatchState;
  retrySafe?: boolean;
  matchedConditions?: MatchedCondition[];
  attempts?: number;
  retryDecisionReason?: string;
  retryReason?: string;
  receipt?: ActionReceipt;
  effect?: "observe" | "idempotent" | "at_most_once";
  anchor?: string;
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
