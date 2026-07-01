// Flightplan — linter diagnostic types.
//
// A `Diagnostic` is one rule violation against one file; a `LintResult` is the aggregate for
// a single file (diagnostics + counts + ok flag). The CLI groups results by file and emits a
// summary. Canonical reference: PLAN.md §5 (Phase 1, "flightplan lint") and the starter
// ruleset in PLAN.md §8 ("Assumed defaults").

/** Severity of a single diagnostic. `error` fails the lint (exit 1); `warning` does not. */
export type Severity = "error" | "warning";

/**
 * One rule violation. `ruleId` identifies the rule (e.g. `header/required-fields`); `file` is
 * the absolute path of the linted file; `stepId`/`location` pinpoint where in the file the
 * problem is (a step id, an assertion path, an import path, …) when known.
 */
export interface Diagnostic {
  /** Stable rule identifier, e.g. `steps/unique-ids`. Used by tests + tooling. */
  ruleId: string;
  /** `error` (fails lint) or `warning` (reported, does not fail). */
  severity: Severity;
  /** Human-readable explanation + guidance. */
  message: string;
  /** Absolute path of the file this diagnostic belongs to. */
  file: string;
  /** The offending step's `id`, when the diagnostic is scoped to a step. */
  stepId?: string;
  /** A finer-grained location (assertion path, import target, field name, …). */
  location?: string;
}

/**
 * The lint outcome for a single file: every diagnostic plus convenience counts and an `ok`
 * flag (`ok === (errorCount === 0)` — warnings never flip `ok`).
 */
export interface LintResult {
  /** Absolute path of the linted file. */
  file: string;
  /** Every diagnostic produced for this file, in rule-registration order. */
  diagnostics: Diagnostic[];
  /** Number of `error`-severity diagnostics. */
  errorCount: number;
  /** Number of `warning`-severity diagnostics. */
  warningCount: number;
  /** `true` when there are zero errors (warnings are allowed). */
  ok: boolean;
}

/** The aggregate result of linting many files. */
export interface MultiLintResult {
  /** One {@link LintResult} per file, in input order. */
  results: LintResult[];
  /** Total error-severity diagnostics across all files. */
  errorCount: number;
  /** Total warning-severity diagnostics across all files. */
  warningCount: number;
  /** `true` when every file is ok (zero errors total). */
  ok: boolean;
}
