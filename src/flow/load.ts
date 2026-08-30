// Flightplan — flow loading.
//
// `loadFlowFile(path)` reads + parses TOML + zod-validates (kind === 'flow') and returns a
// typed FlowFile plus metadata, including a stable `source_hash` (sha256 of the file bytes)
// used later by lock validation to detect flow edits. Canonical reference: PLAN.md §4
// (LockFile.source_hash) and §5 (Phase 1).

import { formatIssues, parseToml } from "../config/parse.ts";
import { readTextFile, sha256Text } from "../runtime.ts";
import { expandForEachInDoc, ForEachError } from "./normalize.ts";
import { FlowFileSchema } from "./schema.ts";
import type { FlowFile } from "./types.ts";

/** Raised when a flow file fails zod validation. `issues` is the zod issue list. */
export class FlowValidationError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly issues: unknown,
  ) {
    super(message);
    this.name = "FlowValidationError";
  }
}

/** A loaded flow: the validated FlowFile plus resolution metadata. */
export interface LoadedFlow {
  flow: FlowFile;
  /** Absolute, resolved path to the flow file. */
  path: string;
  /** Raw TOML source text. */
  sourceText: string;
  /** Stable content hash (`sha256:<hex>`) of the source bytes — used by lock validation. */
  sourceHash: string;
}

/**
 * Compute the stable `source_hash` of a flow's TOML source. Format: `sha256:<hex>`, matching
 * the lock-file `source_hash` shape in PLAN.md §4 / PROPOSAL "Locks".
 */
export function computeSourceHash(sourceText: string): string {
  return `sha256:${sha256Text(sourceText)}`;
}

/**
 * Parse + zod-validate flow TOML that has already been read from disk. Useful for tests and
 * for callers that hold the text. Throws {@link FlowValidationError} on a schema violation.
 */
export function parseFlowFile(sourceText: string, path: string): LoadedFlow {
  const parsed = parseToml(sourceText, path);
  // Load-time `for_each` expansion: rewrite the raw doc into concrete steps BEFORE zod validates,
  // so the schema (and everything downstream) only ever sees concrete steps. A malformed
  // `for_each` / misused loop token surfaces as a FlowValidationError (not a raw throw).
  let data: unknown = parsed;
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    try {
      data = expandForEachInDoc(parsed as Record<string, unknown>, path);
    } catch (err) {
      if (err instanceof ForEachError) {
        throw new FlowValidationError(`Invalid flow file (${path}): ${err.message}`, path, [
          { message: err.message },
        ]);
      }
      throw err;
    }
  }
  const result = FlowFileSchema.safeParse(data);
  if (!result.success) {
    throw new FlowValidationError(
      `Invalid flow file (${path}): ${formatIssues(result.error.issues)}`,
      path,
      result.error.issues,
    );
  }
  return {
    flow: result.data,
    path,
    sourceText,
    sourceHash: computeSourceHash(sourceText),
  };
}

/**
 * Read, parse, and zod-validate a flow file (kind === 'flow'). Throws on bad TOML
 * (TomlParseError, from parseToml) or a schema violation ({@link FlowValidationError},
 * including a wrong `kind`).
 */
export async function loadFlowFile(path: string): Promise<LoadedFlow> {
  const sourceText = await readTextFile(path);
  return parseFlowFile(sourceText, path);
}
