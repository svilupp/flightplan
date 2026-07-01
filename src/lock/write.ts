// Flightplan — lock serialization + writing.
//
// `serializeLock(lock)` renders a {@link LockFile} to TOML and `writeLockFile(path, lock)` writes
// it to disk. Two guarantees the committed-artifact story depends on:
//
//   1. ROUND-TRIP SAFE — `parseLockFile(serializeLock(x))` deep-equals `x` (modulo TOML
//      formatting). We only emit fields that survive the schema, and omit `undefined`s so they
//      round-trip as absent rather than `null`.
//   2. STABLE ORDERING — serializing the same logical lock twice yields BYTE-IDENTICAL output.
//      Targets are sorted by `step`; each target's candidates by `green_runs` desc then strategy
//      then selector (`compareCandidates`); object keys are emitted in a fixed canonical order.
//      This keeps committed lock diffs minimal across runs (no spurious reordering churn).
//
// We build a canonically-ordered plain object and hand it to `smol-toml`'s `stringify`. Because
// `smol-toml` preserves insertion order, the key order we build IS the emitted order.
//
// =========================================================================================
// WRITE POLICY (PLAN.md §5 Phase 3 / §4 mermaid (a) / the brief)
// =========================================================================================
// Three modes, mapped from the CLI flags:
//   - auto      (default)         — auto-heal: a drifted recipe is rewritten; first resolution
//                                   of a new step is learned & persisted.
//   - frozen    (--frozen)        — never write; a drift FAILS the run (CI: the committed lock
//                                   is stale). The heal still runs at runtime so the flow
//                                   proceeds and the drift is reported (`healed`/`drift_count`).
//   - no-write  (--no-lock-write) — resolve + heal in memory but never persist; drift reported,
//                                   run NOT failed (dev/experiment).
//
// `decideLockWrite` is the pure policy core. It NEVER writes a recipe on a clean L0 cache hit
// (the lock stays byte-stable across repeated green runs — PLAN.md §6 Phase 6 exit), and only
// flags a HEAL when an EXISTING recipe's winning selector actually drifted. `LockSession`
// (./session.ts) drives it across a run and `writeLockFile` persists the dirty files.
//
// Canonical references: PLAN.md §4 (lock TOML), §5 Phase 3 (write policy / stable diffs).

import { stringify } from "smol-toml";
import type { Strategy } from "../types.ts";
import type { StepExecution } from "../ladder/index.ts";
import { compareCandidates, mergeWinningRecipe, recipeFromExecution } from "./recipe.ts";
import type { LockCandidate, LockFile, LockMatch, LockPinnedChoice, LockTarget } from "./types.ts";

// ---------------------------------------------------------------------------
// Canonical ordering
// ---------------------------------------------------------------------------

/** Sort targets by `step` id (ascending) — the stable on-disk order. Does not mutate input. */
function orderedTargets(targets: LockTarget[]): LockTarget[] {
  return [...targets].sort((a, b) => (a.step < b.step ? -1 : a.step > b.step ? 1 : 0));
}

/** A candidate as a canonically-keyed plain object (only defined fields). */
function candidateToObject(c: LockCandidate): Record<string, unknown> {
  const out: Record<string, unknown> = { strategy: c.strategy, selector: c.selector };
  if (c.green_runs !== undefined) out.green_runs = c.green_runs;
  return out;
}

/** A pinned choice as a canonically-keyed plain object (only defined fields). */
function pinnedToObject(p: LockPinnedChoice): Record<string, unknown> {
  const out: Record<string, unknown> = { strategy: p.strategy, selector: p.selector };
  if (p.green_runs !== undefined) out.green_runs = p.green_runs;
  if (p.label !== undefined) out.label = p.label;
  return out;
}

/**
 * A target as a canonically-keyed plain object. Key order is fixed:
 *   step, target, kind, match, strategy, selector, green_runs, last_seen, pinned_choice, candidates
 * Only defined fields are emitted (so optionals round-trip as absent). Candidates are pre-sorted.
 */
function targetToObject(t: LockTarget): Record<string, unknown> {
  const out: Record<string, unknown> = {
    step: t.step,
    target: t.target,
  };
  if (t.kind !== undefined) out.kind = t.kind;
  out.match = { url_glob: t.match.url_glob, sig: t.match.sig };
  if (t.strategy !== undefined) out.strategy = t.strategy;
  if (t.selector !== undefined) out.selector = t.selector;
  if (t.green_runs !== undefined) out.green_runs = t.green_runs;
  if (t.last_seen !== undefined) out.last_seen = t.last_seen;
  if (t.pinned_choice !== undefined) out.pinned_choice = pinnedToObject(t.pinned_choice);
  if (t.candidates !== undefined && t.candidates.length > 0) {
    out.candidates = [...t.candidates].sort(compareCandidates).map(candidateToObject);
  }
  return out;
}

/** Build the canonically-ordered plain object for the whole lock (header keys then targets). */
function lockToObject(lock: LockFile): Record<string, unknown> {
  return {
    version: lock.version,
    source: lock.source,
    source_hash: lock.source_hash,
    description: lock.description,
    targets: orderedTargets(lock.targets).map(targetToObject),
  };
}

// ---------------------------------------------------------------------------
// serialize / write
// ---------------------------------------------------------------------------

/**
 * Render a {@link LockFile} to TOML text. Deterministic + stable-ordered: the same logical lock
 * always serializes to byte-identical output. Round-trips through {@link parseLockFile}.
 */
export function serializeLock(lock: LockFile): string {
  const text = stringify(lockToObject(lock));
  // Ensure a trailing newline for clean committed files (stringify omits it).
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Serialize + write a lock to `path`. Returns the serialized text (handy for callers that also
 * want to log/inspect it). Uses Bun's writer; creates/overwrites the file.
 */
export async function writeLockFile(path: string, lock: LockFile): Promise<string> {
  const text = serializeLock(lock);
  await Bun.write(path, text);
  return text;
}

// ---------------------------------------------------------------------------
// Write policy
// ---------------------------------------------------------------------------

/** The lock write mode in force for a run (mapped from the CLI flags). */
export type LockWriteMode = "auto" | "frozen" | "no-write";

/**
 * Map the run's CLI flags to a {@link LockWriteMode}. `--frozen` wins over `--no-lock-write`
 * (frozen is the stricter CI policy: it both suppresses writes AND fails on drift).
 */
export function resolveLockWriteMode(flags: {
  frozen?: boolean;
  noLockWrite?: boolean;
}): LockWriteMode {
  if (flags.frozen) return "frozen";
  if (flags.noLockWrite) return "no-write";
  return "auto";
}

/** The inputs to the pure write-policy decision for ONE resolved step. */
export interface WriteDecisionInput {
  /** The active write mode. */
  mode: LockWriteMode;
  /** The existing on-disk target for this step (undefined = first learn). */
  existing: LockTarget | undefined;
  /** True when the step resolved via an L0 cache replay (recipe matched → never rewrite). */
  resolvedAtL0: boolean;
  /** Step identity for the persisted target. */
  step: { id: string; target?: string };
  /** The successful resolution+action result (carries durableSelector/strategy/candidates). */
  execution: StepExecution;
  /** The precomputed match gate for the page this recipe was learned on. */
  match: LockMatch;
  /** Inject the driver's `selectorUsedToStrategy` (keeps this module driver-free). */
  inferStrategy: (selector: string) => Strategy | null;
  /** Injectable clock for `last_seen` (deterministic in tests). */
  now?: () => number;
  /** `'ai_pick'` for an AI-pick target (round-trips `pinned_choice`). */
  kind?: "ai_pick";
  /** The chosen candidate's human-readable name (becomes the `pinned_choice.label`, ai_pick only). */
  pinnedLabel?: string;
}

/** The pure write-policy decision for ONE resolved step. */
export interface WriteDecision {
  /** True when an EXISTING recipe's winning selector drifted (a heal). Drives `drift_count`. */
  healed: boolean;
  /** True when this drift must FAIL the run (`--frozen` + heal). */
  fail: boolean;
  /**
   * The new/merged target to store in the in-memory lock (first-learn or heal). Undefined when
   * there is nothing to store (an L0 hit, an unchanged recipe, or no durable selector). The
   * SESSION applies it in-memory in every mode; only `auto` flushes it to disk.
   */
  target?: LockTarget;
  /** Short human note (for tracing / explain). */
  note: string;
}

/**
 * The pure write-policy core. Given the resolved step, the existing lock target, and the mode,
 * decide whether the recipe is a clean cache hit (no write), a first-learn, an unchanged
 * re-resolution, or a real heal — and whether that heal should fail the run.
 *
 * Semantics:
 *   - L0 cache hit                          → no target, healed=false (lock stays stable).
 *   - no durable selector to persist        → no target, healed=false.
 *   - no existing recipe (first learn)      → target = fresh recipe, healed=false.
 *   - existing recipe, winner UNCHANGED     → no target, healed=false (only the page changed;
 *                                             per mermaid (a) "recipe differed? no" → no write).
 *   - existing recipe, winner DRIFTED       → target = merged recipe, healed=true;
 *                                             fail = (mode === 'frozen').
 *
 * The returned `target` is applied to the in-memory lock by the session regardless of mode
 * ("heal in memory"); persistence to disk is gated on `auto` by the session's `flush`.
 */
export function decideLockWrite(input: WriteDecisionInput): WriteDecision {
  const { mode, existing, resolvedAtL0, step, execution, match, inferStrategy, now, kind, pinnedLabel } =
    input;

  // A clean L0 cache replay: the lock recipe matched and replayed — never rewrite (stability).
  if (resolvedAtL0) {
    return { healed: false, fail: false, note: "L0 hit: recipe replayed (no write)" };
  }

  // Nothing durable to persist (e.g. a ref-only resolution that could not be re-derived).
  if (execution.durableSelector === undefined) {
    return { healed: false, fail: false, note: "no durable selector (no write)" };
  }

  const recipeOpts = {
    inferStrategy,
    ...(now ? { now } : {}),
    ...(kind ? { kind } : {}),
    ...(pinnedLabel !== undefined ? { pinnedLabel } : {}),
  };

  // First learn: no existing recipe for this step yet.
  if (!existing) {
    const target = recipeFromExecution(step, execution, match, recipeOpts);
    return { healed: false, fail: false, target, note: "first learn: new recipe" };
  }

  // Existing recipe present (L0 missed → L1 re-resolved). Did the winning selector drift?
  const merged = mergeWinningRecipe(existing, step, execution, match, recipeOpts);
  const drifted = existing.selector !== merged.selector || existing.strategy !== merged.strategy;

  if (!drifted) {
    // Same winning recipe (the selector still resolves; only the page/signature changed). Not a
    // heal → no write, per mermaid (a) ("recipe differed from lock? no" → skip the write).
    return { healed: false, fail: false, note: "recipe unchanged (no write)" };
  }

  // A real heal (drift). Always surface it; persist only under auto; fail only under frozen.
  return {
    healed: true,
    fail: mode === "frozen",
    target: merged,
    note:
      mode === "auto"
        ? "healed: drift detected, recipe rewritten"
        : mode === "frozen"
          ? "healed at runtime: drift NOT persisted (--frozen) — run fails"
          : "healed in memory: drift NOT persisted (--no-lock-write)",
  };
}
