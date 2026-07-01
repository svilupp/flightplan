// Flightplan — lock module barrel (the committed per-flow lock manager).
//
// Public surface for the lock manager: on-disk types, read/parse, the recipe model + converters,
// page signatures, write/serialize, runtime composition, and the L0 `LockHook` factory.
//
// Named exports throughout (no `export *`) to avoid `export *` name collisions when re-exported
// from `src/index.ts` — notably `rankLockCandidates` (this module, over `LockCandidate[]`) is
// named to avoid clashing with the ladder's `rankCandidates` (over snapshot `RankedCandidate[]`),
// and our `LockMatch`/`LockTarget` are distinct from the ladder's in-memory `CachedRecipe`.
// Canonical reference: PLAN.md §4 / §5 Phase 3.

// --- on-disk types ---
export type {
  LockCandidate,
  LockFile,
  LockMatch,
  LockPinnedChoice,
  LockTarget,
} from "./types.ts";
export { LOCK_VERSION } from "./types.ts";

// --- read / parse ---
export {
  emptyLock,
  loadLockFile,
  LockFileSchema,
  LockParseError,
  parseLockFile,
} from "./parse.ts";

// --- recipe model + converters ---
export {
  assertDurableSelector,
  compareCandidates,
  isRefSelector,
  lockTargetToRecipe,
  mergeWinningRecipe,
  NonDurableSelectorError,
  rankLockCandidates,
  recipeFromExecution,
} from "./recipe.ts";

// --- page signatures (L0 validation) ---
export {
  computeMatchSignature,
  deriveUrlGlob,
  signatureMatches,
  splitMatchSignature,
  urlGlobMatches,
} from "./signature.ts";

// --- write / serialize + write policy ---
export {
  decideLockWrite,
  type LockWriteMode,
  resolveLockWriteMode,
  serializeLock,
  type WriteDecision,
  type WriteDecisionInput,
  writeLockFile,
} from "./write.ts";

// --- runtime composition ---
export {
  composeLocks,
  type ComposeCollision,
  type ComposedEntry,
  type ComposedLock,
  type ImportedLock,
  lookupComposed,
  type TargetProvenance,
} from "./compose.ts";

// --- the L0 LockHook factory ---
export { createLockHook, type CreateLockHookOptions } from "./hook.ts";

// --- the per-run lock session (read → compose → hook → write-back) ---
export {
  LockSession,
  openLockSession,
  type OpenLockSessionOptions,
  type RecordResolutionResult,
  type SessionImport,
} from "./session.ts";
