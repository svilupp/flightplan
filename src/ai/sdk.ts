// Flightplan — public AI-SDK barrel (`@svilupp/flightplan/ai-sdk` subpath export).
//
// Re-exports the provider-construction helpers and types from `provider.ts` (the ONLY
// SDK-importing file: `ai`, `@ai-sdk/google`, `@ai-sdk/openai`, `@openrouter/ai-sdk-provider`)
// for consumers that want to build their own `GenerateFn`/`AiRuntime` outside the runner's
// lazy-loaded default path (see `default-generate.ts` and `RunOptions.aiRuntimeFactory`).
//
// Deliberately NOT re-exported from `src/ai/index.ts` (the root-barrel-reachable AI module):
// the worker-portability fitness gate (`src/fitness/worker-portability.test.ts`) conservatively
// follows type-only edges too, so pulling `provider.ts` into that barrel would drag the AI SDKs
// into `runFlow`'s checked graph. This file is a separate, non-walked entry point instead — safe
// for Node-flavored consumers (and the package root `src/index.ts`, which is also not walked).

export type { CreateProviderOptions, DefaultGenerateOptions, ProviderFamily } from "./provider.ts";
export {
  createGoogleGenerate,
  createOpenAiGenerate,
  createOpenRouterGenerate,
  createProvider,
  defaultGenerate,
} from "./provider.ts";
