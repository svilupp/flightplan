// Flightplan — `aiCall` timeout / circuit-breaker tests (P6 improvement plan §2, OFFLINE).
//
// Verifies the L4-advisor-hang fix WITHOUT any real network or real long waits:
//   - `aiCall` threads a role-aware `timeoutMs` into `GenerateRequest` (the seam `defaultGenerate`
//     consumes to build `AbortSignal.timeout(timeoutMs)` — see `provider.test.ts` for that half).
//   - A `GenerateFn` test double that "hangs" (only resolves/rejects after `req.timeoutMs`, mimicking
//     what `AbortSignal.timeout` would do to a real `generateText` call) causes `aiCall` to reject
//     within its configured ceiling instead of hanging indefinitely.
//   - The resulting failure is classified as the `timeout` outcome (distinguishable from
//     `no_output`/`error`) and recorded on the emitted `ai_call` event for telemetry.
//   - `AiCallRuntime.timeoutMsByRole` lets a test shrink the ceiling to milliseconds so this test
//     itself stays fast (no real 20-40s waits).

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AiCallEvent } from "../artifacts/events.ts";
import { aiCall, DEFAULT_TIMEOUT_MS_BY_ROLE } from "./call.ts";
import type { AiCallRuntime } from "./call.ts";
import { resolveRegistry } from "./registry.ts";
import { BudgetTracker, resolveBudgetLimits } from "./budget.ts";
import { CostAccumulator } from "./cost.ts";
import type { AiCallContext, AiCallSink, GenerateFn } from "./types.ts";

class RecordingSink implements AiCallSink {
  readonly events: Array<Omit<AiCallEvent, "ts" | "type">> = [];
  emitAiCall(p: Omit<AiCallEvent, "ts" | "type">): void {
    this.events.push(p);
  }
}

/**
 * A `GenerateFn` double that emulates a hung provider call: it never resolves on its own and only
 * rejects with a `TimeoutError` once `req.timeoutMs` elapses — exactly what `AbortSignal.timeout`
 * produces in the real `defaultGenerate`. Lets us prove `aiCall` doesn't hang WITHOUT touching the
 * AI SDK, and stays fast because tests override `timeoutMsByRole` to a few ms.
 */
function hangingGenerate(): GenerateFn {
  return (req) =>
    new Promise((_resolve, reject) => {
      const ms = req.timeoutMs ?? 30_000;
      setTimeout(() => {
        const err = new Error(`The operation timed out after ${ms}ms`);
        err.name = "TimeoutError";
        reject(err);
      }, ms);
    });
}

function makeRt(generate: GenerateFn, timeoutMsByRole: AiCallRuntime["timeoutMsByRole"]): {
  rt: AiCallRuntime;
  sink: RecordingSink;
} {
  const sink = new RecordingSink();
  const rt: AiCallRuntime = {
    registry: resolveRegistry({}),
    budget: new BudgetTracker(resolveBudgetLimits({})),
    cost: new CostAccumulator(),
    generate,
    aiWriter: sink,
    timeoutMsByRole,
  };
  return { rt, sink };
}

const schema = z.object({ answer: z.string() });

describe("aiCall — timeout circuit breaker (P6 §2)", () => {
  test("a hanging GenerateFn rejects within the configured timeout instead of hanging forever", async () => {
    const { rt, sink } = makeRt(hangingGenerate(), { resolver: 15 });
    const ctx: AiCallContext<typeof schema> = {
      modelRole: "resolver",
      purpose: "resolve:s1",
      schema,
      maxOutputTokens: 512,
      prompt: "resolve it",
    };

    const started = Date.now();
    let err: unknown;
    try {
      await aiCall(rt, ctx);
    } catch (e) {
      err = e;
    }
    const elapsedMs = Date.now() - started;

    expect(err).toBeInstanceOf(Error);
    // Generous slack over the 15ms configured ceiling — still nowhere near a real 20-40s default,
    // let alone the 174s campaign hang this guards against.
    expect(elapsedMs).toBeLessThan(2_000);

    expect(sink.events.length).toBe(1);
    expect(sink.events[0]!.outcome).toBe("timeout");
  });

  test("the timeout outcome is distinguishable from no_output/error", async () => {
    const timeoutFn: GenerateFn = () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      return Promise.reject(err);
    };
    const noOutputFn: GenerateFn = () => Promise.reject(new Error("AI_NoOutputGeneratedError: No output generated."));
    const genericErrFn: GenerateFn = () => Promise.reject(new Error("rate limited"));

    const ctx: AiCallContext<typeof schema> = {
      modelRole: "advisor",
      purpose: "judge:s1",
      schema,
      maxOutputTokens: 512,
      prompt: "judge it",
    };

    for (const [fn, expected] of [
      [timeoutFn, "timeout"],
      [noOutputFn, "no_output"],
      [genericErrFn, "error"],
    ] as const) {
      const { rt, sink } = makeRt(fn, { advisor: 5 });
      await expect(aiCall(rt, ctx)).rejects.toBeInstanceOf(Error);
      expect(sink.events[0]!.outcome).toBe(expected);
    }
  });

  test("aiCall threads a role-aware default timeoutMs when no override is supplied", async () => {
    let seenTimeoutMs: number | undefined;
    const captureFn: GenerateFn = async (req) => {
      seenTimeoutMs = req.timeoutMs;
      return { output: { answer: "ok" }, model: req.models[0]!, usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const { rt } = makeRt(captureFn, undefined);
    const ctx: AiCallContext<typeof schema> = {
      modelRole: "advisor",
      purpose: "judge:s1",
      schema,
      maxOutputTokens: 512,
      prompt: "judge it",
    };

    await aiCall(rt, ctx);

    expect(seenTimeoutMs).toBe(DEFAULT_TIMEOUT_MS_BY_ROLE.advisor);
    // Bounded (not unbounded/infinite) and L4 gets more headroom than the hot L2/L3 path, but not
    // unbounded.
    expect(DEFAULT_TIMEOUT_MS_BY_ROLE.advisor).toBeGreaterThan(DEFAULT_TIMEOUT_MS_BY_ROLE.resolver);
    expect(DEFAULT_TIMEOUT_MS_BY_ROLE.advisor).toBeLessThanOrEqual(60_000);
  });
});
