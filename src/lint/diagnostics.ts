import { FlowFileSchema, StepSchema } from "../flow/schema.ts";
import { collectRefs } from "../flow/template.ts";
import type { Diagnostic } from "./types.ts";

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
}

export function schemaIssueDiagnostics(
  issue: { code: string; message: string; path: PropertyKey[]; keys?: string[] },
  doc: Record<string, unknown>,
  file: string,
): Diagnostic[] {
  const location = issue.path
    .map((part) => (typeof part === "number" ? `[${part}]` : String(part)))
    .join(".")
    .replace(/\.\[/g, "[");
  if (issue.code !== "unrecognized_keys" || !issue.keys?.length)
    return [
      { file, ruleId: "schema/invalid", severity: "error", message: issue.message, location },
    ];
  let valid = Object.keys(FlowFileSchema.shape);
  if (issue.path[0] === "steps" && typeof issue.path[1] === "number" && Array.isArray(doc.steps)) {
    const step = doc.steps[issue.path[1]] as { do?: string } | undefined;
    const schema = StepSchema.options.find((option) => option.shape.do.value === step?.do);
    if (schema) valid = Object.keys(schema.shape);
  }
  return issue.keys.map((key) => {
    const nearest = valid
      .map((name) => ({ name, distance: distance(key, name) }))
      .sort((a, b) => a.distance - b.distance)[0];
    return {
      file,
      ruleId: "schema/invalid",
      code: "SCHEMA_UNKNOWN_KEY",
      severity: "error",
      location: location ? `${location}.${key}` : key,
      message: `Unknown key ${key}.`,
      evidence: { validKeys: valid },
      suggestions:
        nearest && nearest.distance <= 3
          ? [`Use ${nearest.name} if that is the intended field.`]
          : [],
    };
  });
}

export function recipeReferenceDiagnostics(
  doc: Record<string, unknown>,
  file: string,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const known = new Set<string>();
  const walk = (value: unknown, visit: (value: string) => void): void => {
    if (typeof value === "string") visit(value);
    else if (Array.isArray(value))
      value.forEach((child) => {
        walk(child, visit);
      });
    else if (value && typeof value === "object")
      Object.values(value).forEach((child) => {
        walk(child, visit);
      });
  };
  const steps = Array.isArray(doc.steps) ? doc.steps : [];
  for (const [index, raw] of steps.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const step = raw as Record<string, unknown>;
    const missing = new Set<string>();
    walk(step, (value) => {
      for (const ref of collectRefs(value))
        if (ref.source === "capture" && !known.has(ref.name)) missing.add(ref.name);
    });
    for (const name of missing)
      out.push({
        file,
        ruleId: "capture/before-definition",
        severity: "error",
        stepId: typeof step.id === "string" ? step.id : undefined,
        location: `steps[${index}]`,
        message: `Capture ${name} is unavailable before this step's action and assertions.`,
        suggestions: ["Capture the value in an earlier step within this invocation."],
      });
    const captures = Array.isArray(step.capture)
      ? step.capture
      : step.capture
        ? [step.capture]
        : [];
    for (const capture of captures)
      if (
        capture &&
        typeof capture === "object" &&
        "name" in capture &&
        typeof capture.name === "string"
      )
        known.add(capture.name);
  }
  const inputNames = new Set(
    Object.keys((doc.inputs && typeof doc.inputs === "object" ? doc.inputs : {}) as object),
  );
  for (const section of ["before", "after", "outputs"])
    walk(doc[section], (value) => {
      for (const ref of collectRefs(value))
        if (ref.source === "inputs" && !inputNames.has(ref.name))
          out.push({
            file,
            ruleId: "templating/undeclared-input",
            severity: "error",
            location: section,
            message: `Undeclared input ${ref.name} in ${section}.`,
          });
    });
  return out;
}

/** Source positions are emitted only for an unambiguous physical key/table match. */
export function enrichDiagnostics(items: Diagnostic[], source: string): Diagnostic[] {
  const lines = source.split("\n");
  const stepStarts = lines.flatMap((line, index) =>
    /^\s*\[\[steps\]\]\s*(?:#.*)?$/.test(line) ? [index] : [],
  );
  return items.map((item) => {
    const match = /^steps\[(\d+)\](?:\.(.*))?$/.exec(item.location ?? "");
    const start = match ? stepStarts[Number(match[1])] : 0;
    const end = match
      ? (stepStarts[Number(match[1]) + 1] ?? lines.length)
      : (stepStarts[0] ?? lines.length);
    const key = (match?.[2] ?? item.location ?? "")
      .split(".")
      .at(-1)
      ?.replace(/\[\d+\]/g, "");
    const positions =
      start === undefined || !key
        ? []
        : lines.slice(start, end).flatMap((line, offset) => {
            const found = /^\s*([\w-]+)\s*=/.exec(line);
            return found?.[1] === key
              ? [{ line: start + offset + 1, column: line.indexOf(key) + 1 }]
              : [];
          });
    return {
      ...item,
      code: item.code ?? item.ruleId.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
      rootCauseId: item.rootCauseId ?? item.location ?? item.ruleId,
      suggestions: item.suggestions ?? [],
      ...(positions.length === 1 ? { sourceRange: positions[0] } : {}),
    };
  });
}
