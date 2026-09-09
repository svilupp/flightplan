// Flightplan — the default-generate loader for the runner's AI runtime.
//
// This file statically imports `provider.ts` (the ONLY SDK-importing file: `ai`,
// `@ai-sdk/google`, `@ai-sdk/openai`, `@openrouter/ai-sdk-provider`) — fine, because this
// module is itself never statically imported by the run path. `runner.ts` reaches it only
// through a cached computed-specifier dynamic import, so `runFlow`'s static graph never pulls
// in the AI SDKs (they are edge/Node wiring, not worker-portable by default). Worker hosts that
// want AI inject `RunOptions.aiRuntimeFactory` instead (the documented seam).

export {
  createGoogleGenerate,
  createOpenAiGenerate,
  createOpenRouterGenerate,
} from "./provider.ts";
