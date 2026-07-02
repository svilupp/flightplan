// Flightplan — AI module barrel (PLAN.md §2 module map / §5 Phase 4).
//
// AI SDK v6 integration: the config-driven model registry, the OpenRouter text+vision transport
// (isolated in `provider.ts` — the ONLY SDK-importing file), Output schemas, budgets, cost
// tracking, the L2/L3/L4 tiers, the `ai_judge` oracle, and the runtime factory Round 2 consumes.
//
// NAMED exports throughout (mirrors `src/lock/index.ts`) to control the public surface and avoid
// `export *` collisions under `src/index.ts`. Notably the AI `AdvisoryVerdict` TYPE is owned by
// `src/types.ts` (already on the root surface) and is NOT re-exported here.

export { buildAdvisorPrompt, classifyL4, summarizeVerdict } from "./advisor-l4.ts";
export type { BudgetLimitName, BudgetLimits } from "./budget.ts";
// --- budgets ---
export {
  BudgetExceededError,
  BudgetTracker,
  isBudgetExceeded,
  resolveBudgetLimits,
} from "./budget.ts";
export type { AiCallRuntime } from "./call.ts";
// --- the single model-call choke point ---
export { aiCall } from "./call.ts";
export type { UsageCost } from "./cost.ts";
// --- cost ---
export { CostAccumulator, extractUsageCost } from "./cost.ts";
export { judge } from "./judge.ts";
// --- L5 path-repair planner (PLAN_v003 v003-6; cheap-first, capable arm UNPROVEN) ---
export type {
  PlannerPageContext,
  PlanRepairOpts,
  PlanRepairResult,
  RecentAction,
} from "./planner-l5.ts";
export {
  buildPlannerPrefix,
  buildPlannerPrompt,
  buildPlannerSuffix,
  gatherPlannerPage,
  PLANNER_ESCALATE_ATTEMPTS,
  PLANNER_ESCALATE_CONFIDENCE,
  PLANNER_MAX_ATTEMPTS_PER_DIVERGENCE,
  pickDuelWinner,
  planRepair,
  planRepairEscalated,
  shouldEscalate,
} from "./planner-l5.ts";
export type { CreateProviderOptions, DefaultGenerateOptions } from "./provider.ts";
// --- the OpenRouter transport (the ONLY SDK-backed surface) ---
export {
  createOpenRouterGenerate,
  createProvider,
  defaultGenerate,
} from "./provider.ts";
export type { ResolvedModelRole, ResolvedRegistry } from "./registry.ts";
// --- model registry ---
export {
  DEFAULT_MODEL_REGISTRY,
  modelChain,
  resolveRegistry,
  roleModel,
} from "./registry.ts";
// --- the tiers (L2/L3/L4) + the ai_judge oracle ---
export {
  AI_MIN_OUTPUT_TOKENS,
  buildResolverPrompt,
  L2_MIN_CONFIDENCE,
  resolveL2,
} from "./resolver-l2.ts";
// --- the runtime factory (Round 2's entry point) ---
export { createAiRuntime } from "./runtime.ts";
export type { JudgeVerdict, PlannerPlan, PlannerStep, ResolverDecision } from "./schemas.ts";
// --- Output schemas + their inferred types ---
export {
  AdvisorVerdictSchema,
  JudgeSchema,
  PLANNER_MAX_STEPS,
  PLANNER_STEP_DOS,
  PlannerPlanSchema,
  ResolverDecisionSchema,
} from "./schemas.ts";
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
  PlannerRuntime,
  RawUsage,
} from "./types.ts";
export type { BatchVisionOutput, VisionRuntime } from "./vision-l3.ts";
export {
  BatchVisionSchema,
  buildBatchVisionPrompt,
  buildVisionPrompt,
  resolveBatchL3,
  resolveL3,
} from "./vision-l3.ts";
