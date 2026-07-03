// Flightplan — runner unit tests.
//
// Drive `runFlow` with an INJECTED MockDriver (scripted snapshots/batch results/action outcomes)
// + an injected FakeClock. NO real browser, NO real server, NO real sleeping. These are the
// tests `bun test` must pass in CI-like runs.
//
// Coverage:
//   - happy-path multi-step flow → verdict `passed`, correct run.jsonl event sequence
//   - `--from` resume skips earlier steps
//   - eager-abort vs deferred assertion behaviour
//   - a failing assertion → verdict `failed` + nonzero exit
//   - goto / wait / ai_pick (Phase-4 fail) dispatch
//   - the driver is ALWAYS torn down (even when a step throws)

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeClock } from "../assert/clock.ts";
import type { ConnectConfig, ResolvedConfig } from "../config/index.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import {
  BrowserPilotDriver,
  MockDriver,
  makeFailureBatch,
  makeInteractiveElement,
  makeSnapshot,
  makeSuccessBatch,
} from "../driver/index.ts";
import { emptyLock, loadLockFile, writeLockFile } from "../lock/index.ts";
import {
  DEFAULT_CONNECT_CONFIG,
  defaultDriverFactory,
  resolveConnectConfig,
  runFlow,
} from "./runner.ts";
import type { RunOptions } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fp-runner-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Write a flow .toml into a fresh temp dir; return its absolute path + the out dir. */
async function writeFlow(toml: string): Promise<{ flowPath: string; outDir: string }> {
  const dir = await makeTmpDir();
  const flowPath = join(dir, "flow.toml");
  await Bun.write(flowPath, toml);
  return { flowPath, outDir: join(dir, "runs") };
}

/** Read a JSONL artifact file into an array of parsed events. */
async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A default resolved config (eager, fail_on_assertion=true). */
function defaultConfig(overrides: Partial<ResolvedConfig["run"]> = {}): ResolvedConfig {
  return resolveConfigWithDefaults([{ run: { ...overrides } }]);
}

/** Build RunOptions with a scripted MockDriver + FakeClock. */
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
    runId: "testrun-0001",
    env: {},
    ...extra,
  };
}

// A snapshot whose interactive elements + page text make the wizard-style assertions pass.
function passingSnapshot() {
  return makeSnapshot({
    url: "http://localhost:3000/wizard",
    text: "Full name Welcome, Jane Doe! Plan: pro.",
    interactiveElements: [
      makeInteractiveElement({ ref: "e1", role: "textbox", name: "Full name", value: "Jane Doe" }),
      makeInteractiveElement({ ref: "e2", role: "button", name: "Next" }),
      makeInteractiveElement({ ref: "e3", role: "combobox", name: "Plan", value: "pro" }),
      makeInteractiveElement({ ref: "e4", role: "button", name: "Submit" }),
      makeInteractiveElement({ ref: "e5", role: "generic", name: "Welcome, Jane Doe! Plan: pro." }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("runFlow — happy path", () => {
  const HAPPY_FLOW = `
version = 1
kind = "flow"
id = "test.happy"
description = "happy path multi-step"

[inputs]
base_url = "http://localhost:3000"
name = "Jane Doe"

[[steps]]
id = "open"
do = "goto"
url = "\${inputs.base_url}/wizard"

[[steps.assert]]
type = "visible"
text = "Full name"

[[steps]]
id = "enter_name"
do = "fill"
target = ["text:Full name", "type the name"]
value = "\${inputs.name}"

[[steps]]
id = "submit"
do = "click"
target = ["text:Submit", "submit the wizard"]

[[steps.assert]]
type = "text"
selector = "Welcome"
text = "Welcome, Jane Doe! Plan: pro."
`;

  test("multi-step flow resolves to verdict passed with the right event sequence", async () => {
    const { flowPath, outDir } = await writeFlow(HAPPY_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(passingSnapshot());
    // fill resolves via the "Full name" element; click via "Submit". Both succeed.
    driver.setBatchResult(makeSuccessBatch("role:textbox:Full name", "fill"));
    driver.enqueueBatchResult(makeSuccessBatch("role:textbox:Full name", "fill"));
    driver.enqueueBatchResult(makeSuccessBatch("role:button:Submit", "click"));

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["open", "enter_name", "submit"]);
    expect(result.summary.steps.every((s) => s.ok)).toBe(true);
    expect(result.summary.failed_step).toBeNull();
    expect(result.summary.failed_assertions).toEqual([]);

    // The driver was connected and torn down.
    expect(driver.callsTo("connect").length).toBe(1);
    expect(driver.callsTo("teardown").length).toBe(1);
    // goto was dispatched to the driver.
    expect(driver.callsTo("goto").length).toBe(1);
    expect(driver.callsTo("goto")[0]?.args[0]).toBe("http://localhost:3000/wizard");

    // run.jsonl event sequence.
    const runEvents = await readJsonl(join(result.runDir, "run.jsonl"));
    const types = runEvents.map((e) => e.type);
    expect(types[0]).toBe("run_start");
    expect(types[types.length - 1]).toBe("run_end");
    // 3 step_start + 3 step_end.
    expect(types.filter((t) => t === "step_start").length).toBe(3);
    expect(types.filter((t) => t === "step_end").length).toBe(3);
    // 2 assertion_result events (open: visible, submit: text).
    expect(types.filter((t) => t === "assertion_result").length).toBe(2);
    const runEnd = runEvents[runEvents.length - 1];
    expect(runEnd?.verdict).toBe("passed");

    // trace.jsonl: ladder steps (fill+click) emitted browser_action + resolution_attempt.
    const traceEvents = await readJsonl(join(result.runDir, "trace.jsonl"));
    const actions = traceEvents.filter((e) => e.type === "browser_action");
    expect(actions.length).toBe(2); // fill + click
    const attempts = traceEvents.filter((e) => e.type === "resolution_attempt");
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    // L0 (miss) → L1 (resolved) tiers only — no escalation past L1.
    const tiers = new Set(attempts.map((a) => a.tier));
    expect(tiers.has("L1")).toBe(true);
    for (const a of attempts) expect(["L0", "L1"]).toContain(a.tier as string);

    // summary.json written and matches the in-memory summary.
    const summaryOnDisk = JSON.parse(await readFile(join(result.runDir, "summary.json"), "utf8"));
    expect(summaryOnDisk.verdict).toBe("passed");
    expect(summaryOnDisk.run_id).toBe("testrun-0001");
  });
});

// ---------------------------------------------------------------------------
// --from resume
// ---------------------------------------------------------------------------

describe("runFlow — --from resume", () => {
  const FLOW = `
version = 1
kind = "flow"
id = "test.resume"
description = "resume"

[[steps]]
id = "step_a"
do = "click"
target = ["text:Apple", "the apple button"]

[[steps]]
id = "step_b"
do = "click"
target = ["text:Banana", "the banana button"]

[[steps]]
id = "step_c"
do = "click"
target = ["text:Cherry", "the cherry button"]
`;

  test("--from skips earlier steps and runs only from the named step", async () => {
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "button", name: "Apple" }),
          makeInteractiveElement({ ref: "e2", role: "button", name: "Banana" }),
          makeInteractiveElement({ ref: "e3", role: "button", name: "Cherry" }),
        ],
      }),
    );
    driver.setBatchResult(makeSuccessBatch("role:button:Cherry", "click"));

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, defaultConfig(), { fromStep: "step_b" }),
    );

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["step_b", "step_c"]);
    expect(driver.callsTo("teardown").length).toBe(1);
  });

  test("--from with an unknown step id fails the run with a clear error", async () => {
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(
      makeSnapshot({
        interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Apple" })],
      }),
    );
    driver.setBatchResult(makeSuccessBatch("role:button:Apple", "click"));

    await expect(
      runFlow(optsFor(flowPath, outDir, driver, defaultConfig(), { fromStep: "nope" })),
    ).rejects.toThrow(/--from: no step with id "nope"/);
  });
});

// ---------------------------------------------------------------------------
// --to (inclusive stop) + combined --from/--to slices
// ---------------------------------------------------------------------------

describe("runFlow — --to stop", () => {
  const FLOW = `
version = 1
kind = "flow"
id = "test.stop"
description = "stop"

[[steps]]
id = "step_a"
do = "click"
target = ["text:Apple", "the apple button"]

[[steps]]
id = "step_b"
do = "click"
target = ["text:Banana", "the banana button"]

[[steps]]
id = "step_c"
do = "click"
target = ["text:Cherry", "the cherry button"]
`;

  function driverWithAllThree(): MockDriver {
    const driver = new MockDriver();
    driver.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "button", name: "Apple" }),
          makeInteractiveElement({ ref: "e2", role: "button", name: "Banana" }),
          makeInteractiveElement({ ref: "e3", role: "button", name: "Cherry" }),
        ],
      }),
    );
    driver.setBatchResult(makeSuccessBatch("role:button:Apple", "click"));
    return driver;
  }

  test("--to runs through the named step INCLUSIVE, then stops", async () => {
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = driverWithAllThree();

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, defaultConfig(), { toStep: "step_b" }),
    );

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["step_a", "step_b"]);
    expect(driver.callsTo("teardown").length).toBe(1);
  });

  test("--from + --to together run just the slice (both inclusive)", async () => {
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = driverWithAllThree();

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, defaultConfig(), {
        fromStep: "step_b",
        toStep: "step_b",
      }),
    );

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["step_b"]);
  });

  test("--to with an unknown step id fails the run with a clear error", async () => {
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = driverWithAllThree();

    await expect(
      runFlow(optsFor(flowPath, outDir, driver, defaultConfig(), { toStep: "nope" })),
    ).rejects.toThrow(/--to: no step with id "nope"/);
  });

  test("--from after --to (inverted range) fails with a clear error", async () => {
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = driverWithAllThree();

    await expect(
      runFlow(
        optsFor(flowPath, outDir, driver, defaultConfig(), {
          fromStep: "step_c",
          toStep: "step_a",
        }),
      ),
    ).rejects.toThrow(/comes after/);
  });
});

// ---------------------------------------------------------------------------
// Failing assertion → failed + nonzero exit
// ---------------------------------------------------------------------------

describe("runFlow — failing assertion", () => {
  const FLOW = `
version = 1
kind = "flow"
id = "test.assertfail"
description = "assertion fail"

[run]
assert_timeout_ms = 10

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/wizard"

[[steps.assert]]
type = "text"
text = "this text is never on the page"
`;

  test("a failing assertion → verdict failed + exit code 1", async () => {
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ text: "totally different content" }));

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.summary.failed_assertions.length).toBe(1);
    expect(result.summary.failed_assertions[0]?.step).toBe("open");
    expect(result.summary.failed_step).toBe("open");
    expect(driver.callsTo("teardown").length).toBe(1);
  });

  test("fail_on_assertion=false keeps the verdict passed but still reports the failure", async () => {
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ text: "totally different content" }));
    const config = defaultConfig({ fail_on_assertion: false, assert_timeout_ms: 10 });

    const result = await runFlow(optsFor(flowPath, outDir, driver, config));

    expect(result.summary.verdict).toBe("passed");
    expect(result.exitCode).toBe(0);
    // The failure is still reported (non-fatal warning).
    expect(result.summary.failed_assertions.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Eager vs deferred
// ---------------------------------------------------------------------------

describe("runFlow — eager vs deferred", () => {
  const FLOW = `
version = 1
kind = "flow"
id = "test.eager"
description = "eager/deferred"

[run]
assert_timeout_ms = 10

[[steps]]
id = "step_one"
do = "goto"
url = "http://localhost:3000/a"

[[steps.assert]]
type = "text"
text = "never present"

[[steps]]
id = "step_two"
do = "goto"
url = "http://localhost:3000/b"

[[steps.assert]]
type = "text"
text = "also never present"
`;

  test("eager aborts at the first failing step (step_two never runs)", async () => {
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ text: "nothing matches" }));
    const config = defaultConfig({ assertions: "eager", assert_timeout_ms: 10 });

    const result = await runFlow(optsFor(flowPath, outDir, driver, config));

    expect(result.summary.verdict).toBe("failed");
    // Only step_one executed (eager abort).
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["step_one"]);
    expect(result.summary.failed_assertions.length).toBe(1);
  });

  test("deferred runs all steps and collects every failure", async () => {
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ text: "nothing matches" }));
    const config = defaultConfig({ assertions: "deferred", assert_timeout_ms: 10 });

    const result = await runFlow(optsFor(flowPath, outDir, driver, config));

    expect(result.summary.verdict).toBe("failed");
    // Both steps executed (deferred collects).
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["step_one", "step_two"]);
    expect(result.summary.failed_assertions.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// goto / wait / ai_pick dispatch
// ---------------------------------------------------------------------------

describe("runFlow — step dispatch", () => {
  test("wait uses the injected clock (no real sleep) and goto navigates", async () => {
    const FLOW = `
version = 1
kind = "flow"
id = "test.waitgoto"
description = "wait + goto"

[[steps]]
id = "nav"
do = "goto"
url = "http://localhost:3000/async"

[[steps]]
id = "pause"
do = "wait"
ms = 900
`;
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot());
    const clock = new FakeClock();

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig(), { clock }));

    expect(result.summary.verdict).toBe("passed");
    expect(driver.callsTo("goto")[0]?.args[0]).toBe("http://localhost:3000/async");
    // The wait advanced the fake clock by at least 900ms (no real sleep happened).
    expect(clock.now()).toBeGreaterThanOrEqual(900);
  });

  test("ai_pick without an AI runtime degrades to the ladder and fails when L1 can't resolve", async () => {
    // ai_pick is now a ladder verb (Phase 4). With no AI runtime wired and nothing the
    // deterministic ladder can resolve, it escalates past L1 with no AI hook and the step fails —
    // it does NOT crash the run, and there is no Phase-4 stub anymore.
    const FLOW = `
version = 1
kind = "flow"
id = "test.aipick"
description = "ai_pick"

[[steps]]
id = "pick"
do = "ai_pick"
target = ["the primary action", "pick the main button"]
`;
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot());

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("failed");
    expect(result.exitCode).toBe(1);
    const pickStep = result.summary.steps.find((s) => s.stepId === "pick");
    expect(pickStep?.ok).toBe(false);
    expect(pickStep?.error).not.toContain("Phase 4");
    // The run still completed cleanly (teardown ran, summary written).
    expect(driver.callsTo("teardown").length).toBe(1);
  });

  test("a ladder step that cannot resolve fails the step (escalate, no AI hook)", async () => {
    const FLOW = `
version = 1
kind = "flow"
id = "test.escalate"
description = "L1 escalate"

[[steps]]
id = "click_missing"
do = "click"
target = ["Nonexistent", "click the missing button"]
`;
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    // No interactive elements + a failing batch → L1 cannot resolve, escalates.
    driver.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    driver.setBatchResult(makeFailureBatch("missing", { action: "click" }));

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("failed");
    expect(result.summary.steps[0]?.ok).toBe(false);
    expect(driver.callsTo("teardown").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Frame switching (switch_frame / switch_to_main)
// ---------------------------------------------------------------------------

describe("runFlow — frame switching", () => {
  // A flow that ENTERS an iframe, clicks a target that lives ONLY inside that frame (its hint is
  // scripted as iframe-bound, so L1's iframe guard WOULD hard-fail it on the top document), then
  // returns to main and clicks a top-document target.
  const FRAME_FLOW = `
version = 1
kind = "flow"
id = "test.frame"
description = "enter an iframe, act inside it, then return to main"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/contexts"

[[steps]]
id = "enter"
do = "switch_frame"
target = ["[data-testid='context-frame']", "the embedded iframe"]

[[steps]]
id = "in_frame_click"
do = "click"
target = ["[data-testid='iframe-btn']", "confirm inside the frame"]

[[steps]]
id = "leave"
do = "switch_to_main"

[[steps]]
id = "main_click"
do = "click"
target = ["[data-testid='main-btn']", "confirm on the top document"]
`;

  test("switch_frame enters the frame (guard relaxed), switch_to_main returns to main", async () => {
    const { flowPath, outDir } = await writeFlow(FRAME_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    // The iframe-btn hint resolves ONLY inside the frame; without switching, L1's guard hard-fails.
    driver.setSelectorFrame("[data-testid='iframe-btn']", "iframe");
    // In-frame click, then the top-document click, each succeed once switched appropriately.
    driver.enqueueBatchResult(makeSuccessBatch("[data-testid='iframe-btn']", "click"));
    driver.enqueueBatchResult(makeSuccessBatch("[data-testid='main-btn']", "click"));

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps.map((s) => s.stepId)).toEqual([
      "open",
      "enter",
      "in_frame_click",
      "leave",
      "main_click",
    ]);
    expect(result.summary.steps.every((s) => s.ok)).toBe(true);

    // switch_frame delegated to the driver with the RESOLVED iframe selector (NL entry dropped).
    expect(driver.callsTo("switchToFrame")).toHaveLength(1);
    expect(driver.callsTo("switchToFrame")[0]?.args[0]).toEqual(["[data-testid='context-frame']"]);
    // switch_to_main delegated to the driver.
    expect(driver.callsTo("switchToMain")).toHaveLength(1);
    // Order: entered the frame BEFORE the in-frame click, left it BEFORE the main click.
    const methods = driver.calls.map((c) => c.method);
    expect(methods.indexOf("switchToFrame")).toBeLessThan(methods.indexOf("switchToMain"));

    // The in-frame click resolved+acted (proves the guard was relaxed while switched into the frame).
    const inFrame = result.summary.steps.find((s) => s.stepId === "in_frame_click");
    expect(inFrame?.ok).toBe(true);
    expect(inFrame?.tier).toBe("L1");
  });

  test("without switch_frame the same in-frame-only target hard-fails at L1 (guard intact)", async () => {
    // Same click, but NO switch_frame precedes it → currentFrame() stays null → the guard fires.
    const FLOW = `
version = 1
kind = "flow"
id = "test.noframe"
description = "in-frame target without entering the frame"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/contexts"

[[steps]]
id = "in_frame_click"
do = "click"
target = ["[data-testid='iframe-btn']", "confirm inside the frame"]
`;
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    driver.setSelectorFrame("[data-testid='iframe-btn']", "iframe");

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("failed");
    const step = result.summary.steps.find((s) => s.stepId === "in_frame_click");
    expect(step?.ok).toBe(false);
    expect(step?.error ?? "").toContain("only inside an iframe");
    // The guard never entered a frame and never acted.
    expect(driver.callsTo("switchToFrame")).toHaveLength(0);
  });

  test("a goto after switch_frame resets the driver's frame context to main", async () => {
    // enter a frame, then navigate: browser-pilot + the driver reset frame state on navigation, so
    // the post-goto click resolves on the top document (its iframe-only guard would fire otherwise).
    const FLOW = `
version = 1
kind = "flow"
id = "test.frameresetgoto"
description = "goto resets the frame context"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/contexts"

[[steps]]
id = "enter"
do = "switch_frame"
target = ["[data-testid='context-frame']", "the embedded iframe"]

[[steps]]
id = "renav"
do = "goto"
url = "http://localhost:3000/other"

[[steps]]
id = "main_click"
do = "click"
target = ["[data-testid='main-btn']", "confirm on the top document"]
`;
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    driver.enqueueBatchResult(makeSuccessBatch("[data-testid='main-btn']", "click"));

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("passed");
    // After the second goto the driver is back on the top document (frame context reset).
    expect(driver.currentFrame()).toBeNull();
    expect(result.summary.steps.find((s) => s.stepId === "main_click")?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// on_fail control flow (goto / self-retry / max re-entry bound)
// ---------------------------------------------------------------------------

describe("runFlow — on_fail jumps", () => {
  // A snapshot whose page text flips to "ready" once the driver has performed ≥ `readyAfter`
  // actions of `verb` (fill/click). Actions run through batch(), so we count them in onBatch.
  function recoveringDriver(verb: "fill" | "click", readyAfter: number): MockDriver {
    const driver = new MockDriver();
    let actions = 0;
    driver.onSnapshot(() =>
      makeSnapshot({
        // NOTE: the failing text must NOT contain the asserted substring ("READY") — the `text`
        // assertion is a substring match.
        text: actions >= readyAfter ? "the form is READY to submit" : "still waiting",
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "textbox", name: "Email" }),
          makeInteractiveElement({ ref: "e2", role: "button", name: "Submit" }),
        ],
      }),
    );
    driver.onBatch((steps) => {
      const s = steps[0]!;
      const sel = Array.isArray(s.selector) ? s.selector[0] : s.selector;
      if (s.action === verb) actions += 1;
      return makeSuccessBatch(
        typeof sel === "string" && sel.includes("Email")
          ? "role:textbox:Email"
          : "role:button:Submit",
        s.action,
      );
    });
    return driver;
  }

  test("on_fail = { goto = self } retries a step whose after-assertion fails then RECOVERS → passed", async () => {
    // The click succeeds, but its after-assertion (`text = "ready"`) fails on the first attempt.
    // on_fail jumps back to the SAME step; on the 2nd attempt the page text has flipped to
    // "ready" (the 2nd click action), so the assertion passes and the run recovers.
    const FLOW = `
version = 1
kind = "flow"
id = "test.retry"
description = "self-retry recovery"

[run]
assert_timeout_ms = 10

[[steps]]
id = "flaky_click"
do = "click"
target = ["text:Submit", "the submit button"]
on_fail = { goto = "self", max = 2 }
  [[steps.assert]]
  type = "text"
  text = "READY"
`;
    const { flowPath, outDir } = await writeFlow(FLOW);
    // Page becomes "ready" after the 2nd click action (i.e. on the self-retry).
    const driver = recoveringDriver("click", 2);

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, defaultConfig({ assert_timeout_ms: 10 })),
    );

    expect(result.summary.verdict).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.summary.failed_step).toBeNull();
    // The recovered attempt's failing assertion is discarded (not reported).
    expect(result.summary.failed_assertions).toEqual([]);
    // The step was entered twice (fail, then success): two step rows for the same id.
    const rows = result.summary.steps.filter((s) => s.stepId === "flaky_click");
    expect(rows.length).toBe(2);
    expect(rows[0]?.ok).toBe(false);
    expect(rows[1]?.ok).toBe(true);
  });

  test("on_fail = { goto } jumps BACK to a recovery step then flows forward → verdict passed", async () => {
    // Mirrors the saas-onboarding recovery: `submit`'s after-assertion fails, on_fail jumps back to
    // the earlier `fix` step (a re-fill), which then flows forward through `submit` again (now
    // passing, because the 2nd fill flips the page to "ready") to `done`.
    const FLOW = `
version = 1
kind = "flow"
id = "test.recover"
description = "recovery jump"

[run]
assert_timeout_ms = 10

[[steps]]
id = "fix"
do = "fill"
target = ["text:Email", "the email field"]
value = "x@y.com"

[[steps]]
id = "submit"
do = "click"
target = ["text:Submit", "the submit button"]
on_fail = { goto = "fix", max = 1 }
  [[steps.assert]]
  type = "text"
  text = "READY"

[[steps]]
id = "done"
do = "wait"
ms = 1
`;
    const { flowPath, outDir } = await writeFlow(FLOW);
    // Page becomes "ready" after the 2nd fill action (i.e. after the recovery re-fill).
    const driver = recoveringDriver("fill", 2);

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, defaultConfig({ assert_timeout_ms: 10 })),
    );

    expect(result.summary.verdict).toBe("passed");
    // Execution order: fix → submit(fail) → fix → submit(ok) → done.
    expect(result.summary.steps.map((s) => s.stepId)).toEqual([
      "fix",
      "submit",
      "fix",
      "submit",
      "done",
    ]);
    expect(result.summary.steps.map((s) => s.ok)).toEqual([true, false, true, true, true]);
  });

  test("infinite-loop prevention: a step that ALWAYS fails stops after max re-entries and fails the run", async () => {
    const FLOW = `
version = 1
kind = "flow"
id = "test.loopbound"
description = "self-retry never recovers"

[run]
max_steps = 100

[[steps]]
id = "never"
do = "click"
target = ["Nope", "a button that never resolves"]
on_fail = { goto = "self", max = 3 }
`;
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    driver.setBatchResult(makeFailureBatch("missing", { action: "click" }));

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    // 1 initial attempt + 3 re-entries = 4 attempts, then it fails the run (does NOT spin forever).
    expect(result.summary.verdict).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.summary.failed_step).toBe("never");
    const attempts = result.summary.steps.filter((s) => s.stepId === "never");
    expect(attempts.length).toBe(4);
    expect(attempts.every((s) => !s.ok)).toBe(true);
    // The run FAILED (verdict failed, not inconclusive) — the on_fail re-entry bound stopped the
    // loop before the max_steps=100 backstop was ever reached.
  });

  test("max_steps is the global backstop even for a runaway on_fail loop", async () => {
    const FLOW = `
version = 1
kind = "flow"
id = "test.backstop"
description = "max_steps caps a huge on_fail.max"

[run]
max_steps = 3

[[steps]]
id = "never"
do = "click"
target = ["Nope", "a button that never resolves"]
on_fail = { goto = "self", max = 1000 }
`;
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    driver.setBatchResult(makeFailureBatch("missing", { action: "click" }));

    // The runner reads the budget from the resolved config (not the flow's [run] block), so set
    // max_steps=3 there. It trips first (verdict inconclusive), bounding the runaway retry loop.
    const result = await runFlow(
      optsFor(flowPath, outDir, driver, defaultConfig({ max_steps: 3 })),
    );

    expect(result.summary.verdict).toBe("inconclusive");
    expect(result.summary.steps.filter((s) => s.stepId === "never").length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Driver always torn down (even on throw)
// ---------------------------------------------------------------------------

describe("runFlow — teardown guarantee", () => {
  const FLOW = `
version = 1
kind = "flow"
id = "test.throw"
description = "driver throws mid-step"

[[steps]]
id = "boom"
do = "click"
target = ["Go", "click go"]
`;

  test("the driver is torn down even when a step throws", async () => {
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    // Make the ladder's snapshot() throw to simulate a mid-step driver failure.
    driver.onSnapshot(() => {
      throw new Error("simulated driver explosion");
    });

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    // A thrown step is an infra error → verdict error, exit 2.
    expect(result.summary.verdict).toBe("error");
    expect(result.exitCode).toBe(2);
    // Teardown STILL ran (the finally block).
    expect(driver.callsTo("teardown").length).toBe(1);
  });

  test("the driver is torn down even when connect() throws", async () => {
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    const originalConnect = driver.connect.bind(driver);
    driver.connect = async (cfg) => {
      await originalConnect(cfg);
      throw new Error("connect failed");
    };

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("error");
    expect(result.exitCode).toBe(2);
    expect(driver.callsTo("teardown").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lock manager (Phase 3): L0 hit/replay, signature-drift heal, write policy
// ---------------------------------------------------------------------------

describe("runFlow — lock manager (P3)", () => {
  // A single-click flow used for the heal/policy scenarios.
  const CLICK_FLOW = `
version = 1
kind = "flow"
id = "test.lock"
description = "lock manager"

[[steps]]
id = "act"
do = "click"
target = ["text:Primary", "click the primary button"]
`;

  /** The sidecar lock path the runner derives for a flow (mirrors defaultLockPath). */
  function lockPathFor(flowPath: string): string {
    return flowPath.replace(/\.toml$/i, ".lock.toml");
  }

  /** A snapshot whose single interactive button matches the flow's "Primary" target. */
  function primarySnapshot() {
    return makeSnapshot({
      url: "http://localhost:3000/drift",
      accessibilityTree: [{ role: "main", ref: "n1", children: [{ role: "button", ref: "n2" }] }],
      interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Primary" })],
    });
  }

  test("first run learns + persists a recipe; second run replays at L0 (no rewrite)", async () => {
    const { flowPath, outDir } = await writeFlow(CLICK_FLOW);
    const lockPath = lockPathFor(flowPath);

    // --- Run 1: no lock exists → L1 first-learn → recipe persisted. ---
    const d1 = new MockDriver();
    d1.setSnapshot(primarySnapshot());
    d1.setSignature("http://localhost:3000/drift|stable-hash");
    d1.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));

    const run1 = await runFlow(optsFor(flowPath, outDir, d1, defaultConfig()));
    expect(run1.summary.verdict).toBe("passed");
    expect(run1.summary.steps[0]?.tier).toBe("L1");
    expect(run1.summary.drift_count).toBe(0);

    const learned = await loadLockFile(lockPath);
    expect(learned.targets[0]?.step).toBe("act");
    expect(learned.targets[0]?.strategies?.[0]?.selector).toBe("role:button:Primary");

    // --- Run 2: identical driver state → the stored signature matches → L0 hit + replay. ---
    const d2 = new MockDriver();
    d2.setSnapshot(primarySnapshot());
    d2.setSignature("http://localhost:3000/drift|stable-hash");
    d2.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));

    const run2 = await runFlow(
      optsFor(flowPath, outDir, d2, defaultConfig(), { runId: "testrun-0002" }),
    );
    expect(run2.summary.verdict).toBe("passed");
    expect(run2.summary.steps[0]?.tier).toBe("L0"); // resolved by cache replay
    expect(run2.summary.drift_count).toBe(0);
    expect(run2.summary.healed_steps).toEqual([]);

    // The winning recipe is STABLE across the green L0 replay (no drift/heal). The v2 portfolio
    // records the extra green on its track record (greens 1 → 2), so the winner selector is
    // unchanged while its `greens` accumulates — a self-ordering playbook, not a frozen cache.
    const after = await loadLockFile(lockPath);
    expect(after.targets[0]?.strategies?.[0]?.selector).toBe("role:button:Primary");
    expect(after.targets[0]?.strategies?.[0]?.greens).toBe(
      (learned.targets[0]?.strategies?.[0]?.greens ?? 0) + 1,
    );
  });

  /** Pre-write a lock whose recipe drifts (stale selector) and whose signature won't match. */
  async function writeStaleLock(lockPath: string): Promise<void> {
    const lock = emptyLock("test.lock", "sha256:x", "lock manager");
    lock.targets.push({
      step: "act",
      target: "the primary button",
      // url_glob matches the run's page so L0 reaches the signature gate…
      match: { url_glob: "http://localhost:3000/*", sig: "text:STALE|aaa;struct:/x|bbb" },
      // …but the stored selector has drifted from what L1 now resolves.
      selector: "role:button:OldPrimary",
      strategy: "role_name",
      green_runs: 5,
    });
    await writeLockFile(lockPath, lock);
  }

  /** Driver that misses L0 on signature (stale) then resolves a DIFFERENT selector at L1. */
  function healingDriver(): MockDriver {
    const d = new MockDriver();
    d.setSnapshot(primarySnapshot());
    d.setSignature("http://localhost:3000/drift|fresh-hash");
    d.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));
    return d;
  }

  test("signature mismatch → L0 miss → L1 re-resolve + heal (auto): drift_count, healed flag, lock updated", async () => {
    const { flowPath, outDir } = await writeFlow(CLICK_FLOW);
    const lockPath = lockPathFor(flowPath);
    await writeStaleLock(lockPath);

    const result = await runFlow(optsFor(flowPath, outDir, healingDriver(), defaultConfig()));

    expect(result.summary.verdict).toBe("passed"); // a heal does not fail the default run
    expect(result.summary.steps[0]?.tier).toBe("L1"); // re-resolved at L1
    expect(result.summary.steps[0]?.healed).toBe(true);
    expect(result.summary.healed_steps).toEqual(["act"]);
    expect(result.summary.drift_count).toBe(1);

    // step_end event carries healed=true.
    const runEvents = await readJsonl(join(result.runDir, "run.jsonl"));
    const stepEnd = runEvents.find((e) => e.type === "step_end" && e.stepId === "act");
    expect(stepEnd?.healed).toBe(true);
    const runEnd = runEvents.find((e) => e.type === "run_end") as Record<string, any>;
    expect(runEnd?.totals?.drift_count).toBe(1);

    // The lock was rewritten: new winner promoted to the top of the portfolio, old one demoted.
    const healed = await loadLockFile(lockPath);
    expect(healed.targets[0]?.strategies?.[0]?.selector).toBe("role:button:Primary");
    expect(
      healed.targets[0]?.strategies?.some((s) => s.selector === "role:button:OldPrimary"),
    ).toBe(true);
  });

  test("--frozen: drift is reported AND fails the run, but the lock is NOT persisted", async () => {
    const { flowPath, outDir } = await writeFlow(CLICK_FLOW);
    const lockPath = lockPathFor(flowPath);
    await writeStaleLock(lockPath);
    const before = await loadLockFile(lockPath);

    const result = await runFlow(
      optsFor(flowPath, outDir, healingDriver(), defaultConfig(), { frozen: true }),
    );

    expect(result.summary.verdict).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.summary.drift_count).toBe(1);
    expect(result.summary.healed_steps).toEqual(["act"]);
    expect(result.summary.failed_step).toBe("act");

    // The committed lock is unchanged (frozen never writes).
    const after = await loadLockFile(lockPath);
    expect(after).toEqual(before);
  });

  test("--no-lock-write: drift is reported, run NOT failed, lock NOT persisted", async () => {
    const { flowPath, outDir } = await writeFlow(CLICK_FLOW);
    const lockPath = lockPathFor(flowPath);
    await writeStaleLock(lockPath);
    const before = await loadLockFile(lockPath);

    const result = await runFlow(
      optsFor(flowPath, outDir, healingDriver(), defaultConfig(), { noLockWrite: true }),
    );

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.drift_count).toBe(1);
    expect(result.summary.healed_steps).toEqual(["act"]);

    const after = await loadLockFile(lockPath);
    expect(after).toEqual(before);
  });

  /**
   * A lock whose stored `sig` is STALE but whose `selector` STILL uniquely resolves the target on
   * the current page (`role:button:Primary` is in `primarySnapshot()`). Layer 3 revalidation should
   * rescue this as an L0 hit — even under --frozen, where the lock cannot be re-healed.
   */
  async function writeStaleSigValidSelectorLock(lockPath: string): Promise<void> {
    const lock = emptyLock("test.lock", "sha256:x", "lock manager");
    lock.targets.push({
      step: "act",
      target: "the primary button",
      match: { url_glob: "http://localhost:3000/*", sig: "text:STALE|aaa;struct:/stale|bbb" },
      selector: "role:button:Primary", // still resolves uniquely on the current page
      strategy: "role_name",
      green_runs: 5,
    });
    await writeLockFile(lockPath, lock);
  }

  test("--frozen + stale sig but selector still resolves → L0 revalidated HIT (no drift, no fail)", async () => {
    const { flowPath, outDir } = await writeFlow(CLICK_FLOW);
    const lockPath = lockPathFor(flowPath);
    await writeStaleSigValidSelectorLock(lockPath);
    const before = await loadLockFile(lockPath);

    // Fresh page whose signature will NOT match the stored stale sig, but the button is present.
    const d = new MockDriver();
    d.setSnapshot(primarySnapshot());
    d.setStructureSignature("/drift|fresh-struct");
    d.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));

    const result = await runFlow(optsFor(flowPath, outDir, d, defaultConfig(), { frozen: true }));

    // Resolved at L0 via Layer 3 revalidation — NOT a drift, NOT a failure, no AI escalation.
    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps[0]?.tier).toBe("L0");
    expect(result.summary.drift_count).toBe(0);
    expect(result.summary.healed_steps).toEqual([]);

    // Frozen never writes: the committed lock (incl. its stale sig) is unchanged.
    const after = await loadLockFile(lockPath);
    expect(after).toEqual(before);
  });

  test("--frozen: a multi-strategy portfolio resolves via agreement but writes NO track records", async () => {
    const { flowPath, outDir } = await writeFlow(CLICK_FLOW);
    const lockPath = lockPathFor(flowPath);
    // A v2 portfolio with two strategies for the same button; the sig is stale (forces the race).
    const lock = emptyLock("test.lock", "sha256:x", "");
    lock.targets.push({
      step: "act",
      target: "the primary button",
      match: { url_glob: "http://localhost:3000/*", sig: "text:STALE|a;struct:/x|b" },
      strategies: [
        {
          kind: "role_name",
          selector: "role:button:Primary",
          greens: 2,
          last_ok: "1970-01-01T00:00:00.000Z",
        },
        {
          kind: "testid",
          selector: "[data-testid='primary']",
          greens: 1,
          last_ok: "1970-01-01T00:00:00.000Z",
        },
      ],
    });
    await writeLockFile(lockPath, lock);
    const before = await loadLockFile(lockPath, undefined, () => 0);

    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        url: "http://localhost:3000/drift",
        accessibilityTree: [{ role: "main", ref: "n1", children: [{ role: "button", ref: "n2" }] }],
        interactiveElements: [
          makeInteractiveElement({
            ref: "e1",
            role: "button",
            name: "Primary",
            attributes: { "data-testid": "primary" },
          }),
        ],
      }),
    );
    d.setStructureSignature("/drift|fresh-struct");
    d.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));

    const result = await runFlow(optsFor(flowPath, outDir, d, defaultConfig(), { frozen: true }));

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps[0]?.tier).toBe("L0"); // resolved by the portfolio race
    expect(result.summary.drift_count).toBe(0);

    // READ-ONLY: greens are NOT bumped, last_ok is NOT refreshed — the committed lock is untouched.
    const after = await loadLockFile(lockPath, undefined, () => 0);
    expect(after).toEqual(before);
  });

  test("auto + stale sig but selector resolves → L0 revalidated HIT refreshes the stored sig (no drift)", async () => {
    const { flowPath, outDir } = await writeFlow(CLICK_FLOW);
    const lockPath = lockPathFor(flowPath);
    await writeStaleSigValidSelectorLock(lockPath);
    const before = await loadLockFile(lockPath);

    const d = new MockDriver();
    d.setSnapshot(primarySnapshot());
    d.setStructureSignature("/drift|fresh-struct");
    d.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));

    const result = await runFlow(optsFor(flowPath, outDir, d, defaultConfig()));

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps[0]?.tier).toBe("L0");
    expect(result.summary.drift_count).toBe(0); // a sig refresh is NOT a drift
    expect(result.summary.healed_steps).toEqual([]);

    // The lock's winning recipe is unchanged, but its stale signature was refreshed to the fresh one.
    const after = await loadLockFile(lockPath);
    expect(after.targets[0]?.strategies?.[0]?.selector).toBe("role:button:Primary");
    expect(after.targets[0]?.match.sig).not.toBe(before.targets[0]?.match.sig);
    expect(after.targets[0]?.match.sig).not.toContain("STALE");
  });

  test("--frozen + malformed committed lock → verdict `error` (exit 2), NOT a silent pass (B4)", async () => {
    const { flowPath, outDir } = await writeFlow(CLICK_FLOW);
    const lockPath = lockPathFor(flowPath);
    // A corrupt committed lock. Under --frozen the lock is authoritative, so this must fail fast
    // rather than silently downgrading to empty and re-resolving fresh (a masked drift_count=0 pass).
    await Bun.write(lockPath, "this = = not valid toml");

    const result = await runFlow(
      optsFor(flowPath, outDir, healingDriver(), defaultConfig(), { frozen: true }),
    );

    expect(result.summary.verdict).toBe("error");
    expect(result.exitCode).toBe(2);

    // run_end carries the error detail; no steps ran (fail-fast).
    const runEvents = await readJsonl(join(result.runDir, "run.jsonl"));
    const runEnd = runEvents.find((e) => e.type === "run_end") as Record<string, any>;
    expect(String(runEnd?.error ?? "")).toContain("malformed lock");
    expect(result.summary.steps).toHaveLength(0);

    // Sanity: the SAME malformed lock under auto mode does NOT error (auto-heal downgrade preserved).
    const auto = await runFlow(
      optsFor(flowPath, outDir, healingDriver(), defaultConfig(), { runId: "testrun-0002" }),
    );
    expect(auto.summary.verdict).toBe("passed");
  });
});

// ---------------------------------------------------------------------------
// `run` composition — the runner executes the load-time-flattened step list
// (PLAN_v002 §3): namespaced ids in the summary, `with` overrides applied, and
// `--from` resuming at a namespaced child step id.
// ---------------------------------------------------------------------------

describe("runFlow — composed flows (`run` steps)", () => {
  const CHILD = `
version = 1
kind = "flow"
id = "lib.visit"
description = "child module"

[inputs]
path = "default"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/\${inputs.path}"

[[steps]]
id = "settle"
do = "wait"
ms = 1
`;

  const PARENT = `
version = 1
kind = "flow"
id = "test.composed"
description = "parent running an imported flow twice"
imports = "./child.toml"

steps = [
  { id = "first",  do = "run", flow = "lib.visit", with = { path = "alpha" } },
  { id = "second", do = "run", flow = "./child.toml", with = { path = "beta" } },
]
`;

  async function writeComposed(): Promise<{ flowPath: string; outDir: string }> {
    const dir = await makeTmpDir();
    await Bun.write(join(dir, "child.toml"), CHILD);
    const flowPath = join(dir, "parent.toml");
    await Bun.write(flowPath, PARENT);
    return { flowPath, outDir: join(dir, "runs") };
  }

  test("executes namespaced child steps with `with`-overridden inputs", async () => {
    const { flowPath, outDir } = await writeComposed();
    const driver = new MockDriver();
    driver.setSnapshot(passingSnapshot());

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps.map((s) => s.stepId)).toEqual([
      "first:open",
      "first:settle",
      "second:open",
      "second:settle",
    ]);
    // Each call site's `with` override reached the child's goto URL.
    const gotos = driver.callsTo("goto").map((c) => c.args[0]);
    expect(gotos).toEqual(["http://localhost:3000/alpha", "http://localhost:3000/beta"]);
  });

  test("--from resumes at a namespaced child step id", async () => {
    const { flowPath, outDir } = await writeComposed();
    const driver = new MockDriver();
    driver.setSnapshot(passingSnapshot());

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, defaultConfig(), { fromStep: "second:open" }),
    );

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["second:open", "second:settle"]);
    expect(driver.callsTo("goto").map((c) => c.args[0])).toEqual(["http://localhost:3000/beta"]);
  });

  test("--to stops at a namespaced child step id (inclusive)", async () => {
    const { flowPath, outDir } = await writeComposed();
    const driver = new MockDriver();
    driver.setSnapshot(passingSnapshot());

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, defaultConfig(), { toStep: "first:settle" }),
    );

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["first:open", "first:settle"]);
    expect(driver.callsTo("goto").map((c) => c.args[0])).toEqual(["http://localhost:3000/alpha"]);
  });
});

// ---------------------------------------------------------------------------
// Connect-config resolution — the default (no [connect] block) attaches to a
// general CDP endpoint at localhost:9222; an explicit config wins wholesale.
// ---------------------------------------------------------------------------

describe("resolveConnectConfig", () => {
  test("defaults to attach at localhost:9222 when the config sets no connect", () => {
    const resolved = resolveConnectConfig(defaultConfig());
    expect(resolved).toEqual({ mode: "attach", browserURL: "localhost:9222" });
    expect(resolved).toBe(DEFAULT_CONNECT_CONFIG);
  });

  test("an explicit connect config overrides the default", () => {
    const connect: ConnectConfig = { mode: "launch", headless: true };
    const config = resolveConfigWithDefaults([{ connect }]);
    expect(resolveConnectConfig(config)).toEqual(connect);
  });
});

// ---------------------------------------------------------------------------
// Lock crediting is GATED on the full step outcome (measured admin-crud regression)
// ---------------------------------------------------------------------------
// A resolution must be credited to the lock portfolio (first-learn / green promotion / heal)
// only when the step PASSES end-to-end (action ok AND assertions ok) — never on bare action
// success. Before the fix a WRONG-but-clickable selector earned a green and climbed the per-step
// portfolio even when the step's after-assertion failed, so the next warm run replayed the wrong
// pick (admin-crud: a promoted `bulk-delete` selector deleted the row instead of ticking a
// checkbox). Steps with NO assertions still credit on action success (unchanged).
describe("runFlow — lock crediting gated on assertion outcome", () => {
  /** A click guarded by a whole-page `text` after-assertion; the snapshot text drives pass/fail. */
  const GUARDED_CLICK = `
version = 1
kind = "flow"
id = "test.gatecredit"
description = "gate lock crediting on assertion pass"

[run]
assert_timeout_ms = 10

[[steps]]
id = "act"
do = "click"
target = ["text:Primary", "click the primary button"]

[[steps.assert]]
type = "text"
text = "SAVED-OK"
`;

  /** The sidecar lock path the runner derives for a flow (mirrors defaultLockPath). */
  function gateLockPath(flowPath: string): string {
    return flowPath.replace(/\.toml$/i, ".lock.toml");
  }

  /** A snapshot with the clickable "Primary" button; `pageText` drives the after-assertion. */
  function gateSnapshot(pageText: string) {
    return makeSnapshot({
      url: "http://localhost:3000/crud",
      accessibilityTree: [{ role: "main", ref: "n1", children: [{ role: "button", ref: "n2" }] }],
      interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Primary" })],
      text: pageText,
    });
  }

  test("action succeeds but the after-assertion FAILS → resolution is NOT credited (no first-learn write)", async () => {
    const { flowPath, outDir } = await writeFlow(GUARDED_CLICK);
    const lockPath = gateLockPath(flowPath);

    const driver = new MockDriver();
    // The click RESOLVES + ACTS at L1 (success), but the page text lacks "SAVED-OK", so the
    // after-assertion fails and the step fails end-to-end.
    driver.setSnapshot(gateSnapshot("nothing useful here"));
    driver.setSignature("http://localhost:3000/crud|hash");
    driver.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    // The run failed on the assertion, but the ACTION itself succeeded (resolved at L1).
    expect(result.summary.verdict).toBe("failed");
    expect(result.summary.failed_step).toBe("act");
    expect(result.summary.steps[0]?.tier).toBe("L1");
    expect(result.summary.steps[0]?.ok).toBe(false);
    expect(result.summary.drift_count).toBe(0);
    expect(result.summary.healed_steps).toEqual([]);

    // The wrong-but-clickable selector was NOT credited: no lock was written (first-learn suppressed).
    expect(await Bun.file(lockPath).exists()).toBe(false);
  });

  test("action AND after-assertion pass → resolution IS credited (first-learn persisted)", async () => {
    const { flowPath, outDir } = await writeFlow(GUARDED_CLICK);
    const lockPath = gateLockPath(flowPath);

    const driver = new MockDriver();
    // Same action, but now the page text satisfies the after-assertion → the step passes end-to-end.
    driver.setSnapshot(gateSnapshot("result: SAVED-OK"));
    driver.setSignature("http://localhost:3000/crud|hash");
    driver.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps[0]?.tier).toBe("L1");

    // The passing step credited its resolution: the recipe was learned + persisted.
    expect(await Bun.file(lockPath).exists()).toBe(true);
    const learned = await loadLockFile(lockPath);
    expect(learned.targets[0]?.step).toBe("act");
    expect(learned.targets[0]?.strategies?.[0]?.selector).toBe("role:button:Primary");
  });

  test("warm L0 replay whose after-assertion FAILS does NOT promote the portfolio (greens frozen, lock byte-stable)", async () => {
    const { flowPath, outDir } = await writeFlow(GUARDED_CLICK);
    const lockPath = gateLockPath(flowPath);

    // --- Run 1: passes end-to-end → first-learn (greens recorded). ---
    const d1 = new MockDriver();
    d1.setSnapshot(gateSnapshot("result: SAVED-OK"));
    d1.setSignature("http://localhost:3000/crud|hash");
    d1.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));
    const run1 = await runFlow(optsFor(flowPath, outDir, d1, defaultConfig()));
    expect(run1.summary.verdict).toBe("passed");

    const afterLearn = await loadLockFile(lockPath);
    const greensAfterLearn = afterLearn.targets[0]?.strategies?.[0]?.greens ?? 0;

    // --- Run 2: identical signature → L0 warm replay, but the after-assertion now FAILS. ---
    // A GREEN L0 replay would normally tick the portfolio track record (greens++) and rewrite the
    // lock. Because this step fails end-to-end, the resolution must NOT be credited — no promotion,
    // and the committed lock stays byte-identical. This is the admin-crud regression in miniature.
    const d2 = new MockDriver();
    d2.setSnapshot(gateSnapshot("ERROR: not saved"));
    d2.setSignature("http://localhost:3000/crud|hash");
    d2.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));
    const run2 = await runFlow(
      optsFor(flowPath, outDir, d2, defaultConfig(), { runId: "testrun-0002" }),
    );

    expect(run2.summary.verdict).toBe("failed");
    expect(run2.summary.steps[0]?.tier).toBe("L0"); // it WAS a warm replay…
    expect(run2.summary.steps[0]?.ok).toBe(false); // …that failed on the assertion.

    const afterFail = await loadLockFile(lockPath);
    // Greens did NOT advance and the committed lock is byte-identical (no promotion on a failed run).
    expect(afterFail.targets[0]?.strategies?.[0]?.greens).toBe(greensAfterLearn);
    expect(afterFail).toEqual(afterLearn);
  });
});

// ---------------------------------------------------------------------------
// [timeouts] → driver factory threading (integration gap)
// ---------------------------------------------------------------------------

describe("defaultDriverFactory — [timeouts] threading", () => {
  test("default path (no timeouts arg) keeps the driver's built-in ceilings", () => {
    // Backward-compat: constructing without timeouts must still work and fall back to the driver's
    // own DEFAULT_ACTION_TIMEOUT_MS (5000) / DEFAULT_NAV_TIMEOUT_MS (2000).
    const driver = defaultDriverFactory(DEFAULT_CONNECT_CONFIG);
    expect(driver).toBeInstanceOf(BrowserPilotDriver);
    const bp = driver as BrowserPilotDriver;
    expect(bp.actionTimeoutMs).toBe(5000);
    expect(bp.navTimeoutMs).toBe(2000);
  });

  test("honors an author's [timeouts] override — action_ms / nav_ms reach the driver", () => {
    // The runner threads config.timeouts into the default factory; those resolved ceilings must
    // land on the constructed BrowserPilotDriver instead of its built-in fallbacks.
    const driver = defaultDriverFactory(DEFAULT_CONNECT_CONFIG, { action_ms: 1234, nav_ms: 777 });
    const bp = driver as BrowserPilotDriver;
    expect(bp.actionTimeoutMs).toBe(1234);
    expect(bp.navTimeoutMs).toBe(777);
  });

  test("default path (no [resolve]) surfaces NO extra selector attributes", () => {
    // Backward-compat: absent `[resolve] attributes` must leave the driver's attribute set empty
    // (identical to before the knob existed), whether or not timeouts are passed.
    expect(
      (defaultDriverFactory(DEFAULT_CONNECT_CONFIG) as BrowserPilotDriver).resolveAttributes,
    ).toEqual([]);
    const withTimeouts = defaultDriverFactory(DEFAULT_CONNECT_CONFIG, {
      action_ms: 1234,
      nav_ms: 777,
    }) as BrowserPilotDriver;
    expect(withTimeouts.resolveAttributes).toEqual([]);
  });

  test("threads [resolve] attributes through to the driver alongside [timeouts]", () => {
    // The runner threads config.resolve?.attributes into the default factory; those author-declared
    // extra selector-hook attribute names (e.g. data-cmd) must reach the constructed driver so its
    // snapshot/resolveAll surface + rank them.
    const driver = defaultDriverFactory(DEFAULT_CONNECT_CONFIG, { action_ms: 1234, nav_ms: 777 }, [
      "data-cmd",
      "data-widget",
    ]);
    const bp = driver as BrowserPilotDriver;
    expect(bp.resolveAttributes).toEqual(["data-cmd", "data-widget"]);
    // and the timeouts wiring is unaffected by the added arg
    expect(bp.actionTimeoutMs).toBe(1234);
    expect(bp.navTimeoutMs).toBe(777);
  });
});
