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

// --- runtime composition ---
export {
  type ComposeCollision,
  type ComposedEntry,
  type ComposedLock,
  composeLocks,
  type ImportedLock,
  lookupComposed,
  type TargetProvenance,
} from "./compose.ts";
// --- the L0 LockHook factory ---
export { type CreateLockHookOptions, createLockHook } from "./hook.ts";
// --- masked-text signature component (L0 cache-hit quality — Layer 1 + 2) ---
export {
  computeMaskedTextHash,
  DEFAULT_MASK_ROLES,
  type MaskedTextOptions,
} from "./masked-text.ts";
// --- advisory-note volatile-token sanitizer (v003-4) ---
export { sanitizeNote, VOLATILE_PLACEHOLDER } from "./note-sanitize.ts";
// --- read / parse ---
export {
  emptyLock,
  LockFileSchema,
  LockParseError,
  loadLockFile,
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
// --- the per-run lock session (read → compose → hook → write-back) ---
export {
  LockSession,
  type OpenLockSessionOptions,
  openLockSession,
  type RecordResolutionResult,
  type SessionImport,
} from "./session.ts";
// --- page signatures (L0 validation) ---
export {
  type CacheOptions,
  computeMatchSignature,
  deriveUrlGlob,
  signatureMatches,
  splitMatchSignature,
  urlGlobMatches,
} from "./signature.ts";
// --- on-disk types ---
export type {
  LockCandidate,
  LockFile,
  LockMatch,
  LockPinnedChoice,
  LockTarget,
  TargetMemory,
} from "./types.ts";
export { LOCK_VERSION, NOTE_TTL_DAYS } from "./types.ts";
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
