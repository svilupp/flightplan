// Tests for the telemetry module (PLAN.md §5 Phase 5; P5_DESIGN.md §4 "TELEMETRY", Unit B).
//
// Offline only: gating truth-table, FakeSink span/event capture, no-op-when-disabled, a throwing
// / rejecting sink can NEVER break a run, and the LogfireSink OTLP transport (via an injected
// fetch — no real network).

import { describe, expect, test } from "bun:test";
import type { AiCallEvent, BrowserActionEvent } from "../artifacts/events.ts";
import type { Config } from "../config/types.ts";
import {
  aiCallEventAttrs,
  browserActionEventAttrs,
  createTelemetry,
  type ExportedSpan,
  FakeSink,
  type IdGenerator,
  LogfireSink,
  NOOP_SPAN,
  NOOP_TELEMETRY,
  resolveTelemetryGating,
  runEndAttrs,
  runSpanAttrs,
  stepEndAttrs,
  stepSpanAttrs,
  TELEMETRY_EVENTS,
  TELEMETRY_SPAN_NAMES,
  type TelemetrySink,
  toOtlpPayload,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic, human-readable ids (length is irrelevant for FakeSink assertions). */
function seqIds(): IdGenerator {
  let t = 0;
  let s = 0;
  return {
    traceId: () => `trace-${t++}`,
    spanId: () => `span-${s++}`,
  };
}

interface LogfireOpts {
  enabled?: "auto" | boolean;
  token_env?: string;
  service_name?: string;
}
function cfg(logfire?: LogfireOpts): Config {
  return (logfire ? { telemetry: { logfire } } : {}) as Config;
}

const FAKE_AI_CALL: AiCallEvent = {
  type: "ai_call",
  ts: 123,
  role: "resolver",
  model: "deepseek/deepseek-v4-flash",
  purpose: "resolve",
  inputTokens: 10,
  outputTokens: 4,
  cost_usd: 0.000005,
  outcome: "ok",
  redactedPrompt: "should not appear in telemetry",
  redactedResponse: "neither should this",
};

const FAKE_BROWSER_ACTION: BrowserActionEvent = {
  type: "browser_action",
  ts: 123,
  action: "click",
  selectorOrIntent: "Create order",
  selectorUsed: "role:button:Create order",
  strategy: "role_name",
  ok: true,
  durationMs: 12,
};

// ---------------------------------------------------------------------------
// Gating truth-table
// ---------------------------------------------------------------------------

describe("resolveTelemetryGating — gating truth table", () => {
  const withToken = { LOGFIRE_TOKEN: "tok_abc" };
  const noToken: Record<string, string | undefined> = {};

  test("enabled=false → off regardless of token", () => {
    expect(resolveTelemetryGating(cfg({ enabled: false }), withToken).enabled).toBe(false);
    expect(resolveTelemetryGating(cfg({ enabled: false }), noToken).enabled).toBe(false);
  });

  test("enabled=true → on; token present or absent", () => {
    const a = resolveTelemetryGating(cfg({ enabled: true }), withToken);
    expect(a.enabled).toBe(true);
    expect(a.token).toBe("tok_abc");
    const b = resolveTelemetryGating(cfg({ enabled: true }), noToken);
    expect(b.enabled).toBe(true);
    expect(b.token).toBeUndefined();
  });

  test("enabled=auto → on iff token present", () => {
    expect(resolveTelemetryGating(cfg({ enabled: "auto" }), withToken).enabled).toBe(true);
    expect(resolveTelemetryGating(cfg({ enabled: "auto" }), noToken).enabled).toBe(false);
  });

  test("enabled unset → on iff token present", () => {
    expect(resolveTelemetryGating(cfg(), withToken).enabled).toBe(true);
    expect(resolveTelemetryGating(cfg(), noToken).enabled).toBe(false);
  });

  test("custom token_env is honored", () => {
    const c = cfg({ enabled: "auto", token_env: "MY_LF" });
    expect(resolveTelemetryGating(c, { MY_LF: "x" }).enabled).toBe(true);
    expect(resolveTelemetryGating(c, { LOGFIRE_TOKEN: "x" }).enabled).toBe(false);
    expect(resolveTelemetryGating(c, { MY_LF: "x" }).tokenEnv).toBe("MY_LF");
  });

  test("whitespace-only token counts as absent", () => {
    expect(resolveTelemetryGating(cfg({ enabled: "auto" }), { LOGFIRE_TOKEN: "   " }).enabled).toBe(false);
  });

  test("service_name default + override", () => {
    expect(resolveTelemetryGating(cfg(), {}).serviceName).toBe("flightplan");
    expect(resolveTelemetryGating(cfg({ service_name: "svc" }), {}).serviceName).toBe("svc");
  });
});

// ---------------------------------------------------------------------------
// Disabled → no-op (nothing emitted, no throw, negligible overhead)
// ---------------------------------------------------------------------------

describe("createTelemetry — disabled is a strict no-op", () => {
  test("no token → NOOP_TELEMETRY; injected sink is never touched", () => {
    const sink = new FakeSink();
    const tel = createTelemetry({ config: cfg(), env: {}, sink });
    expect(tel.enabled).toBe(false);

    const run = tel.startRun(runSpanAttrs({ flowId: "f", runId: "r" }));
    const step = run.child(TELEMETRY_SPAN_NAMES.step, stepSpanAttrs({ stepId: "s1", do: "click" }));
    step.event(TELEMETRY_EVENTS.aiCall, aiCallEventAttrs(FAKE_AI_CALL));
    step.end(stepEndAttrs({ ok: true, healed: false }));
    run.end(runEndAttrs({ verdict: "passed", driftCount: 0 }));

    expect(sink.spans).toHaveLength(0);
  });

  test("NOOP_SPAN.child returns the same singleton (no allocation)", () => {
    expect(NOOP_SPAN.child("x")).toBe(NOOP_SPAN);
    expect(NOOP_TELEMETRY.enabled).toBe(false);
    expect(NOOP_TELEMETRY.startRun()).toBe(NOOP_SPAN);
  });

  test("enabled=false with a token present is still off", () => {
    const tel = createTelemetry({ config: cfg({ enabled: false }), env: { LOGFIRE_TOKEN: "tok" } });
    expect(tel.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FakeSink captures run span + step spans + events with correct attributes
// ---------------------------------------------------------------------------

describe("createTelemetry — FakeSink captures the span/event tree", () => {
  function drive(sink: FakeSink) {
    const tel = createTelemetry({
      config: cfg({ enabled: "auto" }),
      env: { LOGFIRE_TOKEN: "tok" },
      sink,
      now: () => 1000,
      ids: seqIds(),
    });
    expect(tel.enabled).toBe(true);

    const run = tel.startRun(runSpanAttrs({ flowId: "checkout", runId: "run-42" }));
    const step = run.child(
      TELEMETRY_SPAN_NAMES.step,
      stepSpanAttrs({ stepId: "s1", do: "click", intent: "place order" }),
    );
    step.event(TELEMETRY_EVENTS.browserAction, browserActionEventAttrs(FAKE_BROWSER_ACTION));
    step.event(TELEMETRY_EVENTS.aiCall, aiCallEventAttrs(FAKE_AI_CALL));
    step.end(stepEndAttrs({ ok: true, tier: "L2", healed: true, repaired: false, durationMs: 50 }));
    run.end(runEndAttrs({ verdict: "passed", driftCount: 1 }));
    return tel;
  }

  test("run span carries flow_id/run_id + end attrs verdict/drift_count", () => {
    const sink = new FakeSink();
    drive(sink);
    const run = sink.runSpan();
    expect(run).toBeDefined();
    expect(run!.attributes).toMatchObject({
      flow_id: "checkout",
      run_id: "run-42",
      verdict: "passed",
      drift_count: 1,
    });
    expect(run!.parentSpanId).toBeUndefined();
  });

  test("step span carries step_id/do/tier/ok/healed and links to the run span", () => {
    const sink = new FakeSink();
    drive(sink);
    const run = sink.runSpan()!;
    const steps = sink.stepSpans();
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    expect(step.attributes).toMatchObject({
      step_id: "s1",
      do: "click",
      intent: "place order",
      ok: true,
      tier: "L2",
      healed: true,
      repaired: false,
      duration_ms: 50,
    });
    // parent/child linkage + shared trace.
    expect(step.parentSpanId).toBe(run.spanId);
    expect(step.traceId).toBe(run.traceId);
  });

  test("events are recorded on the step span with correct attributes", () => {
    const sink = new FakeSink();
    drive(sink);
    const step = sink.stepSpans()[0]!;
    const names = step.events.map((e) => e.name);
    expect(names).toEqual([TELEMETRY_EVENTS.browserAction, TELEMETRY_EVENTS.aiCall]);

    const ai = step.events.find((e) => e.name === TELEMETRY_EVENTS.aiCall)!;
    expect(ai.attributes).toMatchObject({
      role: "resolver",
      model: "deepseek/deepseek-v4-flash",
      cost_usd: 0.000005,
      input_tokens: 10,
      output_tokens: 4,
      outcome: "ok",
    });
    // Defense-in-depth: prompt/response text never reaches telemetry.
    const serialized = JSON.stringify(ai.attributes);
    expect(serialized).not.toContain("should not appear");
    expect(serialized).not.toContain("neither should this");
  });

  test("step span is exported before the run span (children close first)", () => {
    const sink = new FakeSink();
    drive(sink);
    expect(sink.spans.map((s) => s.name)).toEqual([
      TELEMETRY_SPAN_NAMES.step,
      TELEMETRY_SPAN_NAMES.run,
    ]);
  });

  test("undefined attrs are stripped (e.g. an omitted tier)", () => {
    const sink = new FakeSink();
    const tel = createTelemetry({ config: cfg({ enabled: true }), env: { LOGFIRE_TOKEN: "t" }, sink });
    const run = tel.startRun(runSpanAttrs({ flowId: "f", runId: "r" }));
    const step = run.child(TELEMETRY_SPAN_NAMES.step, stepSpanAttrs({ stepId: "s", do: "wait" }));
    step.end(stepEndAttrs({ ok: true, healed: false })); // no tier/repaired/durationMs
    run.end();
    const s = sink.stepSpans()[0]!;
    expect("tier" in s.attributes).toBe(false);
    expect("repaired" in s.attributes).toBe(false);
    expect(s.attributes).toMatchObject({ ok: true, healed: false });
  });
});

// ---------------------------------------------------------------------------
// A misconfigured / failing sink can NEVER break a run
// ---------------------------------------------------------------------------

describe("createTelemetry — a failing sink never propagates into the run", () => {
  test("synchronously-throwing sink is swallowed + degrades to no-op", () => {
    let exportCalls = 0;
    const throwing: TelemetrySink = {
      export() {
        exportCalls++;
        throw new Error("boom");
      },
    };
    const errors: unknown[] = [];
    const tel = createTelemetry({
      config: cfg({ enabled: true }),
      env: { LOGFIRE_TOKEN: "t" },
      sink: throwing,
      ids: seqIds(),
      onError: (e) => errors.push(e),
    });

    // Driving the whole tree must not throw.
    expect(() => {
      const run = tel.startRun(runSpanAttrs({ flowId: "f", runId: "r" }));
      const step = run.child(TELEMETRY_SPAN_NAMES.step, stepSpanAttrs({ stepId: "s", do: "click" }));
      step.end(stepEndAttrs({ ok: true, healed: false }));
      run.end(runEndAttrs({ verdict: "passed", driftCount: 0 }));
    }).not.toThrow();

    // First failed export degrades telemetry → the second span is NOT exported again.
    expect(exportCalls).toBe(1);
    expect(errors).toHaveLength(1);
  });

  test("asynchronously-rejecting sink is swallowed (no unhandled rejection)", async () => {
    let exportCalls = 0;
    const rejecting: TelemetrySink = {
      export() {
        exportCalls++;
        return Promise.reject(new Error("network down"));
      },
    };
    const errors: unknown[] = [];
    const tel = createTelemetry({
      config: cfg({ enabled: true }),
      env: { LOGFIRE_TOKEN: "t" },
      sink: rejecting,
      ids: seqIds(),
      onError: (e) => errors.push(e),
    });

    const run = tel.startRun(runSpanAttrs({ flowId: "f", runId: "r" }));
    const step = run.child(TELEMETRY_SPAN_NAMES.step, stepSpanAttrs({ stepId: "s", do: "click" }));
    step.end(stepEndAttrs({ ok: true, healed: false }));
    // Let the rejection settle before the run span ends.
    await Promise.resolve();
    await Promise.resolve();
    run.end(runEndAttrs({ verdict: "passed", driftCount: 0 }));

    expect(errors).toHaveLength(1);
    // The run-span export was skipped after the first transport failure degraded telemetry.
    expect(exportCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LogfireSink — OTLP transport via an injected fetch (no real network)
// ---------------------------------------------------------------------------

describe("LogfireSink — OTLP/HTTP transport", () => {
  function fakeFetch() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  const SPAN: ExportedSpan = {
    traceId: "trace-1",
    spanId: "span-1",
    name: "flightplan.run",
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: "2000000000",
    attributes: { flow_id: "f", drift_count: 2, healed: true, ratio: 0.5, tags: ["a", "b"] },
    events: [{ name: "ai_call", timeUnixNano: "1500000000", attributes: { cost_usd: 0.1 } }],
  };

  test("posts OTLP JSON with bearer auth to the traces endpoint", async () => {
    const { calls, impl } = fakeFetch();
    const sink = new LogfireSink({ token: "tok_xyz", serviceName: "svc", fetchImpl: impl });
    await sink.export(SPAN);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://logfire-api.pydantic.dev/v1/traces");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok_xyz");
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(calls[0]!.init.body as string);
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe("trace-1");
    expect(span.name).toBe("flightplan.run");
    expect(body.resourceSpans[0].resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "svc" },
    });
    // Attribute encoding: int / double / bool / array.
    expect(span.attributes).toContainEqual({ key: "drift_count", value: { intValue: "2" } });
    expect(span.attributes).toContainEqual({ key: "healed", value: { boolValue: true } });
    expect(span.attributes).toContainEqual({ key: "ratio", value: { doubleValue: 0.5 } });
    expect(span.attributes).toContainEqual({
      key: "tags",
      value: { arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } },
    });
    expect(span.events[0]).toMatchObject({ name: "ai_call", timeUnixNano: "1500000000" });
  });

  test("no token → no network call (warns once)", async () => {
    const { calls, impl } = fakeFetch();
    const warnings: string[] = [];
    const sink = new LogfireSink({ fetchImpl: impl, onWarn: (m) => warnings.push(m) });
    await sink.export(SPAN);
    await sink.export(SPAN);
    expect(calls).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  test("a non-2xx response rejects so the caller can degrade", async () => {
    const impl = (() => Promise.resolve(new Response(null, { status: 503 }))) as unknown as typeof fetch;
    const sink = new LogfireSink({ token: "t", fetchImpl: impl });
    await expect(sink.export(SPAN)).rejects.toThrow(/HTTP 503/);
  });

  test("toOtlpPayload is pure and matches the wire shape", () => {
    const payload = toOtlpPayload(SPAN, "flightplan");
    const span = (payload as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.kind).toBe(1);
    expect(span.startTimeUnixNano).toBe("1000000000");
    expect(span.endTimeUnixNano).toBe("2000000000");
  });
});

// ---------------------------------------------------------------------------
// Attribute builders
// ---------------------------------------------------------------------------

describe("attribute builders", () => {
  test("aiCallEventAttrs maps metrics and omits redacted text", () => {
    const attrs = aiCallEventAttrs(FAKE_AI_CALL);
    expect(attrs).toEqual({
      role: "resolver",
      model: "deepseek/deepseek-v4-flash",
      purpose: "resolve",
      input_tokens: 10,
      output_tokens: 4,
      cost_usd: 0.000005,
      outcome: "ok",
      advisory_verdict: undefined,
    });
    expect("redactedPrompt" in attrs).toBe(false);
    expect("redactedResponse" in attrs).toBe(false);
  });

  test("runEndAttrs / stepEndAttrs shape", () => {
    expect(runEndAttrs({ verdict: "failed", driftCount: 3 })).toEqual({
      verdict: "failed",
      drift_count: 3,
    });
    expect(stepEndAttrs({ ok: false, tier: "L4", healed: false, repaired: true, durationMs: 9 })).toEqual({
      ok: false,
      tier: "L4",
      healed: false,
      repaired: true,
      duration_ms: 9,
    });
  });
});
