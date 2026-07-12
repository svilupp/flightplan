// Flightplan — ladder module barrel.
//
// The L0–L4 resolver + the orchestrator that walks the cost ladder per step (PLAN.md §2 module
// map / §5 Phase 2). Phase 2 ships L0 (cache-replay STUB) and L1 (deterministic strategy ladder)
// plus the orchestration scaffold where L2/L3/L4 (the AI tiers, Phase 4) plug in via `ctx.ai`.
//
// Exports are NAMED (not `export *`) to control the public surface and avoid collisions under
// `src/index.ts`'s `export *` (no collision found with the existing surface — `RankedCandidate`,
// `Resolution`, `StepExecution` etc. are unique to the ladder).

// --- the resolution/execution contract (types.ts) ---
export type {
  AiHooks,
  BatchActionVerb,
  CachedRecipe,
  L2Handoff,
  Ladder,
  LadderResult,
  LockHook,
  PortfolioExecOutcome,
  PortfolioVerdict,
  RankedCandidate,
  Resolution,
  ResolutionAttempt,
  ResolveContext,
  ResolvedTarget,
  SingleStepBatch,
  StepExecution,
  StrategyCandidate,
} from "./types.ts";

// NOTE: `LadderTier` / `LADDER_TIERS` are intentionally NOT re-exported here — they are owned by
// `artifacts/` (the cross-agent trace contract) and already reach the root via its `export *`.
// Re-exporting them from the ladder too would collide under `src/index.ts`'s `export *`.

export {
  type DispatchPolicy,
  type DispatchResult,
  dispatchResolved,
  mayHaveDispatched,
} from "./dispatch.ts";
// --- L1 building blocks (role guard + ambiguity + handoff policy; strategy-array construction) ---
export {
  buildHandoff,
  INTERACTIVE_ROLES,
  isAmbiguous,
  isInTopCluster,
  isInteractiveRole,
} from "./fuzzy.ts";
// --- the tier resolvers ---
export { resolveL0 } from "./l0.ts";
export { actionVerbForStep, type L1Options, resolveL1 } from "./l1.ts";
// --- the orchestrator (resolveStep / createLadder) + vision batching (v003-3) ---
export {
  type BatchVisionResolve,
  createLadder,
  type OrchestratorOptions,
  resolveStep,
  resolveVisionBatch,
} from "./orchestrator.ts";
// --- auto-repair (Unit D — Phase 5: covered/disabled/missing pre-model recovery) ---
export {
  attemptRepair,
  mapFailureReason,
  type RepairKind,
  type RepairOptions,
  type RepairResult,
} from "./repair.ts";
// --- the portfolio race (DESIGN §3.2) + its Layer-3 revalidation adapter ---
export {
  type PortfolioRaceResult,
  parseDurableSelector,
  type RevalidateResult,
  racePortfolio,
  revalidateCachedTarget,
  type StrategyVerdict,
} from "./revalidate.ts";
export {
  buildHintCandidates,
  buildStrategyArray,
  durableSelectorForElement,
  labelSelectorForElement,
  roleNameSelectorForElement,
  scopedTextSelectorForElement,
  strategyForElement,
  structuralFingerprintForElement,
  testidSelectorForElement,
} from "./strategy-array.ts";
