// Flightplan — `eval` step schema + lint tests.
//
// Coverage:
//   - schema accepts script-only, frame + args, secret, and an explicit `expect` literal.
//   - schema defaults `expect` to "truthy" when omitted.
//   - schema rejects a missing `script` and an unknown field (strict object).
//   - lint: steps/required-fields (missing script), steps/eval-escape-hatch (warns on both eval
//     and evaluate), steps/eval-string-interpolation (warns on `${` in script/expression).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintFile } from "../lint/index.ts";
import { FlowValidationError, parseFlowFile } from "./load.ts";

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fp-eval-"));
  tmpDirs.push(dir);
  return dir;
}

const HEADER = `
version = 1
kind = "flow"
id = "test.eval.schema"
description = "eval step schema tests"
`;

describe("EvalStepSchema — accepts", () => {
  test('a script-only step defaults expect to "truthy"', () => {
    const toml = `${HEADER}
[[steps]]
id = "run_script"
do = "eval"
script = "return true;"
`;
    const loaded = parseFlowFile(toml, "flow.toml");
    const step = loaded.flow.steps[0]!;
    expect(step.do).toBe("eval");
    if (step.do !== "eval") throw new Error("unreachable");
    expect(step.script).toBe("return true;");
    expect(step.frame).toBeUndefined();
    expect(step.args).toBeUndefined();
    expect(step.expect).toBe("truthy");
  });

  test("frame + structured args + secret + an explicit expect literal", () => {
    const toml = `${HEADER}
[[steps]]
id = "fill_card_number"
do = "eval"
frame = "iframe[title*='card number']"
script = "document.querySelector('input').value = args.value; return document.querySelector('input').value;"
secret = true
expect = "5555444433331111"

[steps.args]
value = "5555444433331111"
`;
    const loaded = parseFlowFile(toml, "flow.toml");
    const step = loaded.flow.steps[0]!;
    if (step.do !== "eval") throw new Error("unreachable");
    expect(step.frame).toBe("iframe[title*='card number']");
    expect(step.args).toEqual({ value: "5555444433331111" });
    expect(step.secret).toBe(true);
    expect(step.expect).toBe("5555444433331111");
  });
});

describe("EvalStepSchema — rejects", () => {
  test("a missing script", () => {
    const toml = `${HEADER}
[[steps]]
id = "run_script"
do = "eval"
`;
    expect(() => parseFlowFile(toml, "flow.toml")).toThrow(FlowValidationError);
  });

  test("an unknown field (strict object)", () => {
    const toml = `${HEADER}
[[steps]]
id = "run_script"
do = "eval"
script = "return true;"
bogus_field = "x"
`;
    expect(() => parseFlowFile(toml, "flow.toml")).toThrow(FlowValidationError);
  });
});

describe("lint — eval step rules", () => {
  test("steps/required-fields fires for a missing script", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "flow.toml");
    await Bun.write(
      path,
      `${HEADER}
[[steps]]
id = "run_script"
do = "eval"
`,
    );
    const result = await lintFile(path);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.ruleId)).toContain("steps/required-fields");
  });

  test("steps/eval-escape-hatch always warns on an eval step", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "flow.toml");
    await Bun.write(
      path,
      `${HEADER}
[[steps]]
id = "run_script"
do = "eval"
script = "return true;"
`,
    );
    const result = await lintFile(path);
    const evalWarning = result.diagnostics.find((d) => d.ruleId === "steps/eval-escape-hatch");
    expect(evalWarning).toBeDefined();
    expect(evalWarning?.severity).toBe("warning");
    // A warning-only diagnostic does not fail lint on its own.
    expect(result.ok).toBe(true);
  });

  test("steps/eval-escape-hatch also warns on a bare evaluate step", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "flow.toml");
    await Bun.write(
      path,
      `${HEADER}
[[steps]]
id = "run_expr"
do = "evaluate"
expression = "document.title"
effect = "observe"
`,
    );
    const result = await lintFile(path);
    const evaluateWarning = result.diagnostics.find((d) => d.ruleId === "steps/eval-escape-hatch");
    expect(evaluateWarning).toBeDefined();
    expect(evaluateWarning?.severity).toBe("warning");
    expect(result.ok).toBe(true);
  });

  test("steps/eval-string-interpolation warns on `${` in eval.script", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "flow.toml");
    await Bun.write(
      path,
      `${HEADER}
[[steps]]
id = "run_script"
do = "eval"
script = "return document.querySelector('#\${step_id}').value;"
`,
    );
    const result = await lintFile(path);
    const warning = result.diagnostics.find((d) => d.ruleId === "steps/eval-string-interpolation");
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe("warning");
    expect(result.ok).toBe(true);
  });

  test("steps/eval-string-interpolation warns on `${` in evaluate.expression", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "flow.toml");
    await Bun.write(
      path,
      `${HEADER}
[[steps]]
id = "run_expr"
do = "evaluate"
expression = "document.querySelector('#\${step_id}')"
effect = "observe"
`,
    );
    const result = await lintFile(path);
    const warning = result.diagnostics.find((d) => d.ruleId === "steps/eval-string-interpolation");
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe("warning");
    expect(result.ok).toBe(true);
  });

  test("steps/eval-string-interpolation does not fire without `${`", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "flow.toml");
    await Bun.write(
      path,
      `${HEADER}
[[steps]]
id = "run_script"
do = "eval"
script = "return true;"
`,
    );
    const result = await lintFile(path);
    const warning = result.diagnostics.find((d) => d.ruleId === "steps/eval-string-interpolation");
    expect(warning).toBeUndefined();
  });
});
