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

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  AI_JUDGE_INPUTS,
  ASSERT_TYPES,
  ASSERT_WHENS,
  FILE_KINDS,
  STEP_DOS,
} from "../types.ts";
import { collectRefs } from "../flow/index.ts";
import { diag, type LintContext, type RawDoc, type Rule } from "./context.ts";
import type { Diagnostic } from "./types.ts";

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
  return asArray(doc["steps"]).filter(isRecord);
}

/** The `assert` array on a raw step record. */
function rawAsserts(step: Record<string, unknown>): Record<string, unknown>[] {
  return asArray(step["assert"]).filter(isRecord);
}

/** Best-effort step id for diagnostics (raw, may be absent). */
function stepId(step: Record<string, unknown>, index: number): string {
  const id = step["id"];
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
    value.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
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
    const kind = ctx.doc["kind"];
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
        out.push(
          diag(
            ctx,
            "imports/resolves",
            "error",
            `${ref.relation === "import" ? "Imported module" : `\`${ref.relation}\` module`} ` +
              `\`${ref.raw}\` does not resolve to an existing file (looked at ${ref.resolved}).`,
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
  description: "Imports must not form a cycle.",
  run(ctx) {
    if (!ctx.imports?.cycle) return [];
    return [
      diag(
        ctx,
        "imports/no-cycle",
        "error",
        `Import cycle detected: ${ctx.imports.cycle.join(" -> ")}. Imports must form a DAG.`,
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
      const id = step["id"];
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
      const verb = step["do"];
      if (verb === undefined) {
        out.push(
          diag(ctx, "steps/supported-do", "error", `Step \`${stepId(step, i)}\` is missing \`do\`.`, {
            stepId: stepId(step, i),
          }),
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
      const verb = step["do"];
      if (typeof verb !== "string") return; // handled by steps/supported-do
      const id = stepId(step, i);
      const require = (field: string, kind = "non-empty value"): void => {
        const v = step[field];
        const ok =
          v !== undefined &&
          v !== null &&
          !(typeof v === "string" && v.length === 0);
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
          require("url", "the URL to navigate to");
          break;
        case "fill":
          require("value", "the value to fill");
          break;
        case "select":
          require("value", "the option value to select");
          break;
        case "press":
          require("key", "the key to press");
          break;
        case "wait": {
          const ms = step["ms"];
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
        // click / ai_pick: no hard-required field (target/hints/intent are all optional).
        default:
          break;
      }
    });
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
    rawAsserts(step).forEach((a, j) => fn(a, sid, `steps[${i}].assert[${j}]`));
  });
}

const assertSupportedType: Rule = {
  id: "assert/supported-type",
  severity: "error",
  description: `Assertion \`type\` must be one of: ${ASSERT_TYPES.join(", ")}.`,
  run(ctx) {
    const out: Diagnostic[] = [];
    eachAssertion(ctx.doc, (a, sid, loc) => {
      const t = a["type"];
      if (t === undefined) {
        out.push(
          diag(ctx, "assert/supported-type", "error", `Assertion in step \`${sid}\` is missing \`type\`.`, {
            stepId: sid,
            location: loc,
          }),
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
      const t = a["type"];
      if (typeof t !== "string") return; // handled by assert/supported-type
      // Validate `when` if present.
      const when = a["when"];
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
          const c = a["count"];
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
      if (a["type"] !== "ai_judge") return;
      // exactly one prompt — a non-empty string.
      const prompt = a["prompt"];
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
      const inputs = a["inputs"];
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
  description: "A `do = \"assert\"` step must declare at least one assertion.",
  run(ctx) {
    // Subsumed in spirit by steps/required-fields, but kept as a distinct ruleId so a flow
    // author / test can target the "assert step with no assertions" case precisely.
    const out: Diagnostic[] = [];
    rawSteps(ctx.doc).forEach((step, i) => {
      if (step["do"] !== "assert") return;
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
  const inputs = doc["inputs"];
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
            `${[...names].sort().map((n) => `\${env.${n}}`).join(", ")}.`,
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
  const topArtifacts = doc["artifacts"];
  if (isRecord(topArtifacts)) candidates.push(topArtifacts[field]);
  const config = doc["config"];
  if (isRecord(config) && isRecord(config["artifacts"])) {
    candidates.push((config["artifacts"] as Record<string, unknown>)[field]);
  }
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

/** Warn when the parent directory of a configured path does not exist. */
function checkParentDir(
  ctx: LintContext,
  p: string,
  ruleId: string,
  label: string,
): Diagnostic[] {
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
// Starter ruleset (higher-value semantic rules)
// ---------------------------------------------------------------------------

/**
 * Heuristic: does a target/hint string look like a hard-coded selector (CSS/xpath) rather
 * than a natural-language target or intent? `hints` legitimately CAN contain selectors (they
 * are explicit L1 hints), so this rule fires only on `target` (the NL field) — PLAN.md §4
 * says click/fill/select/ai_pick target is an NL description.
 */
function looksLikeRawSelector(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  // xpath
  if (v.startsWith("//") || v.startsWith("(/")) return true;
  // explicit engine prefixes
  if (/^(css=|xpath=|text=)/.test(v)) return true;
  // id / class selectors at the start
  if (/^[#.][A-Za-z_]/.test(v)) return true;
  // attribute selector [data-testid='x'] / [name="y"]
  if (/^\[[A-Za-z][\w-]*([~|^$*]?=|\])/.test(v)) return true;
  // CSS child combinator: a `>` between selector-ish tokens (NL targets never use ` > `).
  // e.g. "div > .btn", "#host > button", "ul>li". A natural-language target would never
  // contain a bare `>` between identifier-like tokens.
  if (/[\w#.\]]\s*>\s*[\w#.[]/.test(v)) return true;
  return false;
}

const stepsNoRawSelector: Rule = {
  id: "steps/no-raw-selector",
  severity: "error",
  description:
    "Step `target` must be a natural-language description, not a hard-coded CSS/xpath selector.",
  run(ctx) {
    const out: Diagnostic[] = [];
    rawSteps(ctx.doc).forEach((step, i) => {
      const sid = stepId(step, i);
      const target = step["target"];
      if (typeof target === "string" && looksLikeRawSelector(target)) {
        out.push(
          diag(
            ctx,
            "steps/no-raw-selector",
            "error",
            `Step \`${sid}\` uses a raw selector in \`target\` (${JSON.stringify(target)}). ` +
              `Use a natural-language \`target\`/\`intent\`, and put any explicit selectors in \`hints\`.`,
            { stepId: sid, location: "target" },
          ),
        );
      }
    });
    return out;
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
      const types = asserts
        .map((a) => a["type"])
        .filter((t): t is string => typeof t === "string");
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
// The registry — ordered; append to extend.
// ---------------------------------------------------------------------------

/** All flow + config rules, in reporting order. */
export const RULES: readonly Rule[] = [
  headerRequiredFields,
  headerValidKind,
  importsResolve,
  importsNoCycle,
  stepsUniqueIds,
  stepsSupportedDo,
  stepsRequiredFields,
  assertSupportedType,
  assertRequiredFields,
  assertAiJudgeShape,
  assertStepNeedsAssertion,
  templatingUndeclaredInput,
  templatingEnvRefs,
  pathsLockWritable,
  pathsOutWritable,
  stepsNoRawSelector,
  assertCriticalNotAiOnly,
  lockStaleSourceHash,
];

/** Rule ids only — for tooling/tests. */
export const RULE_IDS: readonly string[] = RULES.map((r) => r.id);

// Re-export the heuristic for unit testing.
export { looksLikeRawSelector };
