// Flightplan — runner `[config.auth]` cookie-snapshot restore/save integration tests.
//
// Drives `runFlow` with an injected `MockDriver` to exercise:
//   - `applyAuth` receives `paths.flowDir` = the flow file's directory (+ `paths.cwd`).
//   - a stale saved-auth-state snapshot (`AuthStateUnavailableError`) + `cookie_save = true`
//     is a non-fatal warning and the run proceeds (steps execute).
//   - the same stale snapshot with `cookie_save = false` fails the run (verdict `error`,
//     no steps executed).
//   - `saveAuthState` is called exactly once, with the absolute resolved `cookie_file` path,
//     after a successful run.
//   - `saveAuthState` is NOT called when the run fails/errors.
//   - a `saveAuthState` failure keeps the verdict `passed` with a non-fatal warning.
//   - `saveAuthState` is recorded before the flow's `teardown` hook dispatch.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeClock } from "../assert/clock.ts";
import type { ConnectConfig, ResolvedConfig } from "../config/index.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import { AuthStateUnavailableError } from "../driver/connect-resolution.ts";
import { MockDriver, makeSnapshot } from "../driver/index.ts";
import { runFlow } from "./runner.ts";
import type { RunOptions } from "./types.ts";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fp-runner-auth-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function writeFlow(toml: string): Promise<{ flowPath: string; outDir: string; dir: string }> {
  const dir = await makeTmpDir();
  const flowPath = join(dir, "flow.toml");
  await Bun.write(flowPath, toml);
  return { flowPath, outDir: join(dir, "runs"), dir };
}

function authConfig(
  overrides: Partial<ResolvedConfig["auth"]> = {},
  cookieFile = "cookies.json",
): ResolvedConfig {
  return resolveConfigWithDefaults([{ auth: { cookie_file: cookieFile, ...overrides } }]);
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
    runId: "testrun-auth-0001",
    env: {},
    ...extra,
  };
}

const SIMPLE_FLOW = `
version = 1
kind = "flow"
id = "test.auth"
description = "single-step flow for auth tests"

[inputs]
base_url = "http://localhost:3000"

[[steps]]
id = "open"
do = "goto"
url = "\${inputs.base_url}/home"
`;

const LOGOUT_MODULE = `
version = 1
kind = "flow"
id = "test.auth.logout"
description = "logout teardown module"

[[steps]]
id = "logout"
do = "goto"
url = "http://localhost:3000/logout"
`;

const SIMPLE_FLOW_WITH_TEARDOWN = `
version = 1
kind = "flow"
id = "test.auth.teardown"
description = "single-step flow with teardown for order test"
teardown = "./logout.toml"

[inputs]
base_url = "http://localhost:3000"

[[steps]]
id = "open"
do = "goto"
url = "\${inputs.base_url}/home"
`;

describe("runFlow — [config.auth] cookie snapshot restore", () => {
  test("applyAuth receives paths.flowDir = the flow file's directory", async () => {
    const { flowPath, outDir, dir } = await writeFlow(SIMPLE_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ url: "http://localhost:3000/home" }));

    const result = await runFlow(optsFor(flowPath, outDir, driver, authConfig()));

    expect(result.summary.verdict).toBe("passed");
    const call = driver.callsTo("applyAuth")[0];
    expect(call).toBeDefined();
    const paths = call?.args[2] as { flowDir?: string; cwd?: string } | undefined;
    expect(paths?.flowDir).toBe(dir);
  });

  test("stale saved auth state + cookie_save=true: run proceeds with a warning", async () => {
    const { flowPath, outDir } = await writeFlow(SIMPLE_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ url: "http://localhost:3000/home" }));
    driver.setAuthStateUnavailable(new AuthStateUnavailableError("expired", "/tmp/cookies.json"));

    const warnings: string[] = [];
    const result = await runFlow(
      optsFor(flowPath, outDir, driver, authConfig({ cookie_save: true }), {
        onWarn: (m) => warnings.push(m),
      }),
    );

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["open"]);
    expect(driver.callsTo("goto").length).toBe(1);
    expect(warnings.some((w) => w.includes("expired") && w.includes("cookie_save is on"))).toBe(
      true,
    );
  });

  test("stale saved auth state + cookie_save=false: verdict error, no steps executed", async () => {
    const { flowPath, outDir } = await writeFlow(SIMPLE_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ url: "http://localhost:3000/home" }));
    driver.setAuthStateUnavailable(new AuthStateUnavailableError("expired", "/tmp/cookies.json"));

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, authConfig({ cookie_save: false })),
    );

    expect(result.summary.verdict).toBe("error");
    expect(driver.callsTo("goto").length).toBe(0);
    expect(result.summary.steps.length).toBe(0);
  });

  test("save called once on success with the absolute resolved cookie_file path", async () => {
    const { flowPath, outDir, dir } = await writeFlow(SIMPLE_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ url: "http://localhost:3000/home" }));

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, authConfig({ cookie_save: true })),
    );

    expect(result.summary.verdict).toBe("passed");
    const saveCalls = driver.callsTo("saveAuthState");
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0]?.args[0]).toBe(join(dir, "cookies.json"));
  });

  test("save not called when the run fails", async () => {
    const FAILING_FLOW = `
version = 1
kind = "flow"
id = "test.auth.fail"
description = "flow with a failing assertion"

[inputs]
base_url = "http://localhost:3000"

[[steps]]
id = "open"
do = "goto"
url = "\${inputs.base_url}/home"

[[steps.assert]]
type = "visible"
text = "this text will never be present"
`;
    const { flowPath, outDir } = await writeFlow(FAILING_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ url: "http://localhost:3000/home", text: "" }));

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, authConfig({ cookie_save: true })),
    );

    expect(result.summary.verdict).toBe("failed");
    expect(driver.callsTo("saveAuthState").length).toBe(0);
  });

  test("save not called on an errored run", async () => {
    const { flowPath, outDir } = await writeFlow(SIMPLE_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ url: "http://localhost:3000/home" }));
    // cookie_save=false + a stale snapshot -> the restore error is NOT swallowed, so the run
    // errors out before any step runs (and well before the post-run save gate).
    driver.setAuthStateUnavailable(new AuthStateUnavailableError("not_found", "/tmp/cookies.json"));

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, authConfig({ cookie_save: false })),
    );

    expect(result.summary.verdict).toBe("error");
    expect(driver.callsTo("saveAuthState").length).toBe(0);
  });

  test("save failure keeps verdict passed with a non-fatal warning", async () => {
    const { flowPath, outDir } = await writeFlow(SIMPLE_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ url: "http://localhost:3000/home" }));
    driver.setSaveAuthStateError(new Error("disk full"));

    const warnings: string[] = [];
    const result = await runFlow(
      optsFor(flowPath, outDir, driver, authConfig({ cookie_save: true }), {
        onWarn: (m) => warnings.push(m),
      }),
    );

    expect(result.summary.verdict).toBe("passed");
    expect(
      warnings.some((w) => w.includes("auth state save failed") && w.includes("disk full")),
    ).toBe(true);
  });

  test("saveAuthState is recorded after the last step, before the teardown hook's first dispatch", async () => {
    const dir = await makeTmpDir();
    const flowPath = join(dir, "flow.toml");
    await Bun.write(flowPath, SIMPLE_FLOW_WITH_TEARDOWN);
    await Bun.write(join(dir, "logout.toml"), LOGOUT_MODULE);
    const outDir = join(dir, "runs");
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ url: "http://localhost:3000/home" }));

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, authConfig({ cookie_save: true })),
    );

    expect(result.summary.verdict).toBe("passed");
    const saveCall = driver.callsTo("saveAuthState")[0];
    const gotoCalls = driver.callsTo("goto");
    expect(saveCall).toBeDefined();
    expect(gotoCalls.length).toBe(2); // "open" step + teardown "logout" step
    // saveAuthState's call index must fall strictly between the two gotos (open, then logout).
    expect(saveCall!.index).toBeGreaterThan(gotoCalls[0]!.index);
    expect(saveCall!.index).toBeLessThan(gotoCalls[1]!.index);
  });
});
