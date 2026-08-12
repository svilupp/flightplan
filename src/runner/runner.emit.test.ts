// Flightplan — `emit` step runner tests (MockDriver only, no Chrome/network).
//
// Coverage:
//   - happy path: emit dispatches, delivers, a trace `browser_action` event is emitted, and an
//     after-assertion runs normally.
//   - delivered:false (or an unconfirmed dispatch) → step failure, normal verdict machinery.
//   - a rejected `emitCommand` (simulating `EmitTargetError` / an `awaitReply` timeout)
//     propagates as a normal step failure, NOT an infra `error` verdict.
//   - a driver without `emitCommand` (older browser-pilot) fails the step with a clear message.
//   - `secret = true` on an emit step redacts the payload in trace.jsonl.

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
  const dir = await mkdtemp(join(tmpdir(), "fp-runner-emit-"));
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
    runId: "testrun-emit-0001",
    env: {},
    ...extra,
  };
}

const EMIT_FLOW = `
version = 1
kind = "flow"
id = "test.emit"
description = "emit a WebSocket command"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/chat"

[[steps]]
id = "send"
do = "emit"
channel = "ws"
payload = { type = "client.response.text", content = "say hi" }

[steps.await_reply]
where = { type = "response.end" }
timeout_ms = 5000

[[steps.assert]]
type = "text"
text = "sent"
`;

describe("runFlow — emit step (happy path)", () => {
  test("emit dispatches, delivers, awaits the reply, traces browser_action, and passes the after-assertion", async () => {
    const { flowPath, outDir } = await writeFlow(EMIT_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot({
      url: "http://localhost:3000/chat",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "sent",
    });
    driver.setEmitResult({
      delivered: true,
      socketUrl: "wss://localhost/session/abc",
      realm: "main",
      candidates: [{ url: "wss://localhost/session/abc", readyState: 1, realm: "main" }],
      reply: { payload: '{"type":"response.end"}', latencyMs: 42 },
    });

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["open", "send"]);
    expect(result.summary.steps.find((s) => s.stepId === "send")?.ok).toBe(true);

    // emitCommand received the JSON-serialized table payload + the mapped awaitReply.
    const calls = driver.callsTo("emitCommand");
    expect(calls).toHaveLength(1);
    const opts = calls[0]?.args[0] as {
      channel: string;
      payload: string;
      awaitReply?: { where?: Record<string, unknown>; timeout?: number };
    };
    expect(opts.channel).toBe("ws");
    expect(JSON.parse(opts.payload)).toEqual({ type: "client.response.text", content: "say hi" });
    expect(opts.awaitReply?.where).toEqual({ type: "response.end" });
    expect(opts.awaitReply?.timeout).toBe(5000);

    // trace.jsonl carries a browser_action for the emit with action "emit".
    const trace = await readJsonl(join(result.runDir, "trace.jsonl"));
    const ba = trace.find((e) => e.type === "browser_action" && e.action === "emit");
    expect(ba).toBeDefined();
    expect(ba?.ok).toBe(true);
  });
});

describe("runFlow — emit step (delivery failure)", () => {
  test("delivered:false fails the step through normal on_fail/verdict machinery (not an infra error)", async () => {
    const { flowPath, outDir } = await writeFlow(EMIT_FLOW);
    const driver = new MockDriver();
    // NOTE: text is deliberately NOT "sent" — EMIT_FLOW's after-assertion (`text: "sent"`) would
    // otherwise deterministically rescue an uncertain/dispatched at-most-once failure (the same
    // rescue mechanism click/fill use), masking the inconclusive path this test targets.
    driver.setSnapshot({
      url: "http://localhost:3000/chat",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "waiting",
    });
    driver.setEmitResult({
      delivered: false,
      socketUrl: "wss://localhost/session/abc",
      realm: "main",
      reason: "dispatched-unconfirmed",
      candidates: [],
    });

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    // `reason: "dispatched-unconfirmed"` maps to `dispatchState: "uncertain"` (the frame was
    // sent but bp could not confirm delivery). emit is always `effect = "at_most_once"`
    // (schema-forced), so an uncertain at-most-once dispatch with no rescuing postcondition
    // trips the inconclusive path (never redispatched), NOT a normal `failed` — this is not an
    // infra error either, just a lower-confidence outcome than a plain step failure.
    expect(result.summary.verdict).toBe("inconclusive");
    expect(result.exitCode).toBe(3);
    const sendStep = result.summary.steps.find((s) => s.stepId === "send");
    expect(sendStep?.ok).toBe(false);
    expect(sendStep?.dispatchState).toBe("uncertain");
    expect(String(sendStep?.error ?? "")).toContain("not delivered");

    const trace = await readJsonl(join(result.runDir, "trace.jsonl"));
    const ba = trace.find((e) => e.type === "browser_action" && e.action === "emit");
    expect(ba?.ok).toBe(false);
  });

  test("a missing awaited reply fails the step (delivered but no reply)", async () => {
    const { flowPath, outDir } = await writeFlow(EMIT_FLOW);
    const driver = new MockDriver();
    // NOTE: text is deliberately NOT "sent" — see the comment in the previous test.
    driver.setSnapshot({
      url: "http://localhost:3000/chat",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "waiting",
    });
    driver.setEmitResult({
      delivered: true,
      socketUrl: "wss://localhost/session/abc",
      realm: "main",
      candidates: [],
      // no `reply` — the step declared `await_reply`, so this must fail.
    });

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    // `delivered: true` + a missing reply is a CONFIRMED dispatch (`dispatchState: "dispatched"`)
    // with only the reply-observation missing — still non-`not_dispatched`, so the at-most-once
    // inconclusive path applies exactly as for the unconfirmed-delivery case above.
    expect(result.summary.verdict).toBe("inconclusive");
    const sendStep = result.summary.steps.find((s) => s.stepId === "send");
    expect(sendStep?.ok).toBe(false);
    expect(sendStep?.dispatchState).toBe("dispatched");
    expect(String(sendStep?.error ?? "")).toContain("awaited reply");
  });

  test("a rejected emitCommand (ambiguous socket / timeout) is a normal step failure, not an infra error", async () => {
    const { flowPath, outDir } = await writeFlow(EMIT_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot({
      url: "http://localhost:3000/chat",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "sent",
    });
    driver.enqueueEmitError(new Error("EmitTargetError: 2 candidate sockets, expected 1"));

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("failed");
    expect(result.exitCode).toBe(1);
    const sendStep = result.summary.steps.find((s) => s.stepId === "send");
    expect(sendStep?.ok).toBe(false);
    expect(String(sendStep?.error ?? "")).toContain("2 candidate sockets");
  });
});

describe("runFlow — emit step (missing driver capability)", () => {
  test("a driver without emitCommand fails the step with a clear upgrade message", async () => {
    const { flowPath, outDir } = await writeFlow(EMIT_FLOW);
    const driver = new MockDriver(); // emitCommand never scripted → stays undefined
    driver.setSnapshot({
      url: "http://localhost:3000/chat",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "sent",
    });
    expect((driver as unknown as { emitCommand?: unknown }).emitCommand).toBeUndefined();

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("failed");
    const sendStep = result.summary.steps.find((s) => s.stepId === "send");
    expect(sendStep?.ok).toBe(false);
    expect(String(sendStep?.error ?? "")).toContain("browser-pilot >=0.2.0 required");
  });
});

describe("runFlow — emit step (redaction)", () => {
  const SECRET_EMIT_FLOW = `
version = 1
kind = "flow"
id = "test.emit.secret"
description = "emit a secret payload"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/chat"

[[steps]]
id = "send"
do = "emit"
channel = "ws"
payload = "top-secret-token-xyz"
secret = true
`;

  test("secret = true redacts the payload in trace.jsonl's browser_action event", async () => {
    const { flowPath, outDir } = await writeFlow(SECRET_EMIT_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot({
      url: "http://localhost:3000/chat",
      title: "",
      timestamp: new Date(0).toISOString(),
      accessibilityTree: [],
      interactiveElements: [],
      text: "",
    });
    driver.setEmitResult({
      delivered: true,
      socketUrl: "wss://localhost/session/abc",
      realm: "main",
      candidates: [],
    });

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("passed");
    const trace = await readJsonl(join(result.runDir, "trace.jsonl"));
    const ba = trace.find((e) => e.type === "browser_action" && e.action === "emit");
    expect(ba).toBeDefined();
    const selectorOrIntent = typeof ba?.selectorOrIntent === "string" ? ba.selectorOrIntent : "";
    expect(selectorOrIntent).not.toContain("top-secret-token-xyz");
    expect(selectorOrIntent).toContain("«redacted»");

    // The literal payload never reached emitCommand's args unredacted in the CALL LOG check below
    // is not meaningful (the driver legitimately needs the real payload to dispatch it) — only the
    // ARTIFACT must be redacted, which is asserted above.
  });
});
