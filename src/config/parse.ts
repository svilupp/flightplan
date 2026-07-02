// Flightplan — TOML parsing + config-file loading.
//
// `parseToml` is the one place that touches smol-toml; everything else in config/ and
// flow/ goes through it. `loadConfigFile` reads + parses + zod-validates a flightplan.toml
// (kind === 'config'). Canonical reference: PLAN.md §2 (config/) and §5 (Phase 1).

import { parse as parseTomlRaw } from "smol-toml";
import { ConfigFileSchema } from "./schema.ts";
import type { ConfigFile } from "./types.ts";

/** Raised when a file's TOML cannot be parsed. Carries the path for diagnostics. */
export class TomlParseError extends Error {
  constructor(
    message: string,
    readonly path?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TomlParseError";
  }
}

/** Raised when a parsed document fails zod validation. `issues` is the zod issue list. */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly issues: unknown,
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/**
 * Parse a TOML string into a plain JS object. The single wrapper over smol-toml so callers
 * never import the parser directly. Throws {@link TomlParseError} on malformed input.
 */
export function parseToml(text: string, path?: string): unknown {
  try {
    return parseTomlRaw(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new TomlParseError(`Failed to parse TOML${path ? ` (${path})` : ""}: ${detail}`, path, {
      cause: err,
    });
  }
}

/** Result of {@link loadConfigFile}: the validated config plus resolved-path metadata. */
export interface LoadedConfigFile {
  config: ConfigFile;
  path: string;
  sourceText: string;
}

/**
 * Read, parse, and zod-validate a `flightplan.toml` config file (kind === 'config').
 * Throws {@link TomlParseError} on bad TOML and {@link ConfigValidationError} on a schema
 * violation (including a wrong `kind`).
 */
export async function loadConfigFile(path: string): Promise<LoadedConfigFile> {
  const file = Bun.file(path);
  const sourceText = await file.text();
  const data = parseToml(sourceText, path);

  const result = ConfigFileSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigValidationError(
      `Invalid config file (${path}): ${formatIssues(result.error.issues)}`,
      path,
      result.error.issues,
    );
  }
  return { config: result.data, path, sourceText };
}

/** Compact, human-readable rendering of a zod issue list for error messages. */
export function formatIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string {
  return issues
    .map((i) => {
      const where = i.path.length > 0 ? i.path.map(String).join(".") : "<root>";
      return `${where}: ${i.message}`;
    })
    .join("; ");
}
