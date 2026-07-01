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
import { parseToml, TomlParseError, formatIssues } from "../config/parse.ts";
import { STRATEGIES } from "../types.ts";
import { LOCK_VERSION } from "./types.ts";
import type { LockFile } from "./types.ts";

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

const LockPinnedChoiceSchema = z
  .object({
    strategy: StrategySchema,
    selector: z.string(),
    green_runs: z.number().int().nonnegative().optional(),
    label: z.string().optional(),
  })
  .strict();

const LockTargetSchema = z
  .object({
    step: z.string().min(1),
    target: z.string(),
    kind: z.literal("ai_pick").optional(),
    match: LockMatchSchema,
    selector: z.string().optional(),
    strategy: StrategySchema.optional(),
    candidates: z.array(LockCandidateSchema).optional(),
    pinned_choice: LockPinnedChoiceSchema.optional(),
    green_runs: z.number().int().nonnegative().optional(),
    last_seen: z.string().optional(),
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
 */
export function parseLockFile(sourceText: string, path: string): LockFile {
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
  return result.data;
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
): Promise<LockFile> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return emptyLock(fresh?.source ?? path, fresh?.source_hash ?? "", fresh?.description ?? "");
  }
  const sourceText = await file.text();
  return parseLockFile(sourceText, path);
}
