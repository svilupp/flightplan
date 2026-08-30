import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../assert/clock.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import type { ConnectConfig } from "../config/types.ts";
import { MockDriver } from "../driver/index.ts";
import { runFlow } from "./runner.ts";
import type { RunOptions } from "./types.ts";

const tmpDirs: string[] = [];

async function fixture(toml: string): Promise<{ flowPath: string; outDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fp-webmcp-"));
  tmpDirs.push(dir);
  const flowPath = join(dir, "flow.toml");
  await Bun.write(flowPath, toml);
  return { flowPath, outDir: join(dir, "runs") };
}

function options(
  flowPath: string,
  outDir: string,
  driver: MockDriver,
  config = resolveConfigWithDefaults([{ run: { assertions: "eager" } }]),
): RunOptions {
  return {
    flowPath,
    out: outDir,
    config,
    driverFactory: (_config: ConnectConfig) => driver,
    clock: new FakeClock(),
    runId: "webmcp-test",
    env: {},
  };
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runFlow — webmcp_call", () => {
  test("passes typed result assertions, captures values, and persists only safe evidence", async () => {
    const { flowPath, outDir } = await fixture(`
version = 1
kind = "flow"
id = "webmcp.success"
description = "webmcp success"

[[steps]]
id = "lookup"
do = "webmcp_call"
tool = "orders.lookup"
input = { order_id = "42" }
origin = "https://shop.example"
effect = "observe"

[[steps.assert]]
type = "result"
path = "order.status"
equals = "ready"

[[steps.capture]]
name = "order_token"
type = "result"
path = "order.token"
secret = true
`);
    const driver = new MockDriver().setWebmcpResult({
      ok: true,
      phase: "invoke",
      dispatchState: "dispatched",
      retrySafe: false,
      tool: {
        name: "orders.lookup",
        origin: "https://shop.example",
        annotations: { readOnlyHint: true, untrustedContentHint: true },
      },
      result: { order: { status: "ready", token: "raw-secret-result" } },
    });
    const result = await runFlow(options(flowPath, outDir, driver));
    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.captures?.order_token).toBe("«redacted»");
    expect(JSON.stringify(result.summary)).not.toContain("raw-secret-result");
    const events = (await readFile(join(result.runDir, "run.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const end = events.find((event) => event.type === "step_end");
    expect(end?.webmcp).toEqual({
      tool: "orders.lookup",
      origin: "https://shop.example",
      phase: "invoke",
      dispatchState: "dispatched",
      retrySafe: false,
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    const call = driver.callsTo("webmcpCall")[0];
    expect(call?.args[0]).toMatchObject({
      tool: "orders.lookup",
      origin: "https://shop.example",
      allowMutation: false,
    });
  });

  test("classifies an at-most-once post-dispatch error as inconclusive", async () => {
    const { flowPath, outDir } = await fixture(`
version = 1
kind = "flow"
id = "webmcp.uncertain"
description = "webmcp uncertain"
[[steps]]
id = "create"
do = "webmcp_call"
tool = "orders.create"
effect = "at_most_once"
`);
    const driver = new MockDriver().enqueueWebmcpError(new Error("transport timeout"));
    const result = await runFlow(options(flowPath, outDir, driver));
    expect(result.summary.verdict).toBe("inconclusive");
    expect(result.summary.steps[0]?.dispatchState).toBe("uncertain");
    expect(result.summary.steps[0]?.retrySafe).toBe(false);
  });

  test("keeps result captures raw for templating while redacting persisted copies", async () => {
    const { flowPath, outDir } = await fixture(`
version = 1
kind = "flow"
id = "webmcp.capture"
description = "webmcp capture"
[[steps]]
id = "first"
do = "webmcp_call"
tool = "orders.lookup"

[[steps.capture]]
name = "secret_id"
type = "result"
path = "id"
secret = true

[[steps]]
id = "second"
do = "webmcp_call"
tool = "orders.lookup"
input = { order_id = "\${capture.secret_id}" }
`);
    const driver = new MockDriver()
      .enqueueWebmcpResult({
        ok: true,
        phase: "invoke",
        dispatchState: "dispatched",
        retrySafe: false,
        tool: { name: "orders.lookup", annotations: { readOnlyHint: true } },
        result: { id: "private-order-id" },
      })
      .enqueueWebmcpResult({
        ok: true,
        phase: "invoke",
        dispatchState: "dispatched",
        retrySafe: false,
        tool: { name: "orders.lookup", annotations: { readOnlyHint: true } },
        result: { ok: true },
      });
    const result = await runFlow(options(flowPath, outDir, driver));
    expect(result.summary.verdict).toBe("passed");
    expect(driver.callsTo("webmcpCall")[1]?.args[0]).toMatchObject({
      input: { order_id: "private-order-id" },
    });
    expect(JSON.stringify(result.summary)).not.toContain("private-order-id");
  });

  test("fails cleanly when the connected driver lacks WebMCP", async () => {
    const { flowPath, outDir } = await fixture(`
version = 1
kind = "flow"
id = "webmcp.missing"
description = "webmcp missing"
[[steps]]
id = "lookup"
do = "webmcp_call"
tool = "orders.lookup"
`);
    const result = await runFlow(options(flowPath, outDir, new MockDriver()));
    expect(result.summary.verdict).toBe("failed");
    expect(result.summary.steps[0]?.dispatchState).toBe("not_dispatched");
  });

  test("redacts secret input values echoed by a tool failure", async () => {
    const { flowPath, outDir } = await fixture(`
version = 1
kind = "flow"
id = "webmcp.secret-error"
description = "webmcp secret error"
[[steps]]
id = "call"
do = "webmcp_call"
tool = "orders.lookup"
input = { token = "raw-webmcp-secret" }
secret = true
`);
    const driver = new MockDriver().enqueueWebmcpError(
      new Error("tool rejected raw-webmcp-secret"),
    );
    const result = await runFlow(options(flowPath, outDir, driver));
    expect(result.summary.verdict).toBe("failed");
    expect(result.summary.steps[0]?.error).not.toContain("raw-webmcp-secret");
    expect(JSON.stringify(result.summary)).not.toContain("raw-webmcp-secret");
  });
});
