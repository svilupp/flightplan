// Flightplan — the ONLY file that imports the AI SDK (`ai`), `@openrouter/ai-sdk-provider`,
// `@ai-sdk/google`, and `@ai-sdk/openai`. It supplies the REAL `GenerateFn` (`defaultGenerate`) so
// the rest of `ai/` and ALL tests stay SDK-free behind the `GenerateFn` seam.
//
// Chosen transport (FINDINGS_ai_integration §3, decision 2026-06-29): vision + text BOTH run on
// the one OpenRouter provider on `ai@6` by default. The Output API is `generateText({ output:
// Output.object({schema}) }) → result.output` (NOT `experimental_output`; FINDINGS §2 / spike 11).
// Vision attaches the screenshot as a `file` part with a `data:` URL, and Gemini thinking tokens
// count against the output-token cap (FINDINGS §3 / spike 12/17). `[ai].provider` also selects
// `google` (`@ai-sdk/google`) or `openai` (`@ai-sdk/openai`) as native alternatives — same
// `defaultGenerate` call shape, a different `resolveModel`/`providerOptions` mapping (below).
//
// Reasoning-effort suffix (`"openai/gpt-5.6-luna:xhigh"`, `"google/gemini-3-pro:high"`): a model id
// in a `GenerateRequest.models` entry may carry a trailing `:effort` (one of `minimal|low|medium|
// high|xhigh` — see `registry.ts`'s `parseModelId`). `defaultGenerate` parses it off EVERY model id
// as it walks the fallback chain, strips it before handing the slug to the SDK provider, and merges
// the effort into `providerOptions` per family:
//   - openrouter: `reasoning: { effort }` (OpenRouter's own reasoning-tokens knob — accepts our
//     exact vocabulary incl. `xhigh`).
//   - openai:     `reasoningEffort: effort` (the native option accepts our exact vocabulary too).
//   - google:     `thinkingConfig.thinkingLevel` — the native option only accepts
//     `minimal|low|medium|high` (no `xhigh`), so `xhigh` maps down to `"high"` (documented
//     lossy mapping; there is no higher native level to map to).

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel, ModelMessage } from "ai";
import { generateText, Output } from "ai";
import type { ReasoningEffort } from "./registry.ts";
import { parseModelId } from "./registry.ts";
import type { GenerateFn, GenerateRequest, RawUsage } from "./types.ts";

/** Which native SDK family a {@link DefaultGenerateOptions.resolveModel} is backed by — selects the
 * `providerOptions` shape {@link defaultGenerate} merges in for a reasoning-effort suffix. */
export type ProviderFamily = "openrouter" | "google" | "openai";

/** Google's `thinkingConfig.thinkingLevel` has no `xhigh` — map it down to `"high"` (see header). */
function googleThinkingLevel(effort: ReasoningEffort): "minimal" | "low" | "medium" | "high" {
  return effort === "xhigh" ? "high" : effort;
}

/** Build the family-specific `providerOptions` slice for a parsed reasoning effort, if any. */
function effortProviderOptions(
  family: ProviderFamily,
  effort: ReasoningEffort | undefined,
): Record<string, unknown> {
  if (!effort) return {};
  switch (family) {
    case "openrouter":
      return { openrouter: { reasoning: { effort } } };
    case "openai":
      return { openai: { reasoningEffort: effort } };
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: googleThinkingLevel(effort) } } };
    default:
      return {};
  }
}

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
function extractRawUsage(result: {
  usage?: { inputTokens?: number; outputTokens?: number };
}): RawUsage {
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
  /** Map a (suffix-stripped) model id → a `LanguageModel`. Real = `provider(id)`; tests inject a
   * mock model. */
  resolveModel: (modelId: string) => LanguageModel;
  /** Which native SDK family `resolveModel` is backed by (default `"openrouter"`) — selects the
   * `providerOptions` shape for a `:effort`-suffixed model id (see the file header). */
  family?: ProviderFamily;
}

/**
 * Build the SDK message list for a prompt-cached text call (PLAN_v003 v003-6). The STABLE PREFIX
 * (goal + planner instructions) becomes its own text part carrying an OpenRouter/Anthropic-style
 * `cacheControl: { type: 'ephemeral' }` breakpoint, so the provider caches it and REUSES it across
 * replans in a run (uncached measured 3.85× the cost). The VOLATILE remainder (`prompt` — the
 * current page) follows as a normal, uncached text part.
 *
 * The `cache.key` (the flow goal) is deliberately NOT sent to the provider: OpenRouter/Anthropic key
 * their cache off the exact cached CONTENT (the prefix bytes), so a stable prefix ⇒ a cache hit and
 * a changed goal ⇒ different prefix bytes ⇒ automatic invalidation — page nav (which only changes the
 * uncached suffix) never invalidates it. The key rides along on `GenerateRequest.cache` purely for
 * the caller's own byte-stability assertions. This SDK-specific shaping stays inside `provider.ts`.
 */
function cachedPromptMessages(prompt: string, prefix: string): ModelMessage[] {
  const cacheControl = { type: "ephemeral" as const };
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: prefix,
          providerOptions: { openrouter: { cacheControl }, anthropic: { cacheControl } },
        },
        { type: "text", text: prompt },
      ],
    },
  ];
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
    // ONE shared deadline across the WHOLE fallback chain (Fix 2): a single LOGICAL model call —
    // however many fallbacks it walks — is bounded by `timeoutMs`, so a chain of hung/slow models can
    // NOT accumulate `num_models × timeoutMs` seconds (the measured ~24s L2-resolver stall walking 4
    // hung DeepSeek fallbacks at 6s each). A fallback still gets a fair shot from whatever budget
    // remains; once the deadline fires the remaining attempts reject instantly and the loop exits.
    // A fail-FAST model (throws immediately, e.g. a rotated id) still falls through to the next model
    // within budget — the shared signal only bites a genuinely SLOW/HUNG chain.
    const abortSignal = AbortSignal.timeout(timeoutMs);
    const family = opts.family ?? "openrouter";
    let lastErr: unknown;
    for (const rawModelId of req.models) {
      const { model: modelId, effort } = parseModelId(rawModelId);
      try {
        // Build the call with EXACTLY one of `messages` / `prompt` (the SDK `Prompt` is a strict
        // XOR — a spread of an optional union widens it and fails typecheck), so branch here.
        // The shared `abortSignal` bounds the whole logical call so a hung provider call (never
        // throws, never resolves) can't block indefinitely — the 174s L4 iframe hang this guards
        // against. A fired timeout aborts the in-flight attempt; the `catch` below treats it like any
        // other failure and moves to the next model (which then rejects at once on the same signal).
        const effortOptions = effortProviderOptions(family, effort);
        const openrouterOptions =
          family === "openrouter"
            ? {
                usage: { include: true },
                ...(effortOptions.openrouter as Record<string, unknown> | undefined),
              }
            : undefined;
        const common = {
          model: opts.resolveModel(modelId),
          output: Output.object({ schema: req.schema }),
          maxOutputTokens: req.maxOutputTokens,
          providerOptions: {
            ...effortOptions,
            ...(openrouterOptions !== undefined ? { openrouter: openrouterOptions } : {}),
          },
          abortSignal,
        };
        // Three shapes, all a strict XOR in the SDK `Prompt`:
        //   1. multimodal `messages` (vision tiers) — passed through as-is;
        //   2. a prompt-cached text call (PLAN_v003 v003-6) — the stable prefix is marked cacheable
        //      via a two-part user message (`cachedPromptMessages`);
        //   3. a plain text `prompt` (resolver/advisor/uncached planner).
        let result: Awaited<ReturnType<typeof generateText>>;
        if (req.messages !== undefined) {
          result = await generateText({ ...common, messages: req.messages });
        } else if (req.cache !== undefined) {
          result = await generateText({
            ...common,
            messages: cachedPromptMessages(req.prompt ?? "", req.cache.prefix),
          });
        } else {
          result = await generateText({ ...common, prompt: req.prompt ?? "" });
        }
        return { output: result.output, model: rawModelId, usage: extractRawUsage(result) };
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
  return defaultGenerate({ resolveModel: (id) => provider(id), family: "openrouter" });
}

/**
 * Convenience: build the Google (`@ai-sdk/google`) native-backed {@link GenerateFn} from an API
 * key (`GOOGLE_GENERATIVE_AI_API_KEY` by convention — see `config/resolve.ts`). Model ids in the
 * registry/config are Google's OWN model ids (e.g. `gemini-3-pro`), not OpenRouter slugs, when this
 * provider is selected.
 */
export function createGoogleGenerate(opts: CreateProviderOptions): GenerateFn {
  const provider = createGoogleGenerativeAI({ apiKey: opts.apiKey });
  return defaultGenerate({ resolveModel: (id) => provider(id), family: "google" });
}

/**
 * Convenience: build the OpenAI (`@ai-sdk/openai`) native-backed {@link GenerateFn} from an API
 * key (`OPENAI_API_KEY` by convention — see `config/resolve.ts`). Model ids in the registry/config
 * are OpenAI's OWN model ids (e.g. `gpt-5.6-luna`), not OpenRouter slugs, when this provider is
 * selected.
 */
export function createOpenAiGenerate(opts: CreateProviderOptions): GenerateFn {
  const provider = createOpenAI({ apiKey: opts.apiKey });
  return defaultGenerate({ resolveModel: (id) => provider(id), family: "openai" });
}
