// Flightplan — lint/ public surface.
//
// The linter: pure rules over a parsed flow/config (PLAN.md §5 Phase 1 + §8 starter
// ruleset). `lintFile`/`lintFlowFile` lint one file; `lintPaths` lints many (files,
// directories, globs). The CLI (`flightplan lint`) wires `runLint` to these.

export type {
  Diagnostic,
  LintResult,
  MultiLintResult,
  Severity,
} from "./types.ts";

export type {
  ImportLintInfo,
  LintContext,
  LockLintInfo,
  RawDoc,
  ResolvedRef,
  Rule,
} from "./context.ts";
export { diag } from "./context.ts";

export { RULES, RULE_IDS, looksLikeRawSelector } from "./rules.ts";

export {
  expandPaths,
  lintFile,
  lintFlowFile,
  lintPaths,
  type LintFileOptions,
} from "./lint.ts";

export { formatHuman, formatJson } from "./report.ts";
