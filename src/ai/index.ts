// Flightplan — AI module barrel (PLAN.md §2 module map / §5 Phase 4).
//
// AI SDK v6 integration: the config-driven model registry, the OpenRouter text+vision transport
// (isolated in `provider.ts` — the ONLY SDK-importing file), Output schemas, budgets, cost
// tracking, the L2/L3/L4 tiers, the `ai_judge` oracle, and the runtime factory Round 2 consumes.
//
// NAMED exports throughout (mirrors `src/lock/index.ts`) to control the public surface and avoid
// `export *` collisions under `src/index.ts`. Notably the AI `AdvisoryVerdict` TYPE is owned by
// `src/types.ts` (already on the root surface) and is NOT re-exported here.

// --- core types (the GenerateFn seam + runtime contracts) ---
export type {
  AiCallContext,
  AiCallResult,
  AiCallSink,
  AiContentPart,
  AiHooksImpl,
  AiMessage,
  AiRuntime,
  AiRuntimeDeps,
  AiUserMessage,
  GenerateFn,
  GenerateRequest,
  GenerateResult,
  RawUsage,
} from "./types.ts";

// --- Output schemas + their inferred types ---
export {
  AdvisorVerdictSchema,
  JudgeSchema,
  ResolverDecisionSchema,
} from "./schemas.ts";
export type { JudgeVerdict, ResolverDecision } from "./schemas.ts";

// --- model registry ---
export {
  DEFAULT_MODEL_REGISTRY,
  modelChain,
  resolveRegistry,
  roleModel,
} from "./registry.ts";
export type { ResolvedModelRole, ResolvedRegistry } from "./registry.ts";

// --- cost ---
export { CostAccumulator, extractUsageCost } from "./cost.ts";
export type { UsageCost } from "./cost.ts";

// --- budgets ---
export {
  BudgetExceededError,
  BudgetTracker,
  isBudgetExceeded,
  resolveBudgetLimits,
} from "./budget.ts";
export type { BudgetLimitName, BudgetLimits } from "./budget.ts";

// --- the single model-call choke point ---
export { aiCall } from "./call.ts";
export type { AiCallRuntime } from "./call.ts";

// --- the tiers (L2/L3/L4) + the ai_judge oracle ---
export { AI_MIN_OUTPUT_TOKENS, buildResolverPrompt, L2_MIN_CONFIDENCE, resolveL2 } from "./resolver-l2.ts";
export { buildVisionPrompt, resolveL3 } from "./vision-l3.ts";
export type { VisionRuntime } from "./vision-l3.ts";
export { buildAdvisorPrompt, classifyL4, summarizeVerdict } from "./advisor-l4.ts";
export { judge } from "./judge.ts";

// --- the runtime factory (Round 2's entry point) ---
export { createAiRuntime } from "./runtime.ts";

// --- the OpenRouter transport (the ONLY SDK-backed surface) ---
export {
  createOpenRouterGenerate,
  createProvider,
  defaultGenerate,
} from "./provider.ts";
export type { CreateProviderOptions, DefaultGenerateOptions } from "./provider.ts";
