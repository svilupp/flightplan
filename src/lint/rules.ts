// Flightplan — linter rules.
//
// Every rule is a pure `Rule` object: { id, severity, description, run(ctx) => Diagnostic[] }.
// The registry `RULES` is an ordered array — adding a rule is appending one object, so the
// set is trivially extensible (PLAN.md §5: "Make the rule set easily extensible").
//
// Rules read the RAW parsed doc (`ctx.doc`) for structural checks so a single broken step
// still attributes to its specific rule, instead of being swallowed by zod's whole-file
// `.strict()` rejection. The schema-validated `ctx.flow`/`ctx.config` are used where typed
// narrowing helps. A catch-all `schema/invalid` rule (in lint.ts, not here) surfaces any zod
// violation a structural rule did not already explain.
//
// Canonical reference: PLAN.md §5 (Phase 1 ruleset) + §8 (starter ruleset).

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseToml } from "../config/index.ts";
import { collectRefs, isRunFlowPath } from "../flow/index.ts";
import { classifyLocator, normalizeTarget } from "../flow/normalize-target.ts";
import { AI_JUDGE_INPUTS, ASSERT_TYPES, ASSERT_WHENS, FILE_KINDS, STEP_DOS } from "../types.ts";
import { diag, type LintContext, type RawDoc, type Rule } from "./context.ts";
import type { Diagnostic } from "./types.ts";

/** Verbs that resolve a target through the ladder (click/fill/select/ai_pick). */
const TARGETING_DOS = new Set(["click", "fill", "select", "ai_pick"]);

/** A raw step's `target` field normalized into a plain string list (empty when absent/invalid). */
function rawTargetEntries(step: Record<string, unknown>): string[] {
  const t = step.target;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((v): v is string => typeof v === "string");
  return [];
}

// ---------------------------------------------------------------------------
// Raw-doc access helpers (safe under noUncheckedIndexedAccess).
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Raw step records from the doc (or empty when `steps` is absent/not an array). */
function rawSteps(doc: RawDoc | null): Record<string, unknown>[] {
  if (!doc) return [];
  return asArray(doc.steps).filter(isRecord);
}

/** The `assert` array on a raw step record. */
function rawAsserts(step: Record<string, unknown>): Record<string, unknown>[] {
  return asArray(step.assert).filter(isRecord);
}

/** Best-effort step id for diagnostics (raw, may be absent). */
function stepId(step: Record<string, unknown>, index: number): string {
  const id = step.id;
  return typeof id === "string" && id.length > 0 ? id : `#${index}`;
}

/** Recursively collect every string leaf in a value, with a dotted path for location. */
function collectStrings(
  value: unknown,
  path: string,
  out: Array<{ path: string; value: string }>,
): void {
  if (typeof value === "string") {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      collectStrings(v, `${path}[${i}]`, out);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      collectStrings(v, path ? `${path}.${k}` : k, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Header rules
// ---------------------------------------------------------------------------

const REQUIRED_HEADER = ["version", "kind", "id", "description"] as const;

const headerRequiredFields: Rule = {
  id: "header/required-fields",
  severity: "error",
  description: "Required header fields (version, kind, id, description) must be present.",
  run(ctx) {
    if (!ctx.doc) return [];
    const out: Diagnostic[] = [];
    for (const field of REQUIRED_HEADER) {
      const v = ctx.doc[field];
      const missing =
        v === undefined ||
        (field === "id" && typeof v === "string" && v.length === 0) ||
        (field === "description" && typeof v === "string" && v.length === 0);
      if (missing) {
        out.push(
          diag(
            ctx,
            "header/required-fields",
            "error",
            `Missing required header field \`${field}\`. Every flightplan file needs ` +
              `version, kind, id, and description.`,
            { location: field },
          ),
        );
      }
    }
    return out;
  },
};

const headerValidKind: Rule = {
  id: "header/valid-kind",
  severity: "error",
  description: `\`kind\` must be one of: ${FILE_KINDS.join(" | ")}.`,
  run(ctx) {
    if (!ctx.doc) return [];
    const kind = ctx.doc.kind;
    if (kind === undefined) return []; // covered by header/required-fields
    if (typeof kind !== "string" || !(FILE_KINDS as readonly string[]).includes(kind)) {
      return [
        diag(
          ctx,
          "header/valid-kind",
          "error",
          `Invalid \`kind\` ${JSON.stringify(kind)}. Must be one of: ${FILE_KINDS.join(" | ")}.`,
          { location: "kind" },
        ),
      ];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------
// Imports rules (resolution precomputed in ctx.imports)
// ---------------------------------------------------------------------------

const importsResolve: Rule = {
  id: "imports/resolves",
  severity: "error",
  description: "Every imported module (and setup/teardown) must resolve to an existing file.",
  run(ctx) {
    if (!ctx.imports) return [];
    const out: Diagnostic[] = [];
    for (const ref of ctx.imports.refs) {
      if (!ref.exists) {
        const label =
          ref.relation === "import"
            ? "Imported module"
            : ref.relation === "run"
              ? "`run` step flow path"
              : `\`${ref.relation}\` module`;
        out.push(
          diag(
            ctx,
            "imports/resolves",
            "error",
            `${label} \`${ref.raw}\` does not resolve to an existing file ` +
              `(looked at ${ref.resolved}).`,
            { location: ref.raw },
          ),
        );
      }
    }
    return out;
  },
};

const importsNoCycle: Rule = {
  id: "imports/no-cycle",
  severity: "error",
  description: "Imports (including path-form `run` references) must not form a cycle.",
  run(ctx) {
    if (!ctx.imports?.cycle) return [];
    return [
      diag(
        ctx,
        "imports/no-cycle",
        "error",
        `Import cycle detected: ${ctx.imports.cycle.join(" -> ")}. Imports and \`run\` ` +
          `references must form a DAG.`,
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Step rules
// ---------------------------------------------------------------------------

const stepsUniqueIds: Rule = {
  id: "steps/unique-ids",
  severity: "error",
  description: "Step ids must be unique within a flow.",
  run(ctx) {
    const steps = rawSteps(ctx.doc);
    const seen = new Map<string, number>();
    const out: Diagnostic[] = [];
    steps.forEach((step, i) => {
      const id = step.id;
      if (typeof id !== "string" || id.length === 0) {
        out.push(
          diag(ctx, "steps/unique-ids", "error", `Step #${i} is missing a non-empty \`id\`.`, {
            location: `steps[${i}]`,
          }),
        );
        return;
      }
      const prev = seen.get(id);
      if (prev !== undefined) {
        out.push(
          diag(
            ctx,
            "steps/unique-ids",
            "error",
            `Duplicate step id \`${id}\` (also used by step #${prev}). Step ids must be unique.`,
            { stepId: id, location: `steps[${i}]` },
          ),
        );
      } else {
        seen.set(id, i);
      }
    });
    return out;
  },
};

const stepsSupportedDo: Rule = {
  id: "steps/supported-do",
  severity: "error",
  description: `\`do\` must be one of: ${STEP_DOS.join(", ")}.`,
  run(ctx) {
    const steps = rawSteps(ctx.doc);
    const out: Diagnostic[] = [];
    steps.forEach((step, i) => {
      const verb = step.do;
      if (verb === undefined) {
        out.push(
          diag(
            ctx,
            "steps/supported-do",
            "error",
            `Step \`${stepId(step, i)}\` is missing \`do\`.`,
            {
              stepId: stepId(step, i),
            },
          ),
        );
        return;
      }
      if (typeof verb !== "string" || !(STEP_DOS as readonly string[]).includes(verb)) {
        out.push(
          diag(
            ctx,
            "steps/supported-do",
            "error",
            `Step \`${stepId(step, i)}\` has unsupported \`do\` ${JSON.stringify(verb)}. ` +
              `Supported: ${STEP_DOS.join(", ")}.`,
            { stepId: stepId(step, i) },
          ),
        );
      }
    });
    return out;
  },
};

const stepsRequiredFields: Rule = {
  id: "steps/required-fields",
  severity: "error",
  description: "Each step type must carry its required fields (goto→url, fill→value, etc.).",
  run(ctx) {
    const steps = rawSteps(ctx.doc);
    const out: Diagnostic[] = [];
    steps.forEach((step, i) => {
      const verb = step.do;
      if (typeof verb !== "string") return; // handled by steps/supported-do
      const id = stepId(step, i);
      const requireField = (field: string, kind = "non-empty value"): void => {
        const v = step[field];
        const ok = v !== undefined && v !== null && !(typeof v === "string" && v.length === 0);
        if (!ok) {
          out.push(
            diag(
              ctx,
              "steps/required-fields",
              "error",
              `Step \`${id}\` (do = "${verb}") requires \`${field}\` (${kind}).`,
              { stepId: id, location: field },
            ),
          );
        }
      };
      switch (verb) {
        case "goto":
          requireField("url", "the URL to navigate to");
          break;
        case "fill":
          requireField("value", "the value to fill");
          break;
        case "select":
          requireField("value", "the option value to select");
          break;
        case "press":
          requireField("key", "the key to press");
          break;
        case "wait": {
          const ms = step.ms;
          if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0) {
            out.push(
              diag(
                ctx,
                "steps/required-fields",
                "error",
                `Step \`${id}\` (do = "wait") requires \`ms\` (a non-negative integer of milliseconds).`,
                { stepId: id, location: "ms" },
              ),
            );
          }
          break;
        }
        case "run":
          requireField("flow", "an imported flow id or a path to the flow to run");
          break;
        case "assert": {
          if (rawAsserts(step).length === 0) {
            out.push(
              diag(
                ctx,
                "steps/required-fields",
                "error",
                `Step \`${id}\` (do = "assert") requires at least one assertion ([[steps.assert]]).`,
                { stepId: id, location: "assert" },
              ),
            );
          }
          break;
        }
        // click / ai_pick: no schema-hard-required field (target presence is enforced by
        // steps/target-present, a distinct rule so it isolates precisely).
        default:
          break;
      }
    });
    return out;
  },
};

const stepsOnFailGotoExists: Rule = {
  id: "steps/on-fail-goto-exists",
  severity: "error",
  description: "`on_fail.goto` must reference an existing step id in the flow (or `self`).",
  run(ctx) {
    const steps = rawSteps(ctx.doc);
    // Set of every declared step id (the expanded, concrete ids — for_each is expanded upstream).
    const ids = new Set<string>();
    steps.forEach((step, i) => {
      const id = step.id;
      if (typeof id === "string" && id.length > 0) ids.add(id);
      else ids.add(`#${i}`);
    });
    const out: Diagnostic[] = [];
    steps.forEach((step, i) => {
      const onFail = step.on_fail;
      if (!isRecord(onFail)) return;
      const goto = onFail.goto;
      if (typeof goto !== "string" || goto.length === 0) {
        out.push(
          diag(
            ctx,
            "steps/on-fail-goto-exists",
            "error",
            `Step \`${stepId(step, i)}\` has an \`on_fail\` without a non-empty \`goto\` step id.`,
            { stepId: stepId(step, i), location: `steps[${i}].on_fail.goto` },
          ),
        );
        return;
      }
      // `self` always resolves (retry this step); any other value must name an existing step id.
      if (goto === "self" || goto === step.id) return;
      if (!ids.has(goto)) {
        // File-scoping (PLAN_v002 v002-9): a goto may not cross a `run` boundary. A namespaced
        // target under a `run` call-site id gets the precise boundary message.
        const prefix = goto.includes(":") ? goto.slice(0, goto.indexOf(":")) : null;
        const crossesRun = prefix !== null && steps.some((s) => s.do === "run" && s.id === prefix);
        const detail = crossesRun
          ? `\`on_fail.goto\` is file-scoped (it may not cross a \`run\` boundary): ` +
            `${JSON.stringify(goto)} targets a step inside the \`${prefix}\` run's child flow. ` +
            `Target a step in THIS file instead.`
          : `no step with that id exists in the flow. Use an existing step id in this file ` +
            `(\`goto\` is file-scoped and cannot reach into or out of a \`run\` child), or ` +
            `\`"self"\` to retry this step.`;
        out.push(
          diag(
            ctx,
            "steps/on-fail-goto-exists",
            "error",
            `Step \`${stepId(step, i)}\` has \`on_fail.goto = ${JSON.stringify(goto)}\`, but ${detail}`,
            { stepId: stepId(step, i), location: `steps[${i}].on_fail.goto` },
          ),
        );
      }
    });
    return out;
  },
};

// ---------------------------------------------------------------------------
// Composition rules — imports are a library, `run` executes (PLAN_v002 §3/§4).
// ---------------------------------------------------------------------------

/** Raw `run` steps from the doc, with their index (for diagnostics). */
function rawRunSteps(doc: RawDoc | null): Array<{ step: Record<string, unknown>; i: number }> {
  const out: Array<{ step: Record<string, unknown>; i: number }> = [];
  rawSteps(doc).forEach((step, i) => {
    if (step.do === "run") out.push({ step, i });
  });
  return out;
}

/**
 * The pre-v002 `[[imports]]` table form (`{ module = ..., with = ... }`) was removed
 * (v002-5). Reads the RAW doc so the precise migration message survives zod's whole-file
 * rejection (same escape-zod pattern as `steps/removed-targeting-fields`).
 */
const importsNoWith: Rule = {
  id: "imports/no-with",
  severity: "error",
  description: "The [[imports]]+`with` table form was removed — pass inputs at the `run` site.",
  run(ctx) {
    const imports = ctx.doc?.imports;
    if (!Array.isArray(imports)) return [];
    const out: Diagnostic[] = [];
    imports.forEach((entry, i) => {
      if (!isRecord(entry)) return;
      const mod = typeof entry.module === "string" ? entry.module : `#${i}`;
      const hasWith = "with" in entry;
      out.push(
        diag(
          ctx,
          "imports/no-with",
          "error",
          `Import \`${mod}\` uses the removed [[imports]] table form` +
            `${hasWith ? " with a `with` clause" : ""}. Imports are a library — nothing ` +
            `executes at import time, so import-site inputs are meaningless. Use ` +
            `\`imports = ["./path.toml", ...]\` and pass inputs at the run site: ` +
            `\`{ do = "run", flow = "<flow-id>", with = { ... } }\`.`,
          { location: `imports[${i}]` },
        ),
      );
    });
    return out;
  },
};

/**
 * Two imported modules may not declare the same flow `id` — the library label an id-form
 * `run.flow` resolves against must be unambiguous (v002-6).
 */
const importsUniqueIds: Rule = {
  id: "imports/unique-ids",
  severity: "error",
  description: "Imported modules must not declare duplicate flow ids.",
  run(ctx) {
    const scope = ctx.imports?.scope;
    if (!scope) return [];
    const byId = new Map<string, string[]>();
    for (const m of scope) {
      const list = byId.get(m.id) ?? [];
      list.push(m.path);
      byId.set(m.id, list);
    }
    const out: Diagnostic[] = [];
    for (const [id, paths] of byId) {
      if (paths.length < 2) continue;
      out.push(
        diag(
          ctx,
          "imports/unique-ids",
          "error",
          `Imported modules declare the same flow id \`${id}\`: ${paths.join(", ")}. ` +
            `An id-form \`run.flow\` reference must be unambiguous — rename one flow's \`id\`.`,
          { location: "imports" },
        ),
      );
    }
    return out;
  },
};

/**
 * An id-form `run.flow` must match a flow id registered via `imports` (directly or
 * transitively) in this file's scope (v002-6).
 */
const runFlowInScope: Rule = {
  id: "run/flow-in-scope",
  severity: "error",
  description: "An id-form `run.flow` must match an imported module's flow id.",
  run(ctx) {
    const scope = ctx.imports?.scope;
    // scope === null/undefined → imports unresolved (missing file / cycle / unparsed flow);
    // those cases already carry their own errors — stay silent instead of double-reporting.
    if (!scope) return [];
    const ids = [...new Set(scope.map((m) => m.id))].sort();
    const out: Diagnostic[] = [];
    for (const { step, i } of rawRunSteps(ctx.doc)) {
      const ref = step.flow;
      if (typeof ref !== "string" || ref.length === 0) continue; // steps/required-fields
      if (isRunFlowPath(ref)) continue; // path form — covered by imports/resolves
      if (ids.includes(ref)) continue;
      const sid = stepId(step, i);
      out.push(
        diag(
          ctx,
          "run/flow-in-scope",
          "error",
          `Step \`${sid}\` runs flow id \`${ref}\`, which matches no imported module. ` +
            `Flow ids in scope: ${ids.length > 0 ? ids.join(", ") : "<none>"}. Add the module ` +
            `to \`imports\`, or reference it by path (\`./file.toml\`).`,
          { stepId: sid, location: `steps[${i}].flow` },
        ),
      );
    }
    return out;
  },
};

/**
 * A directly-imported module never referenced by any `run` step in this file is a dead
 * library entry — harmless (it still composes locks), so warning only.
 */
const importsUnusedImport: Rule = {
  id: "imports/unused-import",
  severity: "warning",
  description: "An imported module should be referenced by at least one `run` step.",
  run(ctx) {
    if (!ctx.imports) return [];
    const runs = rawRunSteps(ctx.doc)
      .map(({ step }) => step.flow)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    const usedIds = new Set(runs.filter((v) => !isRunFlowPath(v)));
    const usedPaths = new Set(
      runs
        .filter((v) => isRunFlowPath(v))
        .map((v) => (isAbsolute(v) ? v : resolve(ctx.baseDir, v))),
    );
    const out: Diagnostic[] = [];
    for (const ref of ctx.imports.refs) {
      if (ref.relation !== "import") continue;
      const used =
        (ref.flowId !== undefined && usedIds.has(ref.flowId)) || usedPaths.has(ref.resolved);
      if (used) continue;
      out.push(
        diag(
          ctx,
          "imports/unused-import",
          "warning",
          `Imported module \`${ref.raw}\`${ref.flowId !== undefined ? ` (flow id \`${ref.flowId}\`)` : ""} ` +
            `is never referenced by a \`run\` step in this file — a dead library entry ` +
            `(harmless; it still composes locks).`,
          { location: ref.raw },
        ),
      );
    }
    return out;
  },
};

/**
 * A `run` step's `with` keys must all name inputs the child flow actually declares under
 * its [inputs] (PLAN_v002 §4 templating table).
 */
const templatingWithInputsDeclared: Rule = {
  id: "templating/with-inputs-declared",
  severity: "error",
  description: "A `run` step's `with` keys must name inputs the child flow declares.",
  run(ctx) {
    const info = ctx.imports;
    if (!info) return [];
    const out: Diagnostic[] = [];
    for (const { step, i } of rawRunSteps(ctx.doc)) {
      const withRec = step.with;
      const ref = step.flow;
      if (!isRecord(withRec) || typeof ref !== "string" || ref.length === 0) continue;
      // Resolve the child's declared input names: path form via the annotated run ref,
      // id form via the (unambiguous) scope entry. Unresolvable child → other rules report.
      let inputNames: string[] | null = null;
      let childLabel = ref;
      if (isRunFlowPath(ref)) {
        const r = info.refs.find((x) => x.relation === "run" && x.raw === ref);
        if (r?.inputNames !== undefined) inputNames = r.inputNames;
      } else if (info.scope) {
        const matches = info.scope.filter((m) => m.id === ref);
        if (matches.length === 1) {
          inputNames = matches[0]!.inputNames;
          childLabel = `${ref} (${matches[0]!.path})`;
        }
      }
      if (inputNames === null) continue;
      const sid = stepId(step, i);
      for (const key of Object.keys(withRec)) {
        if (inputNames.includes(key)) continue;
        out.push(
          diag(
            ctx,
            "templating/with-inputs-declared",
            "error",
            `Step \`${sid}\` passes \`with.${key}\`, but flow \`${childLabel}\` declares no ` +
              `[inputs] entry \`${key}\` (declared: ` +
              `${inputNames.length > 0 ? inputNames.join(", ") : "<none>"}).`,
            { stepId: sid, location: `steps[${i}].with.${key}` },
          ),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Assertion rules
// ---------------------------------------------------------------------------

/** Iterate every assertion across all steps with its step id + location. */
function eachAssertion(
  doc: RawDoc | null,
  fn: (a: Record<string, unknown>, sid: string, loc: string) => void,
): void {
  rawSteps(doc).forEach((step, i) => {
    const sid = stepId(step, i);
    rawAsserts(step).forEach((a, j) => {
      fn(a, sid, `steps[${i}].assert[${j}]`);
    });
  });
}

const assertSupportedType: Rule = {
  id: "assert/supported-type",
  severity: "error",
  description: `Assertion \`type\` must be one of: ${ASSERT_TYPES.join(", ")}.`,
  run(ctx) {
    const out: Diagnostic[] = [];
    eachAssertion(ctx.doc, (a, sid, loc) => {
      const t = a.type;
      if (t === undefined) {
        out.push(
          diag(
            ctx,
            "assert/supported-type",
            "error",
            `Assertion in step \`${sid}\` is missing \`type\`.`,
            {
              stepId: sid,
              location: loc,
            },
          ),
        );
        return;
      }
      if (typeof t !== "string" || !(ASSERT_TYPES as readonly string[]).includes(t)) {
        out.push(
          diag(
            ctx,
            "assert/supported-type",
            "error",
            `Unsupported assertion type ${JSON.stringify(t)} in step \`${sid}\`. ` +
              `Supported: ${ASSERT_TYPES.join(", ")}.`,
            { stepId: sid, location: loc },
          ),
        );
      }
    });
    return out;
  },
};

const assertRequiredFields: Rule = {
  id: "assert/required-fields",
  severity: "error",
  description: "Each assertion type must carry its required field (text→text, url→url, …).",
  run(ctx) {
    const out: Diagnostic[] = [];
    eachAssertion(ctx.doc, (a, sid, loc) => {
      const t = a.type;
      if (typeof t !== "string") return; // handled by assert/supported-type
      // Validate `when` if present.
      const when = a.when;
      if (
        when !== undefined &&
        (typeof when !== "string" || !(ASSERT_WHENS as readonly string[]).includes(when))
      ) {
        out.push(
          diag(
            ctx,
            "assert/required-fields",
            "error",
            `Assertion in step \`${sid}\` has invalid \`when\` ${JSON.stringify(when)} ` +
              `(must be one of: ${ASSERT_WHENS.join(", ")}).`,
            { stepId: sid, location: loc },
          ),
        );
      }
      const requireStr = (field: string): void => {
        const v = a[field];
        if (typeof v !== "string" || v.length === 0) {
          out.push(
            diag(
              ctx,
              "assert/required-fields",
              "error",
              `\`${t}\` assertion in step \`${sid}\` requires a \`${field}\` value.`,
              { stepId: sid, location: loc },
            ),
          );
        }
      };
      switch (t) {
        case "text":
          requireStr("text");
          break;
        case "url":
          requireStr("url");
          break;
        case "value":
          requireStr("value");
          break;
        case "count": {
          const c = a.count;
          if (typeof c !== "number" || !Number.isInteger(c) || c < 0) {
            out.push(
              diag(
                ctx,
                "assert/required-fields",
                "error",
                `\`count\` assertion in step \`${sid}\` requires a non-negative integer \`count\`.`,
                { stepId: sid, location: loc },
              ),
            );
          }
          break;
        }
        // visible / hidden: text + selector are both optional.
        // ai_judge: handled by assert/ai-judge-shape.
        default:
          break;
      }
    });
    return out;
  },
};

const assertAiJudgeShape: Rule = {
  id: "assert/ai-judge-shape",
  severity: "error",
  description:
    "ai_judge needs exactly one non-empty `prompt`, `inputs` restricted to source|text|screenshot, and no `threshold`.",
  run(ctx) {
    const out: Diagnostic[] = [];
    eachAssertion(ctx.doc, (a, sid, loc) => {
      if (a.type !== "ai_judge") return;
      // exactly one prompt — a non-empty string.
      const prompt = a.prompt;
      if (typeof prompt !== "string" || prompt.length === 0) {
        out.push(
          diag(
            ctx,
            "assert/ai-judge-shape",
            "error",
            `\`ai_judge\` in step \`${sid}\` requires exactly one non-empty \`prompt\`.`,
            { stepId: sid, location: loc },
          ),
        );
      }
      // NO threshold field.
      if ("threshold" in a) {
        out.push(
          diag(
            ctx,
            "assert/ai-judge-shape",
            "error",
            `\`ai_judge\` in step \`${sid}\` must not carry a \`threshold\` — it is a boolean judge, ` +
              `not a scored match.`,
            { stepId: sid, location: `${loc}.threshold` },
          ),
        );
      }
      // inputs (optional) restricted to the allowed modalities.
      const inputs = a.inputs;
      if (inputs !== undefined) {
        if (!Array.isArray(inputs)) {
          out.push(
            diag(
              ctx,
              "assert/ai-judge-shape",
              "error",
              `\`ai_judge\` \`inputs\` in step \`${sid}\` must be an array of ` +
                `${AI_JUDGE_INPUTS.join("|")}.`,
              { stepId: sid, location: `${loc}.inputs` },
            ),
          );
        } else {
          for (const m of inputs) {
            if (typeof m !== "string" || !(AI_JUDGE_INPUTS as readonly string[]).includes(m)) {
              out.push(
                diag(
                  ctx,
                  "assert/ai-judge-shape",
                  "error",
                  `\`ai_judge\` \`inputs\` in step \`${sid}\` has unsupported modality ` +
                    `${JSON.stringify(m)} (allowed: ${AI_JUDGE_INPUTS.join(", ")}).`,
                  { stepId: sid, location: `${loc}.inputs` },
                ),
              );
            }
          }
        }
      }
    });
    return out;
  },
};

const assertStepNeedsAssertion: Rule = {
  id: "assert/step-needs-assertion",
  severity: "error",
  description: 'A `do = "assert"` step must declare at least one assertion.',
  run(ctx) {
    // Subsumed in spirit by steps/required-fields, but kept as a distinct ruleId so a flow
    // author / test can target the "assert step with no assertions" case precisely.
    const out: Diagnostic[] = [];
    rawSteps(ctx.doc).forEach((step, i) => {
      if (step.do !== "assert") return;
      if (rawAsserts(step).length === 0) {
        out.push(
          diag(
            ctx,
            "assert/step-needs-assertion",
            "error",
            `Step \`${stepId(step, i)}\` is a \`assert\` step but declares no assertions.`,
            { stepId: stepId(step, i), location: `steps[${i}].assert` },
          ),
        );
      }
    });
    return out;
  },
};

// ---------------------------------------------------------------------------
// Templating / inputs rules
// ---------------------------------------------------------------------------

/** Declared inputs from the raw doc (names only). */
function declaredInputs(doc: RawDoc | null): Set<string> {
  const set = new Set<string>();
  if (!doc) return set;
  const inputs = doc.inputs;
  if (isRecord(inputs)) {
    for (const k of Object.keys(inputs)) set.add(k);
  }
  return set;
}

const templatingUndeclaredInput: Rule = {
  id: "templating/undeclared-input",
  severity: "error",
  description: "Every ${inputs.X} referenced in a step must be a declared [inputs] entry.",
  run(ctx) {
    const declared = declaredInputs(ctx.doc);
    const out: Diagnostic[] = [];
    const seen = new Set<string>(); // dedupe (name@stepId)
    rawSteps(ctx.doc).forEach((step, i) => {
      const sid = stepId(step, i);
      const leaves: Array<{ path: string; value: string }> = [];
      collectStrings(step, "", leaves);
      for (const leaf of leaves) {
        for (const ref of collectRefs(leaf.value)) {
          if (ref.source !== "inputs") continue;
          if (declared.has(ref.name)) continue;
          const key = `${ref.name}@${sid}@${leaf.path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(
            diag(
              ctx,
              "templating/undeclared-input",
              "error",
              `Step \`${sid}\` references undeclared input \`${ref.raw}\`. ` +
                `Declare \`${ref.name}\` under [inputs] (or pass it via an import's \`with\`).`,
              { stepId: sid, location: leaf.path || undefined },
            ),
          );
        }
      }
    });
    return out;
  },
};

const templatingEnvRefs: Rule = {
  id: "templating/env-refs",
  severity: "warning",
  description: "Reports every ${env.X} reference so required environment variables are visible.",
  run(ctx) {
    const out: Diagnostic[] = [];
    // Scan the entire doc (steps + inputs defaults), collect unique env var names.
    const names = new Set<string>();
    const leaves: Array<{ path: string; value: string }> = [];
    if (ctx.doc) collectStrings(ctx.doc, "", leaves);
    for (const leaf of leaves) {
      for (const ref of collectRefs(leaf.value)) {
        if (ref.source === "env") names.add(ref.name);
      }
    }
    if (names.size > 0) {
      out.push(
        diag(
          ctx,
          "templating/env-refs",
          "warning",
          `This file requires the following environment variable(s) at run time: ` +
            `${[...names]
              .sort()
              .map((n) => `\${env.${n}}`)
              .join(", ")}.`,
        ),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Path rules (lock / output dir validity)
// ---------------------------------------------------------------------------

const pathsLockWritable: Rule = {
  id: "paths/lock-writable",
  severity: "warning",
  description: "A configured lock path's parent directory should exist (or be creatable).",
  run(ctx) {
    if (!ctx.doc) return [];
    const lockPath = readArtifactPath(ctx.doc, "lock_path");
    if (lockPath === null) return [];
    return checkParentDir(ctx, lockPath, "paths/lock-writable", "lock");
  },
};

const pathsOutWritable: Rule = {
  id: "paths/out-writable",
  severity: "warning",
  description: "A configured output directory's parent should exist (or be creatable).",
  run(ctx) {
    if (!ctx.doc) return [];
    const outDir = readArtifactPath(ctx.doc, "out_dir");
    if (outDir === null) return [];
    return checkParentDir(ctx, outDir, "paths/out-writable", "output");
  },
};

/** Read `[artifacts] <field>` (under top-level `artifacts` or `config.artifacts`). */
function readArtifactPath(doc: RawDoc, field: string): string | null {
  const candidates: unknown[] = [];
  const topArtifacts = doc.artifacts;
  if (isRecord(topArtifacts)) candidates.push(topArtifacts[field]);
  const config = doc.config;
  if (isRecord(config) && isRecord(config.artifacts)) {
    candidates.push(config.artifacts[field]);
  }
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

/** Warn when the parent directory of a configured path does not exist. */
function checkParentDir(ctx: LintContext, p: string, ruleId: string, label: string): Diagnostic[] {
  const abs = isAbsolute(p) ? p : resolve(ctx.baseDir, p);
  const parent = dirname(abs);
  if (!existsSync(parent)) {
    return [
      diag(
        ctx,
        ruleId,
        "warning",
        `Configured ${label} path \`${p}\` resolves to ${abs}, but its parent directory ` +
          `${parent} does not exist. It will need to be created before a run can write there.`,
        { location: p },
      ),
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Targeting rules (PLAN_v002 §1/§4) — unified `target` locator list.
// ---------------------------------------------------------------------------

/**
 * `hints`/`intent` were removed from the schema (v002-3, clean break — `.strict()` rejects
 * them). This rule reads the RAW doc so it fires even though zod's whole-file rejection would
 * otherwise swallow the specific cause, and gives the precise migration recipe: fold both
 * fields into the new `target` list, selectors first, one NL entry last.
 */
const stepsRemovedTargetingFields: Rule = {
  id: "steps/removed-targeting-fields",
  severity: "error",
  description: "`hints` and `intent` were removed — fold them into the `target` locator list.",
  run(ctx) {
    const out: Diagnostic[] = [];
    rawSteps(ctx.doc).forEach((step, i) => {
      const sid = stepId(step, i);
      const hasHints = "hints" in step;
      const hasIntent = "intent" in step;
      if (!hasHints && !hasIntent) return;
      const removed = [hasHints ? "hints" : null, hasIntent ? "intent" : null]
        .filter((v): v is string => v !== null)
        .join(" and ");
      out.push(
        diag(
          ctx,
          "steps/removed-targeting-fields",
          "error",
          `Step \`${sid}\` uses the removed \`${removed}\` field(s). \`target\` is now a single ` +
            `ordered locator list: fold your explicit selectors (former \`hints\`) and your NL ` +
            `query (former \`intent\`/\`target\`) into one \`target = [...]\`, selectors first, ` +
            `one natural-language entry last — e.g. ` +
            `\`target = ["[data-testid='x']", "the Next button"]\`.`,
          { stepId: sid, location: hasHints ? "hints" : "intent" },
        ),
      );
    });
    return out;
  },
};

/** A targeting step (click/fill/select/ai_pick) must declare a non-empty `target`. */
const stepsTargetPresent: Rule = {
  id: "steps/target-present",
  severity: "error",
  description: "click/fill/select/ai_pick steps require a non-empty `target`.",
  run(ctx) {
    const out: Diagnostic[] = [];
    rawSteps(ctx.doc).forEach((step, i) => {
      const verb = step.do;
      if (typeof verb !== "string" || !TARGETING_DOS.has(verb)) return;
      const entries = rawTargetEntries(step);
      if (entries.length > 0) return;
      const sid = stepId(step, i);
      out.push(
        diag(
          ctx,
          "steps/target-present",
          "error",
          `Step \`${sid}\` (do = "${verb}") requires a non-empty \`target\` — an unresolvable ` +
            `targeting step can't run.`,
          { stepId: sid, location: "target" },
        ),
      );
    });
    return out;
  },
};

/**
 * A targeting step's `target` list should include at least one natural-language entry so a
 * heal has something to re-resolve against when every authored selector drifts. Selectors-only
 * targeting is legal (v002-1) but risky — warn, don't fail.
 */
const stepsTargetNeedsNl: Rule = {
  id: "steps/target-needs-nl",
  severity: "warning",
  description: "A step's `target` list should include at least one natural-language entry.",
  run(ctx) {
    const out: Diagnostic[] = [];
    rawSteps(ctx.doc).forEach((step, i) => {
      const verb = step.do;
      if (typeof verb !== "string" || !TARGETING_DOS.has(verb)) return;
      const entries = rawTargetEntries(step);
      if (entries.length === 0) return; // steps/target-present already covers this
      if (normalizeTarget(entries).nl !== undefined) return;
      const sid = stepId(step, i);
      out.push(
        diag(
          ctx,
          "steps/target-needs-nl",
          "warning",
          `Step \`${sid}\`'s \`target\` list has selector entries but no natural-language entry. ` +
            `Add one (e.g. append "the Next button") so a heal has an anchor if every selector drifts.`,
          { stepId: sid, location: "target" },
        ),
      );
    });
    return out;
  },
};

/**
 * Heuristic: does an NL-classified `target` entry actually look like an unprefixed selector
 * (CSS id/class, attribute selector, xpath, a CSS combinator)? If so the author probably meant
 * a selector and should use the `css:` prefix — misclassification is otherwise impossible by
 * construction (v002-2), but this catches the likely-a-typo case.
 */
function looksLikeUnprefixedSelector(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  // xpath
  if (v.startsWith("//") || v.startsWith("(/")) return true;
  // explicit engine prefixes some tools use (not part of flightplan's whitelist)
  if (/^(css=|xpath=)/.test(v)) return true;
  // id / class selectors at the start
  if (/^[#.][A-Za-z_]/.test(v)) return true;
  // attribute selector [data-testid='x'] / [name="y"] mid-string or at the start
  if (/\[[A-Za-z][\w-]*([~|^$*]?=|\])/.test(v)) return true;
  // CSS child combinator: a `>` between selector-ish tokens (NL prose never uses ` > ` this way).
  if (/[\w#.\]]\s*>\s*[\w#.[]/.test(v)) return true;
  return false;
}

const stepsTargetUnprefixedSelector: Rule = {
  id: "steps/target-unprefixed-selector",
  severity: "warning",
  description: "An NL-classified `target` entry looks like a selector — prefix it with `css:`.",
  run(ctx) {
    const out: Diagnostic[] = [];
    rawSteps(ctx.doc).forEach((step, i) => {
      const sid = stepId(step, i);
      for (const entry of rawTargetEntries(step)) {
        if (classifyLocator(entry) !== "nl") continue; // already a recognized selector
        if (!looksLikeUnprefixedSelector(entry)) continue;
        out.push(
          diag(
            ctx,
            "steps/target-unprefixed-selector",
            "warning",
            `Step \`${sid}\`'s \`target\` entry ${JSON.stringify(entry)} looks like a selector but ` +
              `has no recognized prefix, so it is classified as natural language. If a selector was ` +
              `intended, prefix it with \`css:\` (e.g. ${JSON.stringify(`css:${entry}`)}).`,
            { stepId: sid, location: "target" },
          ),
        );
      }
    });
    return out;
  },
};

/**
 * An authored `text:` selector matches ANY element containing that text (browser-pilot's bare
 * `text:` is unscoped — the drift-c `<code>` footgun). Prefer `role:Role:Name` for precision.
 */
const stepsTextHintUnscoped: Rule = {
  id: "steps/text-hint-unscoped",
  severity: "warning",
  description: "A `text:` selector entry matches any element containing the text — scope it.",
  run(ctx) {
    const out: Diagnostic[] = [];
    rawSteps(ctx.doc).forEach((step, i) => {
      const sid = stepId(step, i);
      for (const entry of rawTargetEntries(step)) {
        if (!entry.trim().startsWith("text:")) continue;
        out.push(
          diag(
            ctx,
            "steps/text-hint-unscoped",
            "warning",
            `Step \`${sid}\`'s \`target\` entry ${JSON.stringify(entry)} uses an unscoped \`text:\` ` +
              `selector, which matches ANY element containing that text (including e.g. a <code> ` +
              `block). Prefer \`role:Role:Name\` (e.g. \`role:button:Next\`) for a precise match.`,
            { stepId: sid, location: "target" },
          ),
        );
      }
    });
    return out;
  },
};

/**
 * The TOML footgun (PLAN_v002 §2): a bare top-level array key must precede any table header, so
 * `steps = [...]` written after `[inputs]`/`[run]` silently nests as `inputs.steps`/`run.steps`
 * instead of a top-level `steps`. Detect the absorbed shape directly on the raw doc.
 */
const stepsTomlKeyOrder: Rule = {
  id: "steps/toml-key-order",
  severity: "error",
  description: "`steps` must not be absorbed into `[inputs]`/`[run]` by TOML key ordering.",
  run(ctx) {
    if (!ctx.doc) return [];
    if (Array.isArray(ctx.doc.steps)) return []; // top-level steps present — not absorbed
    const absorbedUnder = (["inputs", "run"] as const).find((k) => {
      const v = ctx.doc?.[k];
      return isRecord(v) && Array.isArray(v.steps);
    });
    if (!absorbedUnder) return [];
    return [
      diag(
        ctx,
        "steps/toml-key-order",
        "error",
        `\`steps\` appears to be nested under \`[${absorbedUnder}]\`. In TOML a top-level array ` +
          `key must precede any table header — move \`steps = [...]\` above \`[${absorbedUnder}]\`, ` +
          `or use \`[[steps]]\` blocks.`,
        { location: `${absorbedUnder}.steps` },
      ),
    ];
  },
};

/**
 * A step whose ONLY assertion is `ai_judge` gets a warning recommending a deterministic
 * companion assertion — "if you want it to fail, assert it" deterministically. PLAN.md §8
 * starter ruleset ("a critical assertion can't be ai_judge-only").
 */
const assertCriticalNotAiOnly: Rule = {
  id: "assert/critical-not-ai-only",
  severity: "warning",
  description:
    "A step guarded only by ai_judge should also have a deterministic assertion (ai_judge never heals and is non-deterministic).",
  run(ctx) {
    const out: Diagnostic[] = [];
    rawSteps(ctx.doc).forEach((step, i) => {
      const asserts = rawAsserts(step);
      if (asserts.length === 0) return;
      const types = asserts.map((a) => a.type).filter((t): t is string => typeof t === "string");
      if (types.length === 0) return;
      const allAiJudge = types.every((t) => t === "ai_judge");
      if (allAiJudge) {
        out.push(
          diag(
            ctx,
            "assert/critical-not-ai-only",
            "warning",
            `Step \`${stepId(step, i)}\` is guarded only by \`ai_judge\` assertion(s). ` +
              `Add at least one deterministic assertion (visible/text/url/value/count) — ` +
              `ai_judge is non-deterministic and never heals.`,
            { stepId: stepId(step, i), location: `steps[${i}].assert` },
          ),
        );
      }
    });
    return out;
  },
};

const lockStaleSourceHash: Rule = {
  id: "lock/stale-source-hash",
  severity: "warning",
  description:
    "If a lock file exists and its source_hash differs from the flow's, the lock may be stale.",
  run(ctx) {
    if (!ctx.lock || ctx.lock.sourceHash === null) return [];
    if (ctx.lock.sourceHash === ctx.sourceHash) return [];
    return [
      diag(
        ctx,
        "lock/stale-source-hash",
        "warning",
        `Lock file ${ctx.lock.path} records source_hash ${ctx.lock.sourceHash} but the flow's ` +
          `current source_hash is ${ctx.sourceHash}. The lock may be stale — re-run to heal, ` +
          `or regenerate the lock.`,
        { location: ctx.lock.path },
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// v002 Phase 3 rules (composition-independent) — PLAN_v002 §4, PLAN_v003 §4 (v003-2).
// ---------------------------------------------------------------------------

/** Verbs that change page/app state (so their outcome is worth asserting). */
const STATE_CHANGING_DOS = new Set(["goto", "click", "fill", "select", "press", "ai_pick"]);

/** Secret-suggesting env-var name pattern (PLAN_v002 §4 `security/unmarked-secret`). */
const SECRET_ENV_RE = /pass|secret|token|key|otp/i;

/**
 * Read the flow-level `[config.ai.models]` registry from the raw doc, if present. Returns `null`
 * when no explicit registry is configured (the built-in default vision model then applies).
 */
function rawModelRegistry(doc: RawDoc | null): Record<string, unknown> | null {
  if (!doc) return null;
  const config = doc.config;
  if (!isRecord(config)) return null;
  const ai = config.ai;
  if (!isRecord(ai)) return null;
  const models = ai.models;
  return isRecord(models) ? models : null;
}

/**
 * An `ai_judge` assertion with a `screenshot` input needs a vision-capable model. The built-in
 * default registry always ships a `vision` role, so this only fires when the flow EXPLICITLY
 * configures `[config.ai.models]` (adding e.g. a resolver/advisor) but omits `vision` — the
 * author set up the registry and forgot the one role the screenshot judge requires. A flow with
 * no explicit registry keeps the default vision model, so it stays clean.
 */
const assertScreenshotNeedsVision: Rule = {
  id: "assert/screenshot-needs-vision",
  severity: "warning",
  description:
    "An ai_judge with a `screenshot` input needs a vision model — a configured [ai.models] registry must not omit the `vision` role.",
  run(ctx) {
    const registry = rawModelRegistry(ctx.doc);
    // No explicit registry → the built-in default vision model applies; nothing to warn about.
    if (registry === null) return [];
    if (isRecord(registry.vision)) return []; // vision role is configured
    const out: Diagnostic[] = [];
    eachAssertion(ctx.doc, (a, sid, loc) => {
      if (a.type !== "ai_judge") return;
      const inputs = a.inputs;
      if (!Array.isArray(inputs) || !inputs.includes("screenshot")) return;
      out.push(
        diag(
          ctx,
          "assert/screenshot-needs-vision",
          "warning",
          `\`ai_judge\` in step \`${sid}\` requests a \`screenshot\` input, but the configured ` +
            `\`[config.ai.models]\` registry has no \`vision\` role. Add a \`[config.ai.models.vision]\` ` +
            `model (or drop the explicit registry to use the built-in default vision model).`,
          { stepId: sid, location: `${loc}.inputs` },
        ),
      );
    });
    return out;
  },
};

/**
 * A flow whose FINAL step changes state (goto/click/fill/select/press/ai_pick) but attaches no
 * assertion leaves the outcome unvalidated — "if you want it to fail, assert it." A trailing
 * `do = "assert"` step or an inline `[[steps.assert]]` on the final step satisfies the check;
 * a flow ending in `wait` (or with no steps) is not flagged.
 */
const assertEndStateUnasserted: Rule = {
  id: "assert/end-state-unasserted",
  severity: "warning",
  description:
    "The final step changes state but has no terminal assertion — nothing validates the flow's outcome.",
  run(ctx) {
    const steps = rawSteps(ctx.doc);
    if (steps.length === 0) return [];
    const lastIndex = steps.length - 1;
    const last = steps[lastIndex];
    if (last === undefined) return [];
    const verb = last.do;
    if (typeof verb !== "string") return []; // covered by steps/supported-do
    // A trailing `assert` step IS the terminal assertion.
    if (verb === "assert") return [];
    // Only state-changing final steps are worth asserting (a trailing `wait` is not).
    if (!STATE_CHANGING_DOS.has(verb)) return [];
    // An inline assertion on the final step satisfies the check.
    if (rawAsserts(last).length > 0) return [];
    const sid = stepId(last, lastIndex);
    return [
      diag(
        ctx,
        "assert/end-state-unasserted",
        "warning",
        `The flow's final step \`${sid}\` (do = "${verb}") changes state but has no assertion, so ` +
          `nothing validates the outcome. Add a terminal assertion (an inline [[steps.assert]] or a ` +
          `\`do = "assert"\` step) — if you want the flow to fail on a bad end state, assert it.`,
        { stepId: sid, location: `steps[${lastIndex}]` },
      ),
    ];
  },
};

/**
 * A declared `[inputs]` entry that no step references via `${inputs.<name>}` is dead — likely a
 * typo or a leftover after an edit. Warn (harmless, but noise). References are matched across
 * every string leaf of every step (mirrors `templating/undeclared-input`).
 */
const templatingUnusedInput: Rule = {
  id: "templating/unused-input",
  severity: "warning",
  description: "A declared [inputs] entry that no step references via ${inputs.X}.",
  run(ctx) {
    const declared = declaredInputs(ctx.doc);
    if (declared.size === 0) return [];
    // Collect every referenced input name across all steps.
    const used = new Set<string>();
    for (const step of rawSteps(ctx.doc)) {
      const leaves: Array<{ path: string; value: string }> = [];
      collectStrings(step, "", leaves);
      for (const leaf of leaves) {
        for (const ref of collectRefs(leaf.value)) {
          if (ref.source === "inputs") used.add(ref.name);
        }
      }
    }
    const out: Diagnostic[] = [];
    for (const name of declared) {
      if (used.has(name)) continue;
      out.push(
        diag(
          ctx,
          "templating/unused-input",
          "warning",
          `Declared input \`${name}\` is never referenced by any step (no \`\${inputs.${name}}\`). ` +
            `Remove it from [inputs], or reference it — an unused input is dead configuration.`,
          { location: `inputs.${name}` },
        ),
      );
    }
    return out;
  },
};

/**
 * A sidecar lock file records learned targets keyed by `step` id. When the flow no longer
 * declares a step of that id (renamed/removed), the lock entry is orphaned — it can never match
 * again. Read the lock directly from `ctx.lock.path` (the context only pre-reads the source_hash).
 */
const lockOrphanedTarget: Rule = {
  id: "lock/orphaned-target",
  severity: "warning",
  description: "A lock target references a step id that no longer exists in the flow.",
  run(ctx) {
    if (!ctx.lock) return [];
    if (!existsSync(ctx.lock.path)) return [];
    let lockDoc: unknown;
    try {
      lockDoc = parseToml(readFileSync(ctx.lock.path, "utf8"), ctx.lock.path);
    } catch {
      // A malformed lock is not this rule's concern (the lock manager validates it).
      return [];
    }
    if (!isRecord(lockDoc)) return [];
    const targets = asArray(lockDoc.targets).filter(isRecord);
    if (targets.length === 0) return [];
    // Set of step ids in the (for_each-expanded) flow.
    const ids = new Set<string>();
    rawSteps(ctx.doc).forEach((step, i) => {
      const id = step.id;
      ids.add(typeof id === "string" && id.length > 0 ? id : `#${i}`);
    });
    const out: Diagnostic[] = [];
    const reported = new Set<string>();
    for (const t of targets) {
      const step = t.step;
      if (typeof step !== "string" || step.length === 0) continue;
      if (ids.has(step)) continue;
      if (reported.has(step)) continue;
      reported.add(step);
      out.push(
        diag(
          ctx,
          "lock/orphaned-target",
          "warning",
          `Lock file ${ctx.lock.path} has a learned target for step \`${step}\`, but no step with ` +
            `that id exists in the flow (renamed or removed?). The orphaned lock entry can never ` +
            `match — prune it or re-run to regenerate the lock.`,
          { stepId: step, location: ctx.lock.path },
        ),
      );
    }
    return out;
  },
};

/**
 * A `fill`/`select`/`goto` step whose value/url interpolates a secret-looking env var
 * (`${env.X}` where X matches /pass|secret|token|key|otp/i) but does not carry `secret = true`
 * leaks that value into artifacts/logs unredacted. Warn so the author marks it (PLAN_v002 §4).
 */
const securityUnmarkedSecret: Rule = {
  id: "security/unmarked-secret",
  severity: "warning",
  description:
    "A fill/select/goto value referencing a secret-looking env var (/pass|secret|token|key|otp/i) should set `secret = true`.",
  run(ctx) {
    const out: Diagnostic[] = [];
    const reported = new Set<string>();
    rawSteps(ctx.doc).forEach((step, i) => {
      const verb = step.do;
      if (verb !== "fill" && verb !== "select" && verb !== "goto") return;
      if (step.secret === true) return; // already marked — nothing to warn
      // The value field carrying the interpolation: `value` for fill/select, `url` for goto.
      const field = verb === "goto" ? "url" : "value";
      const raw = step[field];
      if (typeof raw !== "string") return;
      const sid = stepId(step, i);
      for (const ref of collectRefs(raw)) {
        if (ref.source !== "env") continue;
        if (!SECRET_ENV_RE.test(ref.name)) continue;
        const key = `${sid}@${field}@${ref.name}`;
        if (reported.has(key)) continue;
        reported.add(key);
        out.push(
          diag(
            ctx,
            "security/unmarked-secret",
            "warning",
            `Step \`${sid}\` (do = "${verb}") interpolates a secret-looking env var \`${ref.raw}\` ` +
              `into \`${field}\` but is not marked \`secret = true\`, so the value will not be ` +
              `redacted in logs/artifacts. Add \`secret = true\` to this step.`,
            { stepId: sid, location: `steps[${i}].${field}` },
          ),
        );
      }
    });
    return out;
  },
};

// ---------------------------------------------------------------------------
// The registry — ordered; append to extend.
// ---------------------------------------------------------------------------

/** All flow + config rules, in reporting order. */
export const RULES: readonly Rule[] = [
  headerRequiredFields,
  headerValidKind,
  importsResolve,
  importsNoCycle,
  importsNoWith,
  importsUniqueIds,
  importsUnusedImport,
  runFlowInScope,
  templatingWithInputsDeclared,
  stepsUniqueIds,
  stepsSupportedDo,
  stepsRequiredFields,
  stepsOnFailGotoExists,
  stepsTomlKeyOrder,
  stepsRemovedTargetingFields,
  stepsTargetPresent,
  stepsTargetNeedsNl,
  stepsTargetUnprefixedSelector,
  stepsTextHintUnscoped,
  assertSupportedType,
  assertRequiredFields,
  assertAiJudgeShape,
  assertStepNeedsAssertion,
  templatingUndeclaredInput,
  templatingEnvRefs,
  pathsLockWritable,
  pathsOutWritable,
  assertCriticalNotAiOnly,
  lockStaleSourceHash,
  // v002 Phase 3 (composition-independent) — appended per PLAN_v003 v003-2.
  assertScreenshotNeedsVision,
  assertEndStateUnasserted,
  templatingUnusedInput,
  lockOrphanedTarget,
  securityUnmarkedSecret,
];

/** Rule ids only — for tooling/tests. */
export const RULE_IDS: readonly string[] = RULES.map((r) => r.id);

// Re-export the heuristic for unit testing.
export { looksLikeUnprefixedSelector };
