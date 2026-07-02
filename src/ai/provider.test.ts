// Flightplan — the ONE SDK-touching test (ISOLATED). It exercises `provider.ts`'s real
// `defaultGenerate` against the AI SDK's `MockLanguageModelV3` from `ai/test` — NO network — to
// verify (a) the `output: Output.object({schema})` call shape produces a validated `result.output`
// and (b) per-role fallback iteration (a failing model → the next model). Kept isolated so an SDK
// bump fails exactly THIS test, not the rest of the offline `ai/` suite.
//
// NOTE: the rest of the AI tests are SDK-free (see `ai.test.ts`); this file is the deliberate
// exception that pins the provider call shape to the installed `ai@6` + provider versions.

import { describe, expect, test } from "bun:test";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { defaultGenerate } from "./provider.ts";
import { JudgeSchema } from "./schemas.ts";

/**
 * A mock model that never resolves on its own — emulates a hung provider call (e.g. the 174s L4
 * hang). Like a real `fetch`-backed model, it DOES honor `options.abortSignal`: when the signal
 * fires it rejects with the signal's abort reason (a `TimeoutError`), which is how
 * `AbortSignal.timeout` actually terminates a real hung HTTP call.
 */
function hangingModel(): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: (options: { abortSignal?: AbortSignal }) =>
      new Promise<LanguageModelV3GenerateResult>((_resolve, reject) => {
        options.abortSignal?.addEventListener("abort", () => {
          reject(options.abortSignal!.reason ?? new Error("aborted"));
        });
      }),
  });
}

/** A mock model whose single text part is a JSON object the Output API will parse + validate. */
function jsonModel(json: string): LanguageModelV3 {
  const result: LanguageModelV3GenerateResult = {
    content: [{ type: "text", text: json }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 4, text: 4, reasoning: 0 },
    },
    warnings: [],
  };
  return new MockLanguageModelV3({ doGenerate: async () => result });
}

/** A mock model that always throws (an exhausted/rotated/no-output model). */
function failingModel(): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("AI_NoOutputGeneratedError: No output generated.");
    },
  });
}

describe("provider.defaultGenerate — Output API call shape + fallback iteration", () => {
  test("output: Output.object({schema}) → validated result.output", async () => {
    const generate = defaultGenerate({
      resolveModel: () => jsonModel('{"pass":true,"reason":"ok"}'),
    });

    const result = await generate({
      modelRole: "resolver",
      models: ["deepseek/deepseek-v4-flash"],
      schema: JudgeSchema,
      maxOutputTokens: 512,
      prompt: "judge it",
    });

    expect(result.output).toEqual({ pass: true, reason: "ok" });
    expect(result.model).toBe("deepseek/deepseek-v4-flash");
    expect(result.usage.inputTokens).toBe(7);
    expect(result.usage.outputTokens).toBe(4);
  });

  test("fallback iteration — first model fails, second succeeds", async () => {
    const models: Record<string, LanguageModelV3> = {
      "primary/fails": failingModel(),
      "fallback/works": jsonModel('{"pass":false,"reason":"nope"}'),
    };
    const generate = defaultGenerate({ resolveModel: (id) => models[id]! });

    const result = await generate({
      modelRole: "resolver",
      models: ["primary/fails", "fallback/works"],
      schema: JudgeSchema,
      maxOutputTokens: 512,
      prompt: "judge it",
    });

    expect(result.model).toBe("fallback/works");
    expect(result.output).toEqual({ pass: false, reason: "nope" });
  });

  test("all models failing → throws the last error", async () => {
    const generate = defaultGenerate({ resolveModel: () => failingModel() });
    let err: unknown;
    try {
      await generate({
        modelRole: "vision",
        models: ["a/x", "b/y"],
        schema: JudgeSchema,
        maxOutputTokens: 512,
        prompt: "judge it",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });

  test("per-call timeoutMs aborts a hanging model instead of blocking forever (P6 §2)", async () => {
    const generate = defaultGenerate({ resolveModel: () => hangingModel() });

    const started = Date.now();
    let err: unknown;
    try {
      await generate({
        modelRole: "advisor",
        models: ["z-ai/glm-5.2"],
        schema: JudgeSchema,
        maxOutputTokens: 512,
        prompt: "judge it",
        timeoutMs: 25, // short test override — real defaults are 20-40s, never this short
      });
    } catch (e) {
      err = e;
    }
    const elapsedMs = Date.now() - started;

    expect(err).toBeInstanceOf(Error);
    // Well under the real default ceiling and light-years from the 174s campaign hang.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test("a normal (fast) call is unaffected by the default timeout — no behavior change", async () => {
    const generate = defaultGenerate({
      resolveModel: () => jsonModel('{"pass":true,"reason":"ok"}'),
    });

    const result = await generate({
      modelRole: "resolver",
      models: ["deepseek/deepseek-v4-flash"],
      schema: JudgeSchema,
      maxOutputTokens: 512,
      prompt: "judge it",
      // no timeoutMs — exercises the DEFAULT_TIMEOUT_MS fallback path.
    });

    expect(result.output).toEqual({ pass: true, reason: "ok" });
  });
});
