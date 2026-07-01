// Flightplan — the AI runtime factory (PLAN.md §5 Phase 4).
//
// `createAiRuntime(deps)` assembles the registry + budget + cost trackers around the injected
// `GenerateFn` seam and the `ai_call` sink, and exposes everything Round 2 consumes:
//   - `hooks`        → set as `ctx.ai` (the orchestrator's L2/L3/L4 entry points).
//   - `judge`        → set as `assertCtx.aiJudge` (the `ai_judge` oracle).
//   - `usageTotals()`→ folded into `run_end` totals + the run summary (`total_cost_usd`,
//                      `model_usage`).
//   - `budget`       → the runner reads counters + maps `BudgetExceededError` → `inconclusive`.
//
// This factory is SDK-FREE: it takes `generate` as a dep, so tests build a runtime with a fake
// `GenerateFn` (no network, no SDK). The CALLER (Round 2) gates the default runtime on API-key
// presence and supplies `provider.defaultGenerate` for real runs (see `provider.ts`).

import type { AiJudgeAssertion } from "../flow/types.ts";
import type { AiJudgeOptions, AssertionResult } from "../assert/types.ts";
import { BudgetTracker, resolveBudgetLimits } from "./budget.ts";
import { CostAccumulator } from "./cost.ts";
import { resolveRegistry } from "./registry.ts";
import type { AiCallRuntime } from "./call.ts";
import { resolveL2 } from "./resolver-l2.ts";
import { resolveL3 } from "./vision-l3.ts";
import { classifyL4 } from "./advisor-l4.ts";
import { judge as judgeImpl } from "./judge.ts";
import type { AiHooksImpl, AiRuntime, AiRuntimeDeps } from "./types.ts";

/**
 * Assemble an {@link AiRuntime} from deps. The returned `hooks` satisfy the orchestrator's
 * `AiHooks`; `judge` satisfies `assertCtx.aiJudge`; `usageTotals()` returns the run-level rollup.
 */
export function createAiRuntime(deps: AiRuntimeDeps): AiRuntime {
  const registry = resolveRegistry(deps.config);
  const budget = new BudgetTracker(resolveBudgetLimits(deps.config));
  const cost = new CostAccumulator();

  // The slice the tier callers + aiCall consume. The optional redactor (when `enabled`) drives
  // `redactedPrompt`/`redactedResponse` on every `ai_call` event; absent → no prompt/response logged.
  const rt: AiCallRuntime = {
    registry,
    budget,
    cost,
    generate: deps.generate,
    aiWriter: deps.aiWriter,
    ...(deps.redactor ? { redactor: deps.redactor } : {}),
    ...(deps.onAiCall ? { onAiCall: deps.onAiCall } : {}),
  };

  const hooks: AiHooksImpl = {
    resolveL2: (step, prior, ctx) => resolveL2(rt, step, prior, ctx),
    resolveL3: (step, prior, ctx) => resolveL3({ ...rt, budget }, step, prior, ctx),
    classifyL4: (step, prior, ctx) => classifyL4(rt, step, prior, ctx),
  };

  return {
    registry,
    budget,
    cost,
    generate: deps.generate,
    aiWriter: deps.aiWriter,
    hooks,
    judge: (assertion: AiJudgeAssertion, opts: AiJudgeOptions): Promise<AssertionResult> =>
      judgeImpl(rt, assertion, opts),
    usageTotals: () => cost.totals(),
  };
}
