// Flightplan — `eval` step runner tests (MockDriver only, no Chrome/network).
//
// Coverage:
//   - happy path: eval dispatches with the templated `args`, `expect = "truthy"` passes on a
//     truthy result, a trace `browser_action` event is emitted, and an after-assertion runs
//     normally.
//   - a literal `expect` string is compared against `JSON.stringify(result)`.
//   - `frame` unresolvable (evalInFrame returns `ok:false`) → normal step failure.
//   - a rejected `evalInFrame` propagates as a normal step failure, not an infra error.
//   - `secret = true` on an eval step redacts the templated `args` in trace.jsonl.
//   - eval never escalates past L0 / never writes to the lock (no `resolveStep`/lock hook call).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeClock } from "../assert/clock.ts";
import type { ConnectConfig, ResolvedConfig } from "../config/index.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import { MockDriver } from "../driver/index.ts";
import { runFlow } from "./runner.ts";
import type { RunOptions } from "./types.ts";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fp-runner-eval-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function writeFlow(toml: string): Promise<{ flowPath: string; outDir: string }> {
  const dir = await makeTmpDir();
  const flowPath = join(dir, "flow.toml");
  await Bun.write(flowPath, toml);
  return { flowPath, outDir: join(dir, "runs") };
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function defaultConfig(overrides: Partial<ResolvedConfig["run"]> = {}): ResolvedConfig {
  return resolveConfigWithDefaults([{ run: { ...overrides } }]);
}

function optsFor(
  flowPath: string,
  outDir: string,
  driver: MockDriver,
  config: ResolvedConfig,
  extra: Partial<RunOptions> = {},
): RunOptions {
  const clock = new FakeClock();
  return {
    flowPath,
    config,
    out: outDir,
    driverFactory: (_cfg: ConnectConfig) => driver,
    clock,
    runId: "testrun-eval-0001",
    env: {},
    ...extra,
  };
}

const EVAL_FLOW = `
version = 1
kind = "flow"
id = "test.eval"
description = "run a script inside a cross-origin frame"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/checkout"

[[steps]]
id = "fill_card_number"
do = "eval"
frame = "iframe[title*='card number']"
script = "document.querySelector('input').value = args.value; return true;"

[steps.args]
value = "5555444433331111"

[[steps.assert]]
type = "text"
text = "filled"
`;

describe("runFlow — eval step (happy path)", () => {
  test("eval enters the frame, evaluates with templated args, expect:truthy passes, and traces browser_action", async () => {
    const { flowPath, outDir } = await writeFlow(EVAL_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot({
      url: "http://localhost:3000/checkout",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "filled",
    });
    driver.setEvalResult({ ok: true, value: true });

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["open", "fill_card_number"]);
    expect(result.summary.steps.find((s) => s.stepId === "fill_card_number")?.ok).toBe(true);

    // evalInFrame received the resolved frame selector, script, and TEMPLATED args.
    const calls = driver.callsTo("evalInFrame");
    expect(calls).toHaveLength(1);
    const opts = calls[0]?.args[0] as { frame?: string; script: string; args?: unknown };
    expect(opts.frame).toBe("iframe[title*='card number']");
    expect(opts.script).toContain("args.value");
    expect(opts.args).toEqual({ value: "5555444433331111" });

    // trace.jsonl carries a browser_action for the eval with action "eval".
    const trace = await readJsonl(join(result.runDir, "trace.jsonl"));
    const ba = trace.find((e) => e.type === "browser_action" && e.action === "eval");
    expect(ba).toBeDefined();
    expect(ba?.ok).toBe(true);
  });

  test("eval is never resolved through the ladder (no resolveAll/snapshot-driven resolution call)", async () => {
    const { flowPath, outDir } = await writeFlow(EVAL_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot({
      url: "http://localhost:3000/checkout",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "filled",
    });
    driver.setEvalResult({ ok: true, value: true });

    await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    // L1 resolution ranks candidates via resolveAll; eval must never touch it — it is a direct
    // driver call exempt from the healing ladder (L0 only, never escalates, never learned).
    expect(driver.callsTo("resolveAll")).toHaveLength(0);
  });
});

describe("runFlow — eval step (expect literal)", () => {
  const LITERAL_EXPECT_FLOW = `
version = 1
kind = "flow"
id = "test.eval.expect"
description = "eval with a literal expect"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/checkout"

[[steps]]
id = "read_value"
do = "eval"
script = "return document.querySelector('input').value;"
expect = '"5555444433331111"'
`;

  test("a literal expect string is compared to JSON.stringify(result) — a string result needs quotes in expect", async () => {
    const { flowPath, outDir } = await writeFlow(LITERAL_EXPECT_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot({
      url: "http://localhost:3000/checkout",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "",
    });
    driver.setEvalResult({ ok: true, value: "5555444433331111" });

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps.find((s) => s.stepId === "read_value")?.ok).toBe(true);
  });

  test("a mismatched literal expect fails the step", async () => {
    const { flowPath, outDir } = await writeFlow(LITERAL_EXPECT_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot({
      url: "http://localhost:3000/checkout",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "",
    });
    driver.setEvalResult({ ok: true, value: "wrong-value" });

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("failed");
    const step = result.summary.steps.find((s) => s.stepId === "read_value");
    expect(step?.ok).toBe(false);
    expect(String(step?.error ?? "")).toContain("did not satisfy expect");
  });
});

describe("runFlow — eval step (frame / evaluation failures)", () => {
  test("an unresolvable frame (evalInFrame returns ok:false) fails the step, not an infra error", async () => {
    const { flowPath, outDir } = await writeFlow(EVAL_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot({
      url: "http://localhost:3000/checkout",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "waiting",
    });
    driver.setEvalResult({
      ok: false,
      error: "evalInFrame: could not enter frame",
      phase: "frame",
    });

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("failed");
    expect(result.exitCode).toBe(1);
    const step = result.summary.steps.find((s) => s.stepId === "fill_card_number");
    expect(step?.ok).toBe(false);
    expect(String(step?.error ?? "")).toContain("could not enter frame");
    // Frame never entered — nothing ran — so the step is cleanly not_dispatched.
    expect(step?.dispatchState).toBe("not_dispatched");
  });

  test("a thrown script exception (frame entered, script failed) maps to dispatchState: uncertain", async () => {
    const { flowPath, outDir } = await writeFlow(EVAL_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot({
      url: "http://localhost:3000/checkout",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "waiting",
    });
    driver.setEvalResult({
      ok: false,
      error: "ReferenceError: args is not defined",
      phase: "script",
    });

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("failed");
    const step = result.summary.steps.find((s) => s.stepId === "fill_card_number");
    expect(step?.ok).toBe(false);
    expect(String(step?.error ?? "")).toContain("args is not defined");
    // The frame WAS entered and the script started running before throwing — its side effects (if
    // any) are unknown, so this is `uncertain`, not the cleaner `not_dispatched`.
    expect(step?.dispatchState).toBe("uncertain");
  });

  test("a rejected evalInFrame (thrown evaluation exception) is a normal step failure", async () => {
    const { flowPath, outDir } = await writeFlow(EVAL_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot({
      url: "http://localhost:3000/checkout",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "waiting",
    });
    driver.enqueueEvalError(new Error("ReferenceError: args is not defined"));

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("failed");
    const step = result.summary.steps.find((s) => s.stepId === "fill_card_number");
    expect(step?.ok).toBe(false);
    expect(String(step?.error ?? "")).toContain("args is not defined");
  });
});

describe("runFlow — eval step (redaction)", () => {
  const SECRET_EVAL_FLOW = `
version = 1
kind = "flow"
id = "test.eval.secret"
description = "eval a secret card number into a frame"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/checkout"

[[steps]]
id = "fill_card_number"
do = "eval"
frame = "iframe[title*='card number']"
script = "document.querySelector('input').value = args.value; return true;"
secret = true

[steps.args]
value = "5555444433331111"
`;

  test("secret = true redacts the templated args in trace.jsonl's browser_action event", async () => {
    const { flowPath, outDir } = await writeFlow(SECRET_EVAL_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot({
      url: "http://localhost:3000/checkout",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "",
    });
    driver.setEvalResult({ ok: true, value: true });

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("passed");
    const trace = await readJsonl(join(result.runDir, "trace.jsonl"));
    const ba = trace.find((e) => e.type === "browser_action" && e.action === "eval");
    expect(ba).toBeDefined();
    const selectorOrIntent = typeof ba?.selectorOrIntent === "string" ? ba.selectorOrIntent : "";
    expect(selectorOrIntent).not.toContain("5555444433331111");

    // The evalInFrame call itself legitimately carries the real args (the driver needs them to
    // fill the frame) — only the ARTIFACT must be redacted, asserted above.
    const calls = driver.callsTo("evalInFrame");
    const callOpts = calls[0]?.args[0] as { args?: unknown } | undefined;
    expect(callOpts?.args).toEqual({ value: "5555444433331111" });
  });
});

describe("runFlow — evaluate step (redaction)", () => {
  // Mirrors the eval secret-redaction test above: `evaluate` has no `args` wrapper, so the
  // templated `expression` string itself carries the secret and must be gathered into the global
  // secret set (redaction/index.ts's `gatherSecretValues`) — not just manually redacted at the
  // single `selectorOrIntent` call site — so it never survives ANYWHERE in trace.jsonl.
  const SECRET_EVALUATE_FLOW = `
version = 1
kind = "flow"
id = "test.evaluate.secret"
description = "evaluate a secret card number"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/checkout"

[[steps]]
id = "fill_card_number"
do = "evaluate"
expression = "document.querySelector('input').value = '5555444433331111'"
secret = true
effect = "observe"
`;

  test("secret = true redacts the templated expression in trace.jsonl's browser_action event", async () => {
    const { flowPath, outDir } = await writeFlow(SECRET_EVALUATE_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot({
      url: "http://localhost:3000/checkout",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "",
    });
    driver.setEvaluateResult(true);

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("passed");
    const traceRaw = await readFile(join(result.runDir, "trace.jsonl"), "utf8");
    expect(traceRaw).not.toContain("5555444433331111");

    const trace = await readJsonl(join(result.runDir, "trace.jsonl"));
    const ba = trace.find((e) => e.type === "browser_action" && e.action === "evaluate");
    expect(ba).toBeDefined();
    const selectorOrIntent = typeof ba?.selectorOrIntent === "string" ? ba.selectorOrIntent : "";
    expect(selectorOrIntent).not.toContain("5555444433331111");

    // The evaluateExpression call itself legitimately carries the real expression — only the
    // ARTIFACT must be redacted, asserted above.
    const calls = driver.callsTo("evaluateExpression");
    expect(calls[0]?.args[0]).toContain("5555444433331111");
  });
});
