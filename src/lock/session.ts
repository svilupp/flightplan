// Flightplan — the per-run lock session (read → compose → hook → write-back).
//
// `LockSession` is the stateful coordinator the runner holds for one run. It ties the pure lock
// pieces together:
//   - LOAD    each on-disk lock (root flow + any imported modules) via `loadLockFile` (a missing
//             file → a fresh empty lock; a malformed file → empty + warn, the auto-heal default).
//   - COMPOSE them into one read-only view (`composeLocks`) and expose the L0 `LockHook`
//             (`createLockHook`) the orchestrator calls before L1.
//   - WRITE-BACK: after each successful targeted-step resolution, `recordResolution` applies the
//             write policy (`decideLockWrite`) — building the `match` gate from the step's
//             `signatureBasis` — and folds a learned/healed recipe into the in-memory lock,
//             routed to the correct source file via the composed entry's provenance.
//   - FLUSH   the dirty in-memory locks to disk at end of run (`flush`) — but ONLY in `auto`
//             mode; `frozen`/`no-write` apply heals in memory yet never persist them.
//
// The session keeps `healed`/`drift_count`/`fail` accounting out of the runner's hot path: each
// `recordResolution` returns the per-step heal outcome and the runner aggregates it.
//
// Canonical references: PLAN.md §5 Phase 3 (read/compose/write, write policy, drift), §2
// (dependency direction: the runner owns orchestration; lock/ stays a leaf domain it composes).

import type { Step } from "../flow/index.ts";
import { describeTarget } from "../flow/normalize-target.ts";
import type { LockHook, StepExecution } from "../ladder/index.ts";
import type { Strategy } from "../types.ts";
import {
  type ComposedEntry,
  type ComposedLock,
  composeLocks,
  type ImportedLock,
} from "./compose.ts";
import { type CreateLockHookOptions, createLockHook } from "./hook.ts";
import { emptyLock, LockParseError, loadLockFile } from "./parse.ts";
import { deriveUrlGlob } from "./signature.ts";
import type { LockFile, LockMatch, LockTarget } from "./types.ts";
import { decideLockWrite, type LockWriteMode, writeLockFile } from "./write.ts";

// ---------------------------------------------------------------------------
// Tracked-lock bookkeeping
// ---------------------------------------------------------------------------

/** An on-disk lock tracked for write-back: its path, in-memory contents, and dirty flag. */
interface TrackedLock {
  path: string;
  lock: LockFile;
  dirty: boolean;
}

/** A loaded imported-module lock plus the namespace its step ids compose under. */
export interface SessionImport {
  /** Absolute path to the module's lock file. */
  lockPath: string;
  /** The module's `source` (flow path/id) recorded in its lock header. */
  source: string;
  /** The flow's `source_hash` (for a freshly created empty lock). */
  sourceHash: string;
  /** The compose namespace (import alias / module id). */
  namespace: string;
  /** Optional description for a freshly created empty lock. */
  description?: string;
}

/** Options for {@link openLockSession}. */
export interface OpenLockSessionOptions {
  /** Absolute path to the root flow's lock file. */
  lockPath: string;
  /** The root flow's `source` (path/id) — recorded in a freshly created empty lock. */
  source: string;
  /** The root flow's `source_hash` — recorded in a freshly created empty lock. */
  sourceHash: string;
  /** The root flow's description — recorded in a freshly created empty lock. */
  description?: string;
  /** The active write mode (mapped from the CLI flags via `resolveLockWriteMode`). */
  mode: LockWriteMode;
  /** Inject the driver's `selectorUsedToStrategy` so the lock module stays driver-free. */
  inferStrategy: (selector: string) => Strategy | null;
  /** Injectable clock for `last_seen` (deterministic in tests). */
  now?: () => number;
  /**
   * REDACTION SINK for the advisory note (DESIGN §4) — the run's `redactor.redactText`. Applied to
   * an AI-emitted note BEFORE it is persisted to the lock so a note echoing a `secret=true` value
   * never reaches the committed artifact. Omit → identity (no redaction); behavior unchanged.
   */
  redactNote?: (note: string) => string;
  /** Imported-module locks to compose into the read view (Phase 5 wires the runner side). */
  imported?: SessionImport[];
  /** Hook tuning (e.g. `prefilterUrl`, `namespaceFor`). */
  hookOptions?: CreateLockHookOptions;
  /** Where to report a malformed-lock warning (defaults to `console.error`). */
  onWarn?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// recordResolution result
// ---------------------------------------------------------------------------

/** The per-step heal outcome the runner aggregates into `healed_steps` / `drift_count`. */
export interface RecordResolutionResult {
  /** True when the step's recipe drifted and self-healed (drives `drift_count`). */
  healed: boolean;
  /** True when this drift must fail the run (`--frozen`). */
  fail: boolean;
  /** Short human note (for tracing / explain). */
  note: string;
}

// ---------------------------------------------------------------------------
// LockSession
// ---------------------------------------------------------------------------

/** The step's human-readable target description (for the persisted recipe's `target` field):
 * the target list's NL entry, else its first selector entry, else `undefined` — the lock
 * `target` description field never uses the bare step id (v002-1 §1 "lock target description"). */
function targetTextOf(step: Step): string | undefined {
  return "target" in step ? describeTarget(step.target) : undefined;
}

/**
 * The per-run lock coordinator. Construct via {@link openLockSession} (which does the file I/O);
 * the constructor itself is pure over already-loaded locks (handy for unit tests).
 */
export class LockSession {
  /** The L0 lock hook the orchestrator calls before L1. */
  readonly hook: LockHook;

  private readonly composed: ComposedLock;
  /** Tracked locks keyed by `lock.source` (root + imports). */
  private readonly bySource = new Map<string, TrackedLock>();
  private readonly rootSource: string;
  private readonly mode: LockWriteMode;
  private readonly inferStrategy: (selector: string) => Strategy | null;
  private readonly now: (() => number) | undefined;
  private readonly redactNote: ((note: string) => string) | undefined;

  constructor(
    root: TrackedLock,
    imported: Array<{ tracked: TrackedLock; namespace: string }>,
    options: {
      mode: LockWriteMode;
      inferStrategy: (selector: string) => Strategy | null;
      now?: () => number;
      redactNote?: (note: string) => string;
      hookOptions?: CreateLockHookOptions;
    },
  ) {
    this.mode = options.mode;
    this.inferStrategy = options.inferStrategy;
    this.now = options.now;
    this.redactNote = options.redactNote;
    this.rootSource = root.lock.source;

    this.bySource.set(root.lock.source, root);
    const importedLocks: ImportedLock[] = [];
    for (const { tracked, namespace } of imported) {
      this.bySource.set(tracked.lock.source, tracked);
      importedLocks.push({ namespace, lock: tracked.lock });
    }

    this.composed = composeLocks(root.lock, importedLocks);
    this.hook = createLockHook(this.composed, options.hookOptions ?? {});
  }

  /** Compose collisions surfaced at construction (for diagnostics / lint). */
  get collisions() {
    return this.composed.collisions;
  }

  /**
   * Record a SUCCESSFUL targeted-step resolution and apply the write policy. Builds the `match`
   * gate from the execution's `signatureBasis` (the pre-action page), runs `decideLockWrite`, and
   * — when there is a recipe to store — folds it into the correct in-memory lock (routed by the
   * composed entry's provenance; a first-learn for an unknown step lands in the root flow's lock).
   * Marks that lock dirty so `flush` can persist it (auto mode only).
   *
   * Returns the heal outcome; a no-op (L0 hit, unchanged recipe, missing basis) returns
   * `{ healed:false, fail:false }`.
   */
  recordResolution(
    step: Step,
    execution: StepExecution,
    opts: {
      resolvedAtL0: boolean;
      revalidated?: boolean;
      kind?: "ai_pick";
      pinnedLabel?: string;
    } = {
      resolvedAtL0: false,
    },
  ): RecordResolutionResult {
    const basis = execution.signatureBasis;
    if (!basis) {
      return { healed: false, fail: false, note: "no signature basis (no write)" };
    }

    const match: LockMatch = { url_glob: deriveUrlGlob(basis.url), sig: basis.sig };
    const entry: ComposedEntry | undefined = this.composed.byKey.get(step.id);

    const decision = decideLockWrite({
      mode: this.mode,
      existing: entry?.target,
      resolvedAtL0: opts.resolvedAtL0,
      ...(opts.revalidated ? { revalidated: true } : {}),
      step: {
        id: step.id,
        ...(targetTextOf(step) !== undefined ? { target: targetTextOf(step) } : {}),
      },
      execution,
      match,
      inferStrategy: this.inferStrategy,
      ...(this.now ? { now: this.now } : {}),
      ...(this.redactNote ? { redactNote: this.redactNote } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.pinnedLabel !== undefined ? { pinnedLabel: opts.pinnedLabel } : {}),
    });

    if (decision.target) {
      this.applyTarget(entry, decision.target);
    }

    return { healed: decision.healed, fail: decision.fail, note: decision.note };
  }

  /**
   * Persist the dirty in-memory locks to disk. Writes ONLY in `auto` mode — `frozen` and
   * `no-write` apply heals in memory but never persist them. Returns the paths actually written.
   */
  async flush(): Promise<string[]> {
    if (this.mode !== "auto") return [];
    const written: string[] = [];
    for (const tracked of this.bySource.values()) {
      if (!tracked.dirty) continue;
      await writeLockFile(tracked.path, tracked.lock);
      tracked.dirty = false;
      written.push(tracked.path);
    }
    return written;
  }

  /**
   * Fold `target` into the in-memory lock it belongs to. Routes by the composed entry's
   * provenance when known; an unknown step (a first-learn) lands in the root flow's lock. Marks
   * the affected lock dirty.
   */
  private applyTarget(entry: ComposedEntry | undefined, target: LockTarget): void {
    const source = entry?.provenance.source ?? this.rootSource;
    const tracked = this.bySource.get(source) ?? this.bySource.get(this.rootSource);
    if (!tracked) return;
    upsertTarget(tracked.lock, target);
    tracked.dirty = true;
    // Keep the composed view consistent so a later lookup of the same step reflects the heal
    // ("resolve + heal in memory"); the linear flow rarely revisits a step, but stay coherent.
    if (entry) {
      entry.target = target;
    } else {
      const newEntry: ComposedEntry = {
        key: target.step,
        target,
        provenance: { source: tracked.lock.source, namespace: "", isRoot: true },
      };
      this.composed.byKey.set(target.step, newEntry);
      this.composed.entries.push(newEntry);
    }
  }
}

/** Insert or replace a target (keyed by `step`) in a lock's target list (mutates `lock`). */
function upsertTarget(lock: LockFile, target: LockTarget): void {
  const idx = lock.targets.findIndex((t) => t.step === target.step);
  if (idx >= 0) lock.targets[idx] = target;
  else lock.targets.push(target);
}

// ---------------------------------------------------------------------------
// openLockSession — the I/O factory
// ---------------------------------------------------------------------------

/**
 * Load the root (and any imported) lock files from disk and build a {@link LockSession}. A
 * MISSING lock loads as a fresh empty lock; a MALFORMED lock is treated as empty + a warning (the
 * auto-heal default per PLAN.md §5 Phase 1) so a corrupt committed artifact never aborts a run.
 */
export async function openLockSession(options: OpenLockSessionOptions): Promise<LockSession> {
  const onWarn = options.onWarn ?? ((m: string) => console.error(m));

  const rootLock = await loadLockSafe(
    options.lockPath,
    {
      source: options.source,
      source_hash: options.sourceHash,
      description: options.description ?? "",
    },
    options.mode,
    onWarn,
    options.now,
  );
  const root: TrackedLock = {
    path: options.lockPath,
    lock: rootLock.lock,
    dirty: rootLock.dirty,
  };

  const imported: Array<{ tracked: TrackedLock; namespace: string }> = [];
  for (const imp of options.imported ?? []) {
    const lock = await loadLockSafe(
      imp.lockPath,
      { source: imp.source, source_hash: imp.sourceHash, description: imp.description ?? "" },
      options.mode,
      onWarn,
      options.now,
    );
    imported.push({
      tracked: { path: imp.lockPath, lock: lock.lock, dirty: lock.dirty },
      namespace: imp.namespace,
    });
  }

  return new LockSession(root, imported, {
    mode: options.mode,
    inferStrategy: options.inferStrategy,
    ...(options.now ? { now: options.now } : {}),
    ...(options.redactNote ? { redactNote: options.redactNote } : {}),
    ...(options.hookOptions ? { hookOptions: options.hookOptions } : {}),
  });
}

/**
 * Load a lock. In `auto`/`no-write` modes a MALFORMED file downgrades to empty + a warning (the
 * auto-heal default — a corrupt local artifact never aborts a run). In `frozen` mode the committed
 * lock is AUTHORITATIVE, so a malformed lock is a hard failure: the {@link LockParseError} is
 * rethrown so the runner maps it to an `error` verdict rather than silently re-resolving fresh (and
 * masking a garbage committed artifact with a `drift_count=0` pass).
 */
async function loadLockSafe(
  path: string,
  fresh: { source: string; source_hash: string; description: string },
  mode: LockWriteMode,
  onWarn: (message: string) => void,
  now?: () => number,
): Promise<{ lock: LockFile; dirty: boolean }> {
  try {
    const lock = await loadLockFile(path, fresh, now ?? Date.now);
    if (lock.source_hash === fresh.source_hash) return { lock, dirty: false };
    const message =
      `stale lock source_hash for ${path}: expected ${fresh.source_hash || "<missing>"}, ` +
      `found ${lock.source_hash || "<missing>"}; ${lock.targets.length} cached target(s) ignored. ` +
      "Regenerate the lock from the current flow source.";
    if (mode === "frozen") throw new LockParseError(message, path);
    onWarn(
      `flightplan: ${message} ` +
        (mode === "auto"
          ? "Quarantining targets and creating a fresh header."
          : "Resolving fresh in memory."),
    );
    return {
      lock: emptyLock(fresh.source, fresh.source_hash, fresh.description),
      dirty: mode === "auto",
    };
  } catch (err) {
    if (err instanceof LockParseError) {
      if (mode === "frozen") {
        // Frozen's contract: the committed lock is authoritative; a corrupt one must fail fast.
        throw err;
      }
      onWarn(
        `flightplan: ignoring malformed lock ${path} (${err.message}); resolving fresh and re-learning.`,
      );
      return { lock: emptyLock(fresh.source, fresh.source_hash, fresh.description), dirty: false };
    }
    throw err;
  }
}
