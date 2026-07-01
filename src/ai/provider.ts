// Flightplan — the ONLY file that imports the AI SDK (`ai`), `@openrouter/ai-sdk-provider`, and
// (optionally) `@ai-sdk/google`. It supplies the REAL `GenerateFn` (`defaultGenerate`) so the
// rest of `ai/` and ALL tests stay SDK-free behind the `GenerateFn` seam.
//
// Chosen transport (FINDINGS_ai_integration §3, decision 2026-06-29): vision + text BOTH run on
// the one OpenRouter provider on `ai@6`. The Output API is `generateText({ output:
// Output.object({schema}) }) → result.output` (NOT `experimental_output`; FINDINGS §2 / spike 11).
// Vision attaches the screenshot as a `file` part with a `data:` URL and uses `maxOutputTokens
// ≥512` to cover Gemini thinking tokens (FINDINGS §3 / spike 12/17). `@ai-sdk/google` +
// raw OpenRouter HTTP remain documented fallbacks ONLY (not wired in v1) and, if ever needed,
// would also live here behind this boundary.

import { generateText, Output } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import type { GenerateFn, GenerateRequest, RawUsage } from "./types.ts";

/** Options for {@link createProvider}. */
export interface CreateProviderOptions {
  apiKey: string;
  appName?: string;
  appUrl?: string;
}

/**
 * Construct the OpenRouter provider with usage accounting enabled (so OpenRouter returns `cost`
 * for budget telemetry — FINDINGS §4; pricing-derived cost remains the authoritative budget
 * number regardless). One provider serves text AND vision (FINDINGS §3).
 */
export function createProvider(opts: CreateProviderOptions): OpenRouterProvider {
  return createOpenRouter({
    apiKey: opts.apiKey,
    // Enable OpenRouter usage accounting → `cost` in the response (best-effort).
    extraBody: { usage: { include: true } },
    ...(opts.appName !== undefined ? { appName: opts.appName } : {}),
    ...(opts.appUrl !== undefined ? { appUrl: opts.appUrl } : {}),
  });
}

/** Read an OpenRouter-reported cost from a `generateText` result (best-effort; several shapes). */
function readProviderCost(result: unknown): number | undefined {
  const r = result as {
    usage?: { cost?: unknown; raw?: { cost?: unknown } };
    providerMetadata?: { openrouter?: { usage?: { cost?: unknown } } };
  };
  const candidates = [
    r.providerMetadata?.openrouter?.usage?.cost,
    r.usage?.raw?.cost,
    r.usage?.cost,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c;
  }
  return undefined;
}

/** Project a `generateText` result's usage into our SDK-free {@link RawUsage}. */
function extractRawUsage(result: { usage?: { inputTokens?: number; outputTokens?: number } }): RawUsage {
  const inputTokens = Number.isFinite(result.usage?.inputTokens)
    ? (result.usage!.inputTokens as number)
    : 0;
  const outputTokens = Number.isFinite(result.usage?.outputTokens)
    ? (result.usage!.outputTokens as number)
    : 0;
  const cost = readProviderCost(result);
  return { inputTokens, outputTokens, ...(cost !== undefined ? { cost } : {}) };
}

/**
 * Fallback per-call wall-clock ceiling (ms) when a {@link GenerateRequest} doesn't set
 * `timeoutMs` (e.g. a caller that bypasses `aiCall`'s role-aware default). `aiCall` normally
 * supplies an explicit role-aware value (see `call.ts` `DEFAULT_TIMEOUT_MS_BY_ROLE`), so this is
 * a safety net, not the primary tuning knob.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Options for {@link defaultGenerate}. `resolveModel` is injectable for isolated SDK tests. */
export interface DefaultGenerateOptions {
  /** Map a model id → a `LanguageModel`. Real = `provider(id)`; tests inject a mock model. */
  resolveModel: (modelId: string) => LanguageModel;
}

/**
 * Build the real {@link GenerateFn}: wraps `generateText({ output: Output.object({schema}) })`
 * with per-role fallback iteration (try `req.models` in order; on ANY error — incl.
 * `AI_NoOutputGeneratedError` — move to the next model; throw the last error if all fail) and
 * cost/usage extraction. One GenerateFn invocation == one logical model call regardless of how
 * many fallbacks it tries (`aiCall` increments `max_model_calls` once).
 */
export function defaultGenerate(opts: DefaultGenerateOptions): GenerateFn {
  return async (req: GenerateRequest) => {
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let lastErr: unknown;
    for (const modelId of req.models) {
      try {
        // Build the call with EXACTLY one of `messages` / `prompt` (the SDK `Prompt` is a strict
        // XOR — a spread of an optional union widens it and fails typecheck), so branch here.
        // `abortSignal: AbortSignal.timeout(timeoutMs)` bounds EACH attempt so a hung provider
        // call (never throws, never resolves) can't block the fallback loop indefinitely — the
        // 174s L4 iframe hang this guards against. A timeout aborts THIS attempt only; the `catch`
        // below treats it like any other failure and moves to the next model in `req.models`.
        const common = {
          model: opts.resolveModel(modelId),
          output: Output.object({ schema: req.schema }),
          maxOutputTokens: req.maxOutputTokens,
          providerOptions: { openrouter: { usage: { include: true } } },
          abortSignal: AbortSignal.timeout(timeoutMs),
        };
        const result =
          req.messages !== undefined
            ? await generateText({ ...common, messages: req.messages as ModelMessage[] })
            : await generateText({ ...common, prompt: req.prompt ?? "" });
        return { output: result.output, model: modelId, usage: extractRawUsage(result) };
      } catch (err) {
        // Any error (incl. AI_NoOutputGeneratedError from a tight Gemini cap, or a rotated id) is
        // fallback-eligible — try the next model. Throw only after the whole chain is exhausted.
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`No models to try for role ${req.modelRole}`);
  };
}

/**
 * Convenience: build the OpenRouter-backed {@link GenerateFn} from an API key. Round 2 calls this
 * when a key is present, then passes the result to `createAiRuntime({ generate, ... })`.
 */
export function createOpenRouterGenerate(opts: CreateProviderOptions): GenerateFn {
  const provider = createProvider(opts);
  return defaultGenerate({ resolveModel: (id) => provider(id) });
}
