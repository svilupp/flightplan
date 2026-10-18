import { runAssertion } from "../assert/engine.ts";
import type { Driver } from "../driver/types.ts";
import { validateBoundSteps } from "../flow/bound.ts";
import type { InputValues } from "../flow/input.ts";
import { normalizeTarget } from "../flow/normalize-target.ts";
import { loadFlowFileFlattened } from "../flow/run.ts";
import { applyTemplatingDeep, resolveInputs, restoreInputLiterals } from "../flow/template.ts";
import type { Step } from "../flow/types.ts";
import { isAmbiguous } from "../ladder/fuzzy.ts";
import { lintFile } from "../lint/lint.ts";
import type { Diagnostic } from "../lint/types.ts";
import type { FileSystemPort } from "../runtime.ts";

export interface CheckItem {
  code: string;
  status: "verified" | "failed" | "unknown" | "unchecked";
  step?: string;
  message: string;
  evidence?: Record<string, unknown>;
  suggestions?: string[];
}
export interface CheckReport {
  ok: boolean;
  diagnostics: Diagnostic[];
  items: CheckItem[];
}

/** Observes an already-acquired page. No connection, action ladder, arbitrary eval or lock writes. */
export async function checkFlow(options: {
  flowPath: string;
  inputs?: InputValues;
  env?: Record<string, string | undefined>;
  driver?: Driver;
  fs?: FileSystemPort;
}): Promise<CheckReport> {
  const lint = await lintFile(options.flowPath, { fs: options.fs });
  const report: CheckReport = { ok: false, diagnostics: lint.diagnostics, items: [] };
  if (!lint.ok) return report;
  let loaded: Awaited<ReturnType<typeof loadFlowFileFlattened>>;
  try {
    loaded = await loadFlowFileFlattened(options.flowPath, options);
  } catch {
    report.items.push({
      code: "BINDING_INVALID",
      status: "failed",
      message: "Recipe inputs or dependencies could not be bound; no browser inspection occurred.",
    });
    return report;
  }
  let steps: Step[];
  try {
    const inputs = resolveInputs(loaded.flow.inputs, undefined, options.env, {}, options.inputs);
    steps = validateBoundSteps(
      restoreInputLiterals(
        applyTemplatingDeep(loaded.flow.steps, { inputs, env: options.env, deferCaptures: true }),
      ),
    );
  } catch {
    report.items.push({
      code: "BINDING_INVALID",
      status: "failed",
      message: "Bound recipe steps violate their action schema; no browser inspection occurred.",
    });
    return report;
  }
  const driver = options.driver;
  if (!driver) {
    report.items.push({
      code: "SESSION_REQUIRED",
      status: "unknown",
      message: "Static validation passed; current page inspection requires an acquired session.",
    });
    return report;
  }
  let future = false;
  for (const step of steps) {
    if (future) {
      report.items.push({
        code: "LATER_STATE_UNCHECKED",
        status: "unchecked",
        step: step.id,
        message: "A preceding action changes the state; this step was not inspected.",
      });
      continue;
    }
    for (const assertion of step.assert ?? []) {
      const before =
        assertion.when === "before" ||
        (assertion.when === undefined && assertion.purpose === "precondition");
      if (!before) continue;
      if (assertion.type === "ai_judge" || assertion.type === "result") {
        report.items.push({
          code: "CONDITION_UNCHECKED",
          status: "unchecked",
          step: step.id,
          message: "This condition requires semantic or prior-result evidence.",
        });
        continue;
      }
      try {
        const result = await runAssertion(
          { ...assertion, timeout_ms: 1 },
          { driver, defaultTimeoutMs: 1, mode: "deferred", failOnAssertion: true },
        );
        report.items.push({
          code: "ENTRY_CONDITION",
          status: result.pass ? "verified" : "failed",
          step: step.id,
          message: result.pass
            ? "Current entry condition passed."
            : "Current entry condition failed.",
        });
      } catch {
        report.items.push({
          code: "ENTRY_EVIDENCE_UNAVAILABLE",
          status: "unknown",
          step: step.id,
          message: "Current entry evidence is unavailable.",
        });
      }
    }
    if ("target" in step && step.target) {
      const target = normalizeTarget(step.target);
      try {
        if (target.selectors.length && driver.elementState) {
          const state = await driver.elementState(target.selectors[0]!);
          report.items.push({
            code: state.count > 1 ? "TARGET_AMBIGUOUS" : "TARGET_CURRENT",
            status: state.count === 1 ? "verified" : "failed",
            step: step.id,
            message: "Current selector cardinality inspected.",
            evidence: { matches: state.count },
            suggestions:
              state.count > 1 ? ["Scope the target to the intended resource identity."] : [],
          });
        } else {
          const ranked = await driver.resolveAll(target.nl ?? "", { limit: 20 });
          report.items.push({
            code: isAmbiguous(ranked) ? "TARGET_AMBIGUOUS" : "TARGET_CANDIDATES",
            status: ranked.length && !isAmbiguous(ranked) ? "verified" : "unknown",
            step: step.id,
            message: "Current candidate ranking inspected without dispatch.",
            evidence: { candidates: ranked.length },
          });
        }
      } catch {
        report.items.push({
          code: "TARGET_EVIDENCE_UNAVAILABLE",
          status: "unknown",
          step: step.id,
          message: "Target evidence could not be read.",
        });
      }
    }
    if (step.do === "extract" && !driver.extract)
      report.items.push({
        code: "CAPABILITY_MISSING",
        status: "failed",
        step: step.id,
        message: "The current driver does not support extraction.",
      });
    if (step.do !== "assert" && step.do !== "wait") future = true;
  }
  report.ok = !report.items.some((item) => item.status === "failed" || item.status === "unknown");
  return report;
}
