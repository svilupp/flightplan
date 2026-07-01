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
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeClock } from "../assert/clock.ts";
import {
  MockDriver,
  makeSnapshot,
  makeInteractiveElement,
  makeSuccessBatch,
  makeFailureBatch,
} from "../driver/index.ts";
import type { ConnectConfig } from "../config/index.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import type { ResolvedConfig } from "../config/index.ts";
import { emptyLock, loadLockFile, writeLockFile } from "../lock/index.ts";
import { runFlow } from "./runner.ts";
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
target = "the full name field"
hints = ["Full name"]
intent = "type the name"
value = "\${inputs.name}"

[[steps]]
id = "submit"
do = "click"
target = "the Submit button"
hints = ["Submit"]
intent = "submit the wizard"

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
target = "the apple button"
hints = ["Apple"]

[[steps]]
id = "step_b"
do = "click"
target = "the banana button"
hints = ["Banana"]

[[steps]]
id = "step_c"
do = "click"
target = "the cherry button"
hints = ["Cherry"]
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

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, defaultConfig(), { clock }),
    );

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
target = "the primary action"
intent = "pick the main button"
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
target = "a button that is not present"
hints = ["Nonexistent"]
intent = "click the missing button"
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
target = "the button"
hints = ["Go"]
intent = "click go"
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
target = "the primary button"
hints = ["Primary"]
intent = "click the primary button"
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
    expect(learned.targets[0]?.selector).toBe("role:button:Primary");

    // --- Run 2: identical driver state → the stored signature matches → L0 hit + replay. ---
    const d2 = new MockDriver();
    d2.setSnapshot(primarySnapshot());
    d2.setSignature("http://localhost:3000/drift|stable-hash");
    d2.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));

    const run2 = await runFlow(optsFor(flowPath, outDir, d2, defaultConfig(), { runId: "testrun-0002" }));
    expect(run2.summary.verdict).toBe("passed");
    expect(run2.summary.steps[0]?.tier).toBe("L0"); // resolved by cache replay
    expect(run2.summary.drift_count).toBe(0);
    expect(run2.summary.healed_steps).toEqual([]);

    // The committed lock is byte-stable across the green replay (no churn).
    const after = await loadLockFile(lockPath);
    expect(after).toEqual(learned);
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

    // The lock was rewritten: new winner promoted, old demoted to a candidate.
    const healed = await loadLockFile(lockPath);
    expect(healed.targets[0]?.selector).toBe("role:button:Primary");
    expect(healed.targets[0]?.candidates?.some((c) => c.selector === "role:button:OldPrimary")).toBe(
      true,
    );
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
});
