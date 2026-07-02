// Flightplan — `aiCall` redaction threading tests (PLAN.md §5 Phase 5; OFFLINE + deterministic).
//
// NO network, NO SDK: a fake `GenerateFn` returns a canned `{ output, usage }` and a `RecordingSink`
// captures the emitted `ai_call` event. Asserts that:
//   - with a redactor wired, `redactedPrompt`/`redactedResponse` are populated and the raw secret
//     NEVER appears (text prompt + vision message prompt + JSON response);
//   - with NO redactor (or a disabled one), those fields stay OMITTED (pre-redaction behavior).

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AiCallEvent } from "../artifacts/events.ts";
import { createRedactor, REDACTED } from "../redaction/index.ts";
import { BudgetTracker, resolveBudgetLimits } from "./budget.ts";
import type { AiCallRuntime } from "./call.ts";
import { aiCall } from "./call.ts";
import { CostAccumulator } from "./cost.ts";
import { resolveRegistry } from "./registry.ts";
import type { AiCallContext, AiCallSink, GenerateFn, GenerateRequest } from "./types.ts";

class RecordingSink implements AiCallSink {
  readonly events: Array<Omit<AiCallEvent, "ts" | "type">> = [];
  emitAiCall(p: Omit<AiCallEvent, "ts" | "type">): void {
    this.events.push(p);
  }
}

/** A fake GenerateFn returning a fixed validated output. */
function fakeGenerate(output: unknown): { fn: GenerateFn; calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = [];
  const fn: GenerateFn = async (req) => {
    calls.push(req);
    return { output, model: req.models[0]!, usage: { inputTokens: 10, outputTokens: 5 } };
  };
  return { fn, calls };
}

function makeRt(
  generate: GenerateFn,
  sink: AiCallSink,
  redactor?: AiCallRuntime["redactor"],
): AiCallRuntime {
  return {
    registry: resolveRegistry({}),
    budget: new BudgetTracker(resolveBudgetLimits({})),
    cost: new CostAccumulator(),
    generate,
    aiWriter: sink,
    ...(redactor ? { redactor } : {}),
  };
}

const SECRET = "hunter2-password";
const schema = z.object({ answer: z.string() });

const textCtx: AiCallContext<typeof schema> = {
  modelRole: "resolver",
  purpose: "resolve:s1",
  schema,
  maxOutputTokens: 512,
  prompt: `The password is ${SECRET}; also email a@b.com`,
};

describe("aiCall — redaction threading", () => {
  test("with an active redactor, redactedPrompt/Response mask the secret and never leak it", async () => {
    const sink = new RecordingSink();
    const { fn } = fakeGenerate({ answer: `echo ${SECRET}` });
    const redactor = createRedactor({ maskText: true, secrets: [SECRET] });
    const rt = makeRt(fn, sink, redactor);

    await aiCall(rt, textCtx);

    expect(sink.events.length).toBe(1);
    const ev = sink.events[0]!;
    expect(ev.redactedPrompt).toBeDefined();
    expect(ev.redactedResponse).toBeDefined();
    // The raw secret never appears anywhere in the event.
    expect(JSON.stringify(ev)).not.toContain(SECRET);
    expect(ev.redactedPrompt).toContain(REDACTED);
    expect(ev.redactedResponse).toContain(REDACTED);
    // PII (email) masked too (mask_text on).
    expect(ev.redactedPrompt).not.toContain("a@b.com");
  });

  test("vision messages are flattened + redacted (file parts become placeholders, secret masked)", async () => {
    const sink = new RecordingSink();
    const { fn } = fakeGenerate({ answer: "ok" });
    const redactor = createRedactor({ maskText: true, secrets: [SECRET] });
    const rt = makeRt(fn, sink, redactor);

    const visionCtx: AiCallContext<typeof schema> = {
      modelRole: "vision",
      callRole: "vision",
      purpose: "vision:s1",
      schema,
      maxOutputTokens: 512,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `find the field; secret ${SECRET}` },
            { type: "file", mediaType: "image/jpeg", data: "BASE64IMAGEDATA====" },
          ],
        },
      ],
    };

    await aiCall(rt, visionCtx);
    const ev = sink.events[0]!;
    expect(ev.redactedPrompt).toContain("[file:image/jpeg]");
    expect(ev.redactedPrompt).not.toContain("BASE64IMAGEDATA");
    expect(ev.redactedPrompt).not.toContain(SECRET);
  });

  test("with NO redactor, redactedPrompt/Response are omitted (behavior preserved)", async () => {
    const sink = new RecordingSink();
    const { fn } = fakeGenerate({ answer: `echo ${SECRET}` });
    const rt = makeRt(fn, sink);

    await aiCall(rt, textCtx);
    const ev = sink.events[0]!;
    expect(ev.redactedPrompt).toBeUndefined();
    expect(ev.redactedResponse).toBeUndefined();
  });

  test("a disabled redactor (no secrets, mask_text off) omits the fields too", async () => {
    const sink = new RecordingSink();
    const { fn } = fakeGenerate({ answer: "ok" });
    const rt = makeRt(fn, sink, createRedactor({ maskText: false }));

    await aiCall(rt, textCtx);
    const ev = sink.events[0]!;
    expect(ev.redactedPrompt).toBeUndefined();
    expect(ev.redactedResponse).toBeUndefined();
  });
});
