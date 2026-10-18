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

import type { AiJudgeOptions, AssertionResult } from "../assert/types.ts";
import { jevApiKeyEnvLabel } from "../config/resolve.ts";
import type { AiJudgeAssertion } from "../flow/types.ts";
import type { ModelRoleName } from "../types.ts";
import { classifyL4 } from "./advisor-l4.ts";
import { BudgetTracker, resolveBudgetLimits } from "./budget.ts";
import type { AiCallRuntime } from "./call.ts";
import type { CandidateChooser } from "./chooser.ts";
import { resolveChooserChain } from "./chooser.ts";
import { JevChooser } from "./chooser-jev.ts";
import { resolveJevVision } from "./chooser-jev-vision.ts";
import { LlmChooser } from "./chooser-llm.ts";
import { CostAccumulator } from "./cost.ts";
import { diagnoseJevFailure } from "./jev-diagnosis.ts";
import { compileJevProfile } from "./jev-profile.ts";
import { JevStrategyRuntime, ProfileJevChooser } from "./jev-strategies.ts";
import { judge as judgeImpl } from "./judge.ts";
import {
  gatherPlannerPage,
  planRepairEscalated as planRepairEscalatedImpl,
  planRepair as planRepairImpl,
} from "./planner-l5.ts";
import { resolveRegistry } from "./registry.ts";
import { intentTextForStep } from "./resolve-common.ts";
import { resolveL2 } from "./resolver-l2.ts";
import type { AiHooksImpl, AiRuntime, AiRuntimeDeps, PlannerRuntime } from "./types.ts";
import { resolveBatchL3, resolveL3 } from "./vision-l3.ts";

/**
 * Build the per-role AI-call timeout override from `[timeouts] ai_call_ms` (Fix 2). `ai_call_ms` is a
 * FLAT ceiling applied to EVERY model role, so a single step's L2→L3→L4 escalation can never hang the
 * tens of seconds measured in the field. Returns `undefined` when unset — `aiCall` then falls back to
 * the role-aware `DEFAULT_TIMEOUT_MS_BY_ROLE` (a few seconds each). The value is validated positive by
 * the config schema.
 */
export function timeoutMsByRoleFromConfig(
  timeouts: { ai_call_ms?: number } | undefined,
): Partial<Record<ModelRoleName, number>> | undefined {
  const ms = timeouts?.ai_call_ms;
  if (ms === undefined) return undefined;
  return { resolver: ms, vision: ms, advisor: ms, planner: ms, planner_capable: ms };
}

/**
 * Assemble an {@link AiRuntime} from deps. The returned `hooks` satisfy the orchestrator's
 * `AiHooks`; `judge` satisfies `assertCtx.aiJudge`; `usageTotals()` returns the run-level rollup.
 */
export function createAiRuntime(deps: AiRuntimeDeps): AiRuntime {
  const hasGenerate = !!deps.generate;
  // OPTIONAL: absent for a JEV-only runtime — NEVER a
  // rejecting stub. When present, wraps the injected `deps.generate` with the shared signal
  // combination (unchanged from before this file supported a partial runtime).
  const generate: AiRuntimeDeps["generate"] = deps.generate
    ? async (request) => {
        deps.signal?.throwIfAborted();
        // Combine rather than clobber: a caller-supplied `request.signal` must still be honored
        // alongside the runtime's own `deps.signal` — neither should silently override the other.
        const combinedSignal =
          request.signal && deps.signal
            ? AbortSignal.any([request.signal, deps.signal])
            : (request.signal ?? deps.signal);
        const result = await deps.generate!({
          ...request,
          ...(combinedSignal ? { signal: combinedSignal } : {}),
        });
        // A generation that completed successfully but whose signal fired during the race above is
        // intentionally discarded here: `throwIfAborted` below still throws, and the (unused)
        // result — along with any usage it carried — is never recorded.
        deps.signal?.throwIfAborted();
        return result;
      }
    : undefined;
  const registry = resolveRegistry(deps.config);
  const budget = new BudgetTracker(resolveBudgetLimits(deps.config));
  const cost = new CostAccumulator();
  const profile = compileJevProfile(deps.config);
  if (profile && !deps.jevApiKey)
    throw new Error(`jev_missing_key: set ${jevApiKeyEnvLabel(deps.config.ai?.jev_api_key_env)}`);
  const jev = profile ? new JevStrategyRuntime(deps, profile, budget, cost) : undefined;
  const profileChooser = jev ? new ProfileJevChooser(jev) : undefined;

  // The slice the tier callers + aiCall consume. The optional redactor (when `enabled`) drives
  // `redactedPrompt`/`redactedResponse` on every `ai_call` event; absent → no prompt/response logged.
  // Per-AI-call timeout ceiling (Fix 2): `[timeouts] ai_call_ms` flattened across all roles so the
  // repair/L4 escalation path actually USES a bounded timeout. Unset → role-aware defaults in `aiCall`.
  const timeoutMsByRole = timeoutMsByRoleFromConfig(deps.config.timeouts);
  // `AiCallRuntime.generate` STAYS REQUIRED (aiCall's contract) — this slice is only ever handed to
  // `aiCall`-based tiers (LLM chooser / L3 / L4 / judge / planner), all gated on `hasGenerate` below.
  const rt: AiCallRuntime | undefined = generate
    ? {
        registry,
        budget,
        cost,
        generate,
        aiWriter: deps.aiWriter,
        ...(deps.redactor ? { redactor: deps.redactor } : {}),
        ...(deps.onAiCall ? { onAiCall: deps.onAiCall } : {}),
        ...(timeoutMsByRole ? { timeoutMsByRole } : {}),
      }
    : undefined;

  // The chooser chain: test seam `deps.choosers` bypasses `resolveChooserChain` entirely; otherwise
  // build it from the resolved config + key availability. `jevAvailable`/`llmAvailable` are the
  // env/generate-presence booleans `resolveChooserChain` consumes.
  const classifier = deps.config.ai?.classifier ?? "auto";
  const jevKeyEnv = jevApiKeyEnvLabel(deps.config.ai?.jev_api_key_env);
  const jevAvailable = !!deps.jevApiKey;
  const choosers: CandidateChooser[] =
    deps.choosers ??
    resolveChooserChain({
      classifier,
      jevAvailable,
      jevKeyEnv,
      llmAvailable: !!rt,
      makeJev: () =>
        profileChooser && profile?.profile !== "shadow"
          ? profileChooser
          : new JevChooser({
              budget,
              cost,
              aiWriter: deps.aiWriter,
              ...(deps.onAiCall ? { onAiCall: deps.onAiCall } : {}),
              ...(deps.redactor ? { redactor: deps.redactor } : {}),
              ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
              ...(deps.signal ? { signal: deps.signal } : {}),
              apiKey: deps.jevApiKey ?? "",
            }),
      makeLlm: () => new LlmChooser(rt!),
    });

  const hooks: AiHooksImpl = {
    resolveL2: (step, prior, ctx) => {
      jev?.begin(step.id);
      return resolveL2(
        choosers,
        step,
        prior,
        ctx,
        profile?.profile === "shadow" ? profileChooser : undefined,
        deps.signal,
        !!profile && profile.profile !== "shadow",
      );
    },
  };
  if (rt) {
    hooks.resolveL3 = (step, prior, ctx) => resolveL3({ ...rt, budget }, step, prior, ctx);
    hooks.classifyL4 = async (step, prior, ctx) => {
      let hint = "unknown";
      if (
        jev &&
        profile?.profile !== "shadow" &&
        (budget.limits.max_model_calls === undefined ||
          budget.modelCalls + 2 <= budget.limits.max_model_calls) &&
        budget.limits.max_cost_usd === undefined
      ) {
        try {
          jev.begin(step.id);
          const snapshot = await ctx.driver.snapshot();
          hint = await diagnoseJevFailure(jev, step.id, {
            failure: prior.failureReason ?? prior.error ?? "unknown",
            expected: intentTextForStep(step),
            snapshot: JSON.stringify(snapshot.accessibilityTree),
          });
        } catch {
          /* optional advice cannot replace the existing L4 contract */
        }
      }
      return classifyL4(
        rt,
        step,
        hint === "unknown"
          ? prior
          : {
              ...prior,
              error: `${prior.error ?? ""}\nNon-authoritative local diagnosis: ${hint}. Existing deterministic probes and effect policy remain authoritative.`,
            },
        ctx,
      );
    };
    // Vision batching (PLAN_v003 §4 v003-3): the runner injects this as `BatchVisionResolve`. The
    // callback OWNS the ONE-screenshot/ONE-call resolve + per-target fallback (see `resolveBatchL3`).
    hooks.resolveBatchL3 = (steps, ctx) => resolveBatchL3({ ...rt, budget }, steps, ctx);
  }

  if (jev && profile?.profile === "visual") {
    hooks.resolveL3 = (step, prior, ctx) => resolveJevVision(jev, step, prior, ctx);
    // Each action may invalidate the previous frame. Keep mapping and budgets explicit;
    // shared-frame optimization awaits geometry fixture evidence.
    hooks.resolveBatchL3 = async (steps, ctx) => {
      const results = [];
      const shared = {};
      for (const step of steps)
        results.push(
          await resolveJevVision(
            jev,
            step,
            { ok: false, tier: "L2", candidates: [], escalate: true },
            ctx,
            shared,
          ),
        );
      return results;
    };
  }

  // The L5 path-repair planner (PLAN_v003 v003-6), bound to the runtime slice. Present only when
  // `rt` exists (`hasGenerate`); the runner additionally gates its USE on `[plan].enabled` + a real
  // divergence — a deterministic (no-AI-runtime) run never reaches it. `planRepairEscalated` is the
  // ESCALATION-ONLY capable arm (never called standing).
  const planner: PlannerRuntime | undefined = rt
    ? {
        gatherPlannerPage: (divergedStep, ctx, recent) =>
          gatherPlannerPage(divergedStep, ctx, recent),
        planRepair: (goal, opts) => planRepairImpl(rt, goal, opts),
        planRepairEscalated: (goal, opts) => planRepairEscalatedImpl(rt, goal, opts),
      }
    : undefined;

  return {
    ...(jev ? { jevRequests: jev.requests } : {}),
    registry,
    budget,
    cost,
    ...(generate ? { generate } : {}),
    hasGenerate,
    aiWriter: deps.aiWriter,
    hooks,
    ...(rt || jev
      ? {
          judge: (assertion: AiJudgeAssertion, opts: AiJudgeOptions): Promise<AssertionResult> =>
            assertion.backend === "jev"
              ? jev
                ? jev.judge(assertion, opts)
                : Promise.resolve({
                    type: "ai_judge",
                    pass: false,
                    durationMs: 0,
                    when: opts.when ?? "after",
                    message: "jev_missing_runtime",
                  })
              : rt
                ? judgeImpl(rt, assertion, opts)
                : Promise.resolve({
                    type: "ai_judge",
                    pass: false,
                    durationMs: 0,
                    when: opts.when ?? "after",
                    message: "ai_judge: default backend unavailable",
                  }),
        }
      : {}),
    ...(planner ? { planner } : {}),
    usageTotals: () => cost.totals(),
  };
}
