// Flightplan — linter rule context + rule contract.
//
// Rules are pure functions over a {@link LintContext} returning {@link Diagnostic}s. The
// context exposes BOTH the raw parsed TOML document (so a rule can isolate its own violation
// even when a sibling key is malformed — zod's `.strict()` would otherwise reject the whole
// file and rob us of per-rule attribution) AND the schema-validated flow/config when parsing
// succeeded. Rules choose the level they need:
//   - structural rules (duplicate ids, raw selectors, undeclared inputs) read `doc` so a
//     single broken step still yields a specific ruleId;
//   - rules that benefit from narrowed types may read `flow`/`config` when present.
//
// Canonical reference: PLAN.md §5 (Phase 1, lint ruleset) + §8 (starter ruleset).

import type { Config, ConfigFile } from "../config/index.ts";
import type { FlowFile } from "../flow/index.ts";
import type { Diagnostic, Severity } from "./types.ts";

/** A raw, untyped parsed-TOML record (post `parseToml`, pre zod). */
export type RawDoc = Record<string, unknown>;

/**
 * Everything a rule may inspect for one file. Built once per file by `lintFile` and passed to
 * every rule. Rules MUST be pure (no I/O beyond what the context already resolved, no
 * throwing — return diagnostics).
 */
export interface LintContext {
  /** Absolute path of the file under lint. */
  file: string;
  /** Directory containing the file (for resolving relative import paths). */
  baseDir: string;
  /** Raw TOML source text. */
  sourceText: string;
  /** The parsed-but-unvalidated TOML document, or `null` when TOML parsing itself failed. */
  doc: RawDoc | null;
  /** Declared `kind` from the raw doc (`"flow"`, `"config"`, or whatever string was found). */
  declaredKind: string | null;
  /** The schema-validated flow, when the file is a valid `kind = "flow"`. */
  flow: FlowFile | null;
  /** The schema-validated config body, when the file is a valid `kind = "config"`. */
  config: (Config & ConfigFile) | null;
  /**
   * Imported-module resolution result, precomputed by `lintFile` (async work kept out of the
   * pure rules). `null` when there are no imports or the flow could not be parsed.
   */
  imports: ImportLintInfo | null;
  /**
   * Sidecar lock data read directly from `<file>.lock.toml` (minimal TOML read — the lock
   * manager is not built yet). `null` when no lock file exists. PLAN.md §5 Phase 1.
   */
  lock: LockLintInfo | null;
  /** The flow's `source_hash` (`sha256:<hex>`) — used for the lock-stale comparison. */
  sourceHash: string;
}

/**
 * Outcome of resolving a flow's `imports` (+ setup/teardown + path-form `run` references),
 * precomputed for the rules.
 */
export interface ImportLintInfo {
  /** Per-reference resolution outcome. */
  refs: ResolvedRef[];
  /** A detected import cycle (over the combined import+run DAG), as its path chain. */
  cycle: string[] | null;
  /**
   * The file's LIBRARY scope: every module registered via `imports` (directly or
   * transitively) with its declared flow id + [inputs] keys. `null` when the graph could
   * not be resolved (missing module / cycle) — id-scope rules then stay silent rather than
   * double-report.
   */
  scope: ImportScopeModule[] | null;
}

/** One module in a file's import scope (PLAN_v002 v002-5/v002-6). */
export interface ImportScopeModule {
  /** The module's declared flow id (what an id-form `run.flow` resolves against). */
  id: string;
  /** Absolute path of the module. */
  path: string;
  /** The module's declared [inputs] keys (for `templating/with-inputs-declared`). */
  inputNames: string[];
}

/** A single import/setup/teardown/run reference and whether its target file exists. */
export interface ResolvedRef {
  /** The path exactly as written in the file. */
  raw: string;
  /** Absolute path it resolved to. */
  resolved: string;
  /** Whether a file exists at `resolved`. */
  exists: boolean;
  /** How the reference entered the graph (`run` = path-form `run` step reference). */
  relation: "import" | "setup" | "teardown" | "run";
  /** Declared flow id of the referenced module, when it loaded cleanly. */
  flowId?: string;
  /** Declared [inputs] keys of the referenced module, when it loaded cleanly. */
  inputNames?: string[];
}

/** Minimal lock-file data the linter reads (just enough for the stale-hash warning). */
export interface LockLintInfo {
  /** Absolute path of the lock file. */
  path: string;
  /** The lock's recorded `source_hash`, if present and a string. */
  sourceHash: string | null;
}

/** A single rule in the registry. */
export interface Rule {
  /** Stable identifier surfaced on every diagnostic this rule emits (e.g. `steps/unique-ids`). */
  id: string;
  /** The default severity for this rule (a rule may still emit either severity). */
  severity: Severity;
  /** One-line description (documentation + `--list-rules` style tooling). */
  description: string;
  /** Pure check. Returns zero or more diagnostics. Must not throw. */
  run(ctx: LintContext): Diagnostic[];
}

/** Small helper for rules to build a diagnostic with the file pre-filled. */
export function diag(
  ctx: LintContext,
  ruleId: string,
  severity: Severity,
  message: string,
  extra?: { stepId?: string; location?: string },
): Diagnostic {
  return {
    ruleId,
    severity,
    message,
    file: ctx.file,
    ...(extra?.stepId !== undefined ? { stepId: extra.stepId } : {}),
    ...(extra?.location !== undefined ? { location: extra.location } : {}),
  };
}
