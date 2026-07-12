// Flightplan — AI-internal types (the SDK-free contracts for the `ai/` module).
//
// EVERYTHING in `ai/` except `provider.ts` is SDK-free: no `ai`, no `@openrouter/ai-sdk-provider`,
// no `@ai-sdk/google`. The seam that keeps it that way is `GenerateFn` (below): `provider.ts`
// supplies the real OpenRouter-backed implementation; tests supply a fake returning canned
// `{ output, usage }`. So the tier files (resolver/vision/advisor/judge), the runtime, the budget
// and cost trackers, and ALL tests run with no network and no SDK.
//
// Canonical references: PLAN.md §5 Phase 4, §8 risk #4/#5; FINDINGS_ai_integration §2/§3;
// PROPOSAL_v1.md "Advisory verdict (typed)" / "AI judge".

import type { z } from "zod";
import type { AiCallEvent, AiCallRole, ModelUsage } from "../artifacts/events.ts";
import type { AiJudgeOptions, AssertionResult } from "../assert/types.ts";
import type { Config } from "../config/types.ts";
import type { AiJudgeAssertion, Step } from "../flow/types.ts";
import type { ResolveContext, StepExecution } from "../ladder/types.ts";
import type { Redactor } from "../redaction/index.ts";
import type { ModelRoleName } from "../types.ts";
import type { ResolvedModelRole } from "./registry.ts";

// ---------------------------------------------------------------------------
// SDK-free message shape (mapped to the AI SDK's shape inside provider.ts)
// ---------------------------------------------------------------------------

/** A content part of a multimodal user message. `file` carries a base64 `data:` URL. */
export type AiContentPart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; data: string };

/** A user message (the only role the tiers send). Mapped to the SDK `ModelMessage` in provider.ts. */
export interface AiUserMessage {
  role: "user";
  content: AiContentPart[];
}

export type AiMessage = AiUserMessage;

// ---------------------------------------------------------------------------
// The GenerateFn seam (the load-bearing test boundary)
// ---------------------------------------------------------------------------

/**
 * One model-call request handed to a {@link GenerateFn}. The function tries `models` in order
 * (primary then fallbacks) and returns the first that produces a validated output. Exactly ONE
 * of `prompt` / `messages` is set (text vs vision).
 */
export interface GenerateRequest {
  /** The model ROLE (resolver/advisor/vision) → selects pricing + cost attribution. */
  modelRole: ModelRoleName;
  /** The ordered model ids to try (primary first, then fallbacks). */
  models: string[];
  /** The zod Output schema the validated value must satisfy. */
  schema: z.ZodType;
  /** Output-token cap. Always ≥512 (Gemini thinking-token caveat — FINDINGS §3). */
  maxOutputTokens: number;
  /** Text prompt (text tiers). */
  prompt?: string;
  /** Multimodal message list (vision tiers). */
  messages?: AiMessage[];
  /**
   * Wall-clock ceiling (ms) for the WHOLE logical model call — ONE shared `AbortSignal.timeout` spans
   * the entire fallback chain (Fix 2), so walking N fallbacks can't accumulate `N × timeoutMs` (the
   * measured ~24s L2-resolver stall over 4 hung fallbacks). `defaultGenerate` threads it into the
   * shared `abortSignal` so a hung provider call (e.g. the 174s L4 iframe hang) is bounded and — if it
   * fails fast rather than hanging — the next model is still tried within the remaining budget.
   * `aiCall` supplies a role-aware default; callers may omit it, in which case `defaultGenerate` falls
   * back to `DEFAULT_TIMEOUT_MS`.
   */
  timeoutMs?: number;
  /**
   * OPTIONAL prompt-cache marker (PLAN_v003 v003-6, MANDATORY for the incremental replan loop —
   * uncached measured 3.85× the cost). When set, the caller has built the prompt as a STABLE PREFIX
   * (the cacheable part — the planner goal + instructions) followed by a volatile suffix (the
   * current page). `prefix` is the byte-stable text the provider should mark cacheable;
   * `key` is the cache identity (the flow goal), so the cached prefix is REUSED across replans in a
   * run and INVALIDATED on a goal change, NOT on page nav (PLAN_v003 §7 leaning). The provider
   * (`provider.ts`) owns the SDK-specific cache-control breakpoint; every other file stays SDK-free.
   */
  cache?: { prefix: string; key: string };
}

/** Token usage (and optional provider-reported cost) from one model call. */
export interface RawUsage {
  inputTokens: number;
  outputTokens: number;
  /** OpenRouter-reported cost in USD, when available (otherwise compute from pricing). */
  cost?: number;
}

/** The result of a {@link GenerateFn} call: the validated (unknown-typed) output + which model won. */
export interface GenerateResult {
  /** The validated output (the GenerateFn already parsed it; `aiCall` re-parses for typing). */
  output: unknown;
  /** The model id that actually produced the output (may be a fallback). */
  model: string;
  usage: RawUsage;
}

/**
 * THE injection seam. `provider.ts` supplies the real OpenRouter-backed implementation
 * (`generateText({ output: Output.object({schema}) })` with per-role fallback iteration);
 * tests supply a fake returning canned `{ output, model, usage }`. One logical tier call invokes
 * this exactly once — fallback retries happen INSIDE the implementation and do NOT re-increment
 * the `max_model_calls` budget (that is incremented once by `aiCall`).
 */
export type GenerateFn = (req: GenerateRequest) => Promise<GenerateResult>;

// ---------------------------------------------------------------------------
// The writer sink (structural — both `AiWriter` and a test fake satisfy it)
// ---------------------------------------------------------------------------

/** The single `ai_call`-emitting method `aiCall` needs. `artifacts/AiWriter` satisfies it. */
export interface AiCallSink {
  emitAiCall(payload: Omit<AiCallEvent, "ts" | "type">): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Tier decision/verdict types (the validated outputs, re-exported from schemas)
// ---------------------------------------------------------------------------

export type { AdvisoryVerdict } from "../types.ts";
export type { JudgeVerdict, ResolverDecision } from "./schemas.ts";

// ---------------------------------------------------------------------------
// AiCallContext — the per-call inputs `aiCall` consumes
// ---------------------------------------------------------------------------

/**
 * Passed to an {@link AiCallContext.fallback} when a model call cannot produce a schema-conforming
 * value. `outcome` is the classified failure label the `ai_call` event records (`no_output` /
 * `timeout` / `unparseable` / `error`); `error` is the underlying thrown value (for logging).
 */
export interface AiCallFailure {
  error: unknown;
  outcome: string;
}

/**
 * One logical AI call. `modelRole` selects the registry entry (model list + pricing); `callRole`
 * is the wider {@link AiCallRole} stamped on the `ai_call` event (a `judge` routes to a text or
 * vision MODEL but is logged as `judge`). `deriveOutcome` lets the advisor stamp
 * `outcome`/`advisoryVerdict` from the validated output.
 */
export interface AiCallContext<S extends z.ZodType = z.ZodType> {
  modelRole: ModelRoleName;
  callRole?: AiCallRole;
  /** What the call was for, e.g. `resolve:step-1` / `judge:step-3`. */
  purpose: string;
  schema: S;
  maxOutputTokens: number;
  prompt?: string;
  messages?: AiMessage[];
  /**
   * OPTIONAL prompt-cache marker (PLAN_v003 v003-6). Threaded verbatim into
   * {@link GenerateRequest.cache} so the provider marks the stable prefix cacheable. See the field
   * doc on `GenerateRequest.cache`.
   */
  cache?: { prefix: string; key: string };
  /** Map the validated output → the `ai_call` event's `outcome` + optional `advisoryVerdict`. */
  deriveOutcome?: (output: z.infer<S>) => {
    outcome?: string;
    advisoryVerdict?: AiCallEvent["advisoryVerdict"];
  };
  /**
   * OPTIONAL graceful-degradation hook (robustness — a malformed model response must never abort a
   * run). When set, a generation/parse failure that is NOT a budget error (the "No object
   * generated: could not parse the response" class from the AI SDK, or a local schema-validation
   * failure) does NOT throw out of {@link aiCall}: the failure is still recorded (an `ai_call`
   * event with the classified failure `outcome`), and `aiCall` returns this typed fallback value as
   * `output` with `degraded: true`. Terminal, NON-acting callers (the L4 advisor, `ai_judge`) supply
   * a SAFE default so the run continues; callers that WANT a model failure to escalate (the L2
   * resolver / L3 vision) simply omit this and keep the throw contract. Budget errors ALWAYS
   * propagate regardless of this hook.
   */
  fallback?: (failure: AiCallFailure) => z.infer<S>;
}

/** The validated, typed result of an {@link AiCallContext}. */
export interface AiCallResult<T> {
  output: T;
  /** The model id that produced the output. */
  model: string;
  /** The budget-authoritative cost (pricing-derived unless the provider reported one). */
  cost_usd: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * True when `output` came from {@link AiCallContext.fallback} because the model call could not
   * produce a schema-conforming value (a graceful, non-throwing degradation). Absent/false on a
   * normal successful call, so existing callers that ignore it are unaffected.
   */
  degraded?: boolean;
  /** When {@link degraded}, the classified failure label (matches the recorded `ai_call.outcome`). */
  failureOutcome?: string;
}

// ---------------------------------------------------------------------------
// AiRuntime — the assembled handle Round 2 consumes
// ---------------------------------------------------------------------------

/** Deps to build an {@link AiRuntime}. `generate` is the seam; the rest is config/wiring. */
export interface AiRuntimeDeps {
  /**
   * The resolved config: `[ai]`/`[run]` budgets + `[ai.models]` overrides, plus `[timeouts]` for the
   * per-AI-call ceiling (`ai_call_ms` → `AiCallRuntime.timeoutMsByRole`, Fix 2). All optional.
   */
  config: Pick<Config, "ai" | "run" | "timeouts">;
  /** The model-call seam (real = `provider.defaultGenerate`, tests = a fake). */
  generate: GenerateFn;
  /** The `ai_call` event sink (the run's `AiWriter`, or a test recorder). */
  aiWriter: AiCallSink;
  /**
   * Optional redaction policy. When present and `enabled`, `aiCall` populates the
   * `redactedPrompt`/`redactedResponse` fields on every `ai_call` event (secrets + PII masked
   * upstream of the writer — see the REDACTION CONTRACT in `artifacts/events.ts`). When absent, no
   * prompt/response is logged (behavior identical to pre-redaction runs).
   */
  redactor?: Redactor;
  /**
   * Optional ADDITIVE observer invoked once per emitted `ai_call` event (Phase 5 telemetry bridge,
   * P5_DESIGN.md §4 / Risk R5). It receives the SAME payload written to `ai.jsonl` (minus `ts`/
   * `type`) so the runner can mirror it onto the active step's telemetry span WITHOUT importing
   * telemetry into `ai/`. Behavior-preserving when unset; it must never throw into the run (the
   * caller — `aiCall` — guards it).
   */
  onAiCall?: (event: Omit<AiCallEvent, "ts" | "type">) => void;
  /** Injectable clock for deterministic event timestamps (unused by the trackers themselves). */
  now?: () => number;
}

/**
 * The assembled AI runtime. Round 2 reads `hooks` (→ `ctx.ai`), `judge` (→ `assertCtx.aiJudge`),
 * and `usageTotals()` (→ `run_end` totals + the run summary). The default runtime is gated on
 * API-key presence by the CALLER; this factory just assembles from deps.
 */
export interface AiRuntime {
  /** Per-role resolved model entries (model + fallbacks + pricing). */
  registry: Record<ModelRoleName, ResolvedModelRole>;
  /** The budget tracker (counters + ceilings; throws `BudgetExceededError`). */
  budget: import("./budget.ts").BudgetTracker;
  /** The per-role/model cost accumulator. */
  cost: import("./cost.ts").CostAccumulator;
  /** The model-call seam. */
  generate: GenerateFn;
  /** The `ai_call` sink. */
  aiWriter: AiCallSink;
  /** The L2/L3/L4 hooks the orchestrator calls via `ctx.ai`. */
  hooks: AiHooksImpl;
  /** The `ai_judge` oracle wired into `assertCtx.aiJudge`. */
  judge(assertion: AiJudgeAssertion, opts: AiJudgeOptions): Promise<AssertionResult>;
  /**
   * The L5 path-repair planner (PLAN_v003 v003-6). Bound to `planner-l5.ts` around the same runtime
   * slice `aiCall` uses, so the runner's `runPathRepair` can gather the current page + call the
   * cheap arm + (on the escalation signal) the capable arm — all offline-testable through the
   * `generate` seam. Present whenever a runtime exists; the runner gates its USE on
   * `[plan].enabled` + a real divergence, so a deterministic (no-AI-runtime) run never touches it.
   */
  planner: PlannerRuntime;
  /** The run-level cost rollup Round 2 folds into `run_end` totals + `buildSummary`. */
  usageTotals(): { total_cost_usd: number; model_usage: ModelUsage[] };
}

/**
 * The bound L5 planner surface the runtime exposes (PLAN_v003 v003-6). Mirrors the free functions in
 * `planner-l5.ts`, each pre-bound to the runtime slice + registry so the runner needs no `ai/`
 * internals. `gatherPlannerPage` builds the current-page context (URL + candidates); `planRepair`
 * calls the CHEAP arm; `planRepairEscalated` calls the ESCALATION-ONLY capable arm.
 */
export interface PlannerRuntime {
  gatherPlannerPage(
    divergedStep: Step,
    ctx: ResolveContext,
    recent: import("./planner-l5.ts").RecentAction[],
  ): Promise<import("./planner-l5.ts").PlannerPageContext>;
  planRepair(
    goal: string,
    opts: import("./planner-l5.ts").PlanRepairOpts,
  ): Promise<import("./planner-l5.ts").PlanRepairResult>;
  planRepairEscalated(
    goal: string,
    opts: import("./planner-l5.ts").PlanRepairOpts & { duel?: boolean },
  ): Promise<import("./planner-l5.ts").PlanRepairResult>;
}

/** The concrete (all-present) Ai hooks the runtime exposes (the orchestrator's `AiHooks`). */
export interface AiHooksImpl {
  resolveL2(step: Step, prior: StepExecution, ctx: ResolveContext): Promise<StepExecution>;
  resolveL3(step: Step, prior: StepExecution, ctx: ResolveContext): Promise<StepExecution>;
  classifyL4(step: Step, prior: StepExecution, ctx: ResolveContext): Promise<StepExecution>;
  /**
   * L3 vision BATCH (PLAN_v003 §4 v003-3): resolve ≥2 same-page vision targets from ONE screenshot
   * + ONE vision call, returning one `StepExecution` per input step (same order) with per-target
   * fallback to a single {@link resolveL3} inside the callback. Bound to `vision-l3.ts`'s
   * `resolveBatchL3`, this is the `BatchVisionResolve` the runner injects into `resolveVisionBatch`
   * so the ladder keeps importing NOTHING from `ai/`.
   */
  resolveBatchL3(steps: Step[], ctx: ResolveContext): Promise<StepExecution[]>;
}
