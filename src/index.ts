// Flightplan — library entrypoint.
// Re-exports the public surface for programmatic use and tests. Modules are filled in
// across Phases 1–5 (see PLAN.md §5); the re-exports below activate as each lands.

export { memoryFileSystem } from "./adapters/memory.ts";
export { nodeFileSystem } from "./adapters/node/index.ts";
export * from "./ai/index.ts";
export type { CreateProviderOptions, DefaultGenerateOptions, ProviderFamily } from "./ai/sdk.ts";
// Node-flavored: `src/index.ts` is not one of the worker-portability fitness gate's walked
// entries (see src/fitness/worker-portability.test.ts), so it may reference provider.ts's
// SDK-importing helpers directly. Also available via the `./ai-sdk` subpath export.
export {
  createGoogleGenerate,
  createOpenAiGenerate,
  createOpenRouterGenerate,
  createProvider,
  defaultGenerate,
} from "./ai/sdk.ts";
export * from "./artifacts/index.ts";
export * from "./assert/index.ts";
export * from "./config/index.ts";
export * from "./driver/index.ts";
export * from "./flow/index.ts";
export * from "./ladder/index.ts";
export * from "./lint/index.ts";
export * from "./lock/index.ts";
export * from "./redaction/index.ts";
export * from "./runner/index.ts";
export type { FileSystemPort } from "./runtime.ts";
export { CapabilityError } from "./runtime.ts";
export * from "./telemetry/index.ts";
export * from "./types.ts";
