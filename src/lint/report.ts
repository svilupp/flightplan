// Flightplan — lint reporting (human-readable + JSON).
//
// `formatHuman` groups diagnostics by file and renders a compact, readable report with a
// trailing `N errors, M warnings` summary. `formatJson` emits the MultiLintResult as JSON
// (the machine-readable surface behind `lint --json`). Both are pure string builders so the
// CLI just prints what they return. Canonical reference: PLAN.md §5 (Phase 1, lint output).

import type { Diagnostic, LintResult, MultiLintResult } from "./types.ts";

function locationSuffix(d: Diagnostic): string {
  const parts: string[] = [];
  if (d.stepId) parts.push(`step \`${d.stepId}\``);
  if (d.location && d.location !== d.stepId) parts.push(d.location);
  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

function formatDiagnostic(d: Diagnostic): string {
  const tag = d.severity === "error" ? "error" : "warning";
  return `  ${tag}  ${d.ruleId}${locationSuffix(d)}\n         ${d.message}`;
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function formatFile(result: LintResult): string {
  const lines: string[] = [];
  const status = result.ok ? "ok" : "FAIL";
  lines.push(`${result.file}  [${status}]`);
  if (result.diagnostics.length === 0) {
    lines.push("  (no issues)");
  } else {
    for (const d of result.diagnostics) lines.push(formatDiagnostic(d));
  }
  return lines.join("\n");
}

/** Render a human-readable report for one-or-more files plus a summary line. */
export function formatHuman(multi: MultiLintResult): string {
  const blocks = multi.results.map(formatFile);
  const summary = `${pluralize(multi.errorCount, "error")}, ${pluralize(multi.warningCount, "warning")} across ${pluralize(multi.results.length, "file")}.`;
  return [...blocks, "", summary].join("\n\n").replace(/\n\n\n+/g, "\n\n");
}

/** Render the MultiLintResult as pretty JSON (the `--json` surface). */
export function formatJson(multi: MultiLintResult): string {
  return JSON.stringify(multi, null, 2);
}
