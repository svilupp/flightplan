import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFileSystem } from "../adapters/memory.ts";
import { FakeClock } from "../assert/clock.ts";
import { resolveConfigWithDefaults } from "../config/resolve.ts";
import { MockDriver } from "../driver/mock-driver.ts";
import { runFlow } from "./runner.ts";

const header = 'version=1\nkind="flow"\nid="lifecycle"\ndescription="lifecycle"\n';
const failingAssertion =
  '[[steps]]\nid="fail"\ndo="assert"\nassert=[{type="url",url="https://example.test/missing",match="exact",timeout_ms=1}]';
const waitStep = '[[steps]]\nid="wait"\ndo="wait"\nms=0';
const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(main = failingAssertion) {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  const warnings: string[] = [];
  await fs.writeTextFile(
    "/cleanup.toml",
    header + '[[steps]]\nid="cleanup"\ndo="press"\nkey="Escape"\neffect="idempotent"',
  );
  return {
    fs,
    driver,
    warnings,
    opts: {
      flowPath: "/flow.toml",
      flowSource: header + 'teardown="./cleanup.toml"\n' + main,
      fs,
      out: "/runs",
      config: resolveConfigWithDefaults([]),
      driverFactory: () => driver,
      clock: new FakeClock(),
      env: {},
      noLockWrite: true,
      onWarn: (message: string) => warnings.push(message),
    },
  };
}

for (const mode of ["eager", "deferred"] as const) {
  test(`a failed ${mode} run attempts its hook before driver teardown`, async () => {
    const { driver, warnings, opts } = await fixture();
    const result = await runFlow({
      ...opts,
      config: resolveConfigWithDefaults([{ run: { assertions: mode } }]),
    });
    expect(result.summary.verdict).toBe("failed");
    expect(driver.callsTo("press").map((call) => call.args[0])).toEqual(["Escape"]);
    expect(driver.callsTo("teardown")).toHaveLength(1);
    expect(driver.callsTo("press")[0]?.index).toBeLessThan(
      driver.callsTo("teardown")[0]?.index ?? 0,
    );
    expect(warnings).toEqual([]);
  });
}

test("setup failure still runs cleanup without dispatching main steps", async () => {
  const { fs, driver, opts } = await fixture('[[steps]]\nid="main"\ndo="press"\nkey="Enter"');
  await fs.writeTextFile("/setup.toml", header + failingAssertion);
  const result = await runFlow({
    ...opts,
    flowSource: opts.flowSource.replace(
      'teardown="./cleanup.toml"',
      'setup="./setup.toml"\nteardown="./cleanup.toml"',
    ),
  });
  expect(result.summary.verdict).toBe("failed");
  expect(driver.callsTo("press").map((call) => call.args[0])).toEqual(["Escape"]);
  expect(driver.callsTo("teardown")).toHaveLength(1);
});

test("rejected root admission performs physical cleanup without dispatching authored teardown", async () => {
  const { driver, opts } = await fixture(waitStep);
  const result = await runFlow({
    ...opts,
    flowSource: opts.flowSource.replace(
      'teardown="./cleanup.toml"',
      'teardown="./cleanup.toml"\nbefore=[{type="url",url="https://example.test/missing",match="exact",timeout_ms=1}]',
    ),
  });
  expect(result.summary.verdict).toBe("failed");
  expect(result.summary.invocation_status).toBe("not_started");
  expect(driver.callsTo("press")).toHaveLength(0);
  expect(driver.callsTo("teardown")).toHaveLength(1);
});

test("failed connection performs driver cleanup without executing a flow hook", async () => {
  const { driver, opts } = await fixture();
  driver.connect = async () => {
    throw new Error("connection failed");
  };
  const result = await runFlow(opts);
  expect(result.summary.verdict).toBe("error");
  expect(driver.callsTo("press")).toHaveLength(0);
  expect(driver.callsTo("teardown")).toHaveLength(1);
});

test("hook failure is reported without changing the main verdict", async () => {
  const { driver, warnings, opts } = await fixture(waitStep);
  driver.setActionOutcome(false, "press");
  const result = await runFlow(opts);
  expect(result.summary.verdict).toBe("passed");
  expect(warnings.join("\n")).toContain("teardown flow did not complete successfully");
  expect(driver.callsTo("teardown")).toHaveLength(1);
});

test("external cancellation fences hook mutations and cleans the driver once", async () => {
  const { driver, opts } = await fixture(
    '[[steps]]\nid="open"\ndo="goto"\nurl="https://example.test"',
  );
  const controller = new AbortController();
  driver.goto = async () => {
    controller.abort();
  };
  await expect(runFlow({ ...opts, signal: controller.signal })).rejects.toMatchObject({
    code: "RUN_CANCELLED",
    cleanup: "completed",
  });
  expect(driver.callsTo("press")).toHaveLength(0);
  expect(driver.callsTo("teardown")).toHaveLength(1);
});

test("ordinary failure finalizes a started recording before driver teardown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flightplan-lifecycle-"));
  tmpDirs.push(dir);
  const driver = new MockDriver().setVideoPath(join(dir, "video.webm"));
  const result = await runFlow({
    flowPath: join(dir, "flow.toml"),
    flowSource: header + failingAssertion,
    out: join(dir, "runs"),
    config: resolveConfigWithDefaults([{ browser: { record: true } }]),
    driverFactory: () => driver,
    clock: new FakeClock(),
    env: {},
    noLockWrite: true,
  });
  expect(result.summary.verdict).toBe("failed");
  expect(result.summary.video_path).toBe(join(dir, "video.webm"));
  expect(driver.callsTo("startRecording")).toHaveLength(1);
  expect(driver.callsTo("stopRecording")).toHaveLength(1);
  expect(driver.callsTo("stopRecording")[0]?.index).toBeLessThan(
    driver.callsTo("teardown")[0]?.index ?? 0,
  );
});
