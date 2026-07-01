// Flightplan — runtime lock composition.
//
// On disk, locks are strictly 1:1 file↔lock (one lock per flow file). At RUNTIME, the invoked
// flow may `import` modules (setup/teardown + reusable sub-flows), each with its OWN committed
// lock. `composeLocks(rootLock, importedLocks)` merges them into a single read-only view L0
// queries — it is NEVER written back merged (the write-back step uses the per-target PROVENANCE
// to update the correct on-disk lock).
//
// KEYING. Targets are keyed by `step` id. The invoked (root) flow's step ids are authoritative
// and live in the UNNAMESPACED key space. Each imported module is given a namespace (its import
// alias / module id); a module target's compose key is `"<namespace>:<step>"` so two modules that
// both define a step `submit` never collide. A root step always wins a bare-key collision; among
// imports, first-registered wins and a later duplicate is dropped (and reported in `collisions`).
//
// PROVENANCE. Every composed entry records which on-disk lock file it came from (`source` =
// `lock.source`, plus the namespace and whether it was the root). The write-back step reads this
// to route a healed recipe back to the right file.
//
// Canonical references: PLAN.md §5 Phase 3 ("read + compose locks … strict 1:1 file↔lock,
// composed at runtime, never merged on disk"), §2 (flow imports/composition).

import type { LockFile, LockTarget } from "./types.ts";

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

/** An imported module's lock plus the namespace its step ids are scoped under at compose time. */
export interface ImportedLock {
  /**
   * The namespace for this module's step keys (its import alias / module id). Used to build the
   * compose key `"<namespace>:<step>"` so imported steps never collide with root or sibling
   * steps. Must be unique across imports.
   */
  namespace: string;
  lock: LockFile;
}

/** Where a composed target came from — so the write-back step updates the right on-disk lock. */
export interface TargetProvenance {
  /** The on-disk lock's `source` (the flow path/id), i.e. which file to write the heal back to. */
  source: string;
  /** The compose namespace (`""` for the root flow; the import alias for a module). */
  namespace: string;
  /** True when this target came from the invoked (root) flow's own lock. */
  isRoot: boolean;
}

/** One entry in the composed view: the target, its compose key, and its provenance. */
export interface ComposedEntry {
  /** The compose key: the bare `step` id for root targets, `"<namespace>:<step>"` for imports. */
  key: string;
  target: LockTarget;
  provenance: TargetProvenance;
}

/** A dropped target due to a compose-key collision (for diagnostics / lint). */
export interface ComposeCollision {
  key: string;
  /** The provenance of the entry that WON the key. */
  kept: TargetProvenance;
  /** The provenance of the entry that was DROPPED. */
  dropped: TargetProvenance;
}

/**
 * The runtime-composed lock view L0 queries. `byKey` is the lookup map; `entries` preserves
 * insertion order (root first, then imports in registration order); `collisions` records any
 * dropped duplicates.
 */
export interface ComposedLock {
  byKey: Map<string, ComposedEntry>;
  entries: ComposedEntry[];
  collisions: ComposeCollision[];
}

// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------

/**
 * Merge the invoked flow's lock with every imported module's lock into a single read-only view.
 *
 *  - Root targets use the BARE `step` id as the compose key and always win a collision.
 *  - Imported targets use `"<namespace>:<step>"`. Among imports, first-registered wins; a later
 *    duplicate key is dropped and recorded in `collisions`.
 *  - Provenance is preserved on every entry so the write-back step can route heals to the correct
 *    on-disk lock file.
 *
 * The result is NEVER serialized — it is a runtime query view only.
 */
export function composeLocks(rootLock: LockFile, importedLocks: ImportedLock[] = []): ComposedLock {
  const byKey = new Map<string, ComposedEntry>();
  const entries: ComposedEntry[] = [];
  const collisions: ComposeCollision[] = [];

  const add = (key: string, target: LockTarget, provenance: TargetProvenance): void => {
    const existing = byKey.get(key);
    if (existing) {
      collisions.push({ key, kept: existing.provenance, dropped: provenance });
      return;
    }
    const entry: ComposedEntry = { key, target, provenance };
    byKey.set(key, entry);
    entries.push(entry);
  };

  // Root flow targets first (bare keys, authoritative).
  for (const target of rootLock.targets) {
    add(target.step, target, { source: rootLock.source, namespace: "", isRoot: true });
  }

  // Imported module targets, namespaced.
  for (const { namespace, lock } of importedLocks) {
    for (const target of lock.targets) {
      add(`${namespace}:${target.step}`, target, {
        source: lock.source,
        namespace,
        isRoot: false,
      });
    }
  }

  return { byKey, entries, collisions };
}

/**
 * Look up a composed entry for a step. Tries the bare step id (root) first, then — when a
 * `namespace` is supplied (the step belongs to an imported module) — the namespaced key. Returns
 * `undefined` on a miss.
 */
export function lookupComposed(
  composed: ComposedLock,
  step: string,
  namespace?: string,
): ComposedEntry | undefined {
  const root = composed.byKey.get(step);
  if (root) return root;
  if (namespace !== undefined) {
    return composed.byKey.get(`${namespace}:${step}`);
  }
  return undefined;
}
