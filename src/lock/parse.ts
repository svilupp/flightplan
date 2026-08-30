// Flightplan — lock-file reading + validation.
//
// `loadLockFile(path)` reads + parses the TOML lock (via `smol-toml`, through the shared
// `parseToml` wrapper) and zod-validates it against {@link LockFileSchema}. The two policies the
// caller relies on:
//
//   1. MISSING file → a fresh EMPTY lock (never throws). A flow with no learned recipes yet is
//      the normal first-run case; L0 simply misses on every step.
//   2. MALFORMED lock (bad TOML or a schema violation) → a {@link LockParseError} with a clear
//      message. The CALLER decides whether to treat a corrupt lock as empty-and-warn (the
//      auto-heal default) or to fail hard; the parser does not silently swallow corruption.
//
// The schema is `.strict()` so an unknown key (a typo, a stale field from a future format) is a
// validation error rather than silently dropped — committed locks stay honest.
//
// Canonical references: PLAN.md §4 (lock format), §5 Phase 3 (read), §8 (lock-stale warning).

import { z } from "zod";
import { formatIssues, parseToml, TomlParseError } from "../config/parse.ts";
import { fileExists, readTextFile } from "../runtime.ts";
import { STRATEGIES } from "../types.ts";
import { normalizeLock } from "./portfolio.ts";
import type { LockFile } from "./types.ts";
import { LOCK_VERSION } from "./types.ts";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Raised when an EXISTING lock file is malformed (bad TOML or a schema violation). Carries the
 * path and the underlying detail. A MISSING file is NOT an error (see {@link loadLockFile}).
 */
export class LockParseError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly issues?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LockParseError";
  }
}

// ---------------------------------------------------------------------------
// Zod schema (strict — malformed locks are caught)
// ---------------------------------------------------------------------------

const StrategySchema = z.enum(STRATEGIES);

const LockMatchSchema = z
  .object({
    url_glob: z.string(),
    sig: z.string(),
  })
  .strict();

const LockCandidateSchema = z
  .object({
    strategy: StrategySchema,
    selector: z.string(),
    green_runs: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * One portfolio strategy entry (v2). `greens` is the per-strategy green count; `last_ok`/
 * `last_drift` are ISO timestamps (validated as strings, parsed by `portfolio.ts`).
 */
const StrategyEntrySchema = z
  .object({
    kind: StrategySchema,
    selector: z.string(),
    greens: z.number().int().nonnegative(),
    last_ok: z.string().optional(),
    last_drift: z.string().optional(),
  })
  .strict();

const LockPinnedChoiceSchema = z
  .object({
    strategy: StrategySchema,
    selector: z.string(),
    green_runs: z.number().int().nonnegative().optional(),
    label: z.string().optional(),
  })
  .strict();

/**
 * The advisory memory sub-table (`[targets.memory]`, DESIGN §4). Both fields optional: an old lock
 * has no `memory` at all; a note may exist without a timestamp (treated as stale on load).
 */
const TargetMemorySchema = z
  .object({
    note: z.string().optional(),
    note_updated: z.string().optional(),
  })
  .strict();

const LockTargetSchema = z
  .object({
    step: z.string().min(1),
    target: z.string(),
    kind: z.literal("ai_pick").optional(),
    match: LockMatchSchema,
    // v2 — the ranked strategy portfolio.
    strategies: z.array(StrategyEntrySchema).optional(),
    pinned_choice: LockPinnedChoiceSchema.optional(),
    memory: TargetMemorySchema.optional(),
    last_seen: z.string().optional(),
    // v1 (pre-portfolio) — accepted on load for auto-migration; never written by v2.
    selector: z.string().optional(),
    strategy: StrategySchema.optional(),
    candidates: z.array(LockCandidateSchema).optional(),
    green_runs: z.number().int().nonnegative().optional(),
  })
  .strict();

/** The strict zod schema for a whole on-disk lock file. */
export const LockFileSchema = z
  .object({
    version: z.number().int(),
    source: z.string(),
    source_hash: z.string(),
    description: z.string(),
    targets: z.array(LockTargetSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// emptyLock — the fresh / missing-file default
// ---------------------------------------------------------------------------

/**
 * Build a fresh, empty lock for `source` (the flow path/id) with the flow's `source_hash`. This
 * is what a missing lock loads as, and what a first run starts from before any recipe is learned.
 */
export function emptyLock(source: string, source_hash: string, description = ""): LockFile {
  return {
    version: LOCK_VERSION,
    source,
    source_hash,
    description,
    targets: [],
  };
}

// ---------------------------------------------------------------------------
// parse / load
// ---------------------------------------------------------------------------

/**
 * Parse + validate lock TOML already read from disk (pure; useful for tests and round-trip
 * checks). Throws {@link LockParseError} on bad TOML or a schema violation.
 *
 * The parsed lock is NORMALIZED into the v2 strategy-portfolio shape before it is returned
 * (`normalizeLock`): a v1 lock (winner + candidates + green_runs) auto-migrates in memory, so
 * every caller — L0 lookup, the write-back session, tests — sees the portfolio form regardless of
 * the on-disk version. `now` (defaulting to `Date.now`) drives the initial ranking's recency
 * weighting and is injectable for deterministic tests.
 */
export function parseLockFile(
  sourceText: string,
  path: string,
  now: () => number = Date.now,
): LockFile {
  let data: unknown;
  try {
    data = parseToml(sourceText, path);
  } catch (err) {
    if (err instanceof TomlParseError) {
      throw new LockParseError(`Malformed lock file (${path}): ${err.message}`, path, undefined, {
        cause: err,
      });
    }
    throw err;
  }
  const result = LockFileSchema.safeParse(data);
  if (!result.success) {
    throw new LockParseError(
      `Malformed lock file (${path}): ${formatIssues(result.error.issues)}`,
      path,
      result.error.issues,
    );
  }
  return normalizeLock(result.data, now());
}

/**
 * Read + parse + validate a lock file.
 *
 *  - MISSING file → a fresh {@link emptyLock} (NEVER throws). `source`/`source_hash`/`description`
 *    on the returned empty lock come from the optional `fresh` overrides (defaulting `source` to
 *    `path` and the rest to empty), so the caller can hand the result straight to the writer.
 *  - PRESENT but malformed → throws {@link LockParseError} (the caller decides corrupt-vs-empty).
 *
 * @param path  absolute path to the `.lock.toml` (or configured lock path) for the flow.
 * @param fresh overrides for the empty lock returned on a missing file.
 */
export async function loadLockFile(
  path: string,
  fresh?: { source?: string; source_hash?: string; description?: string },
  now: () => number = Date.now,
): Promise<LockFile> {
  if (!(await fileExists(path))) {
    return emptyLock(fresh?.source ?? path, fresh?.source_hash ?? "", fresh?.description ?? "");
  }
  const sourceText = await readTextFile(path);
  return parseLockFile(sourceText, path, now);
}
