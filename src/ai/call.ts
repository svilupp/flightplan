// Flightplan — `aiCall`: the single choke point for one logical model call (PLAN.md §5 Phase 4).
//
// One `aiCall` == one `max_model_calls` budget unit == exactly one `ai_call` event. The
// per-role fallback iteration happens INSIDE the `GenerateFn` (provider.ts), so retries do NOT
// re-increment the model-call budget — but the winning call's cost still accrues and is checked
// against `max_cost_usd`. Budget errors PROPAGATE (the runner maps them to `inconclusive`);
// generate failures are emitted then re-thrown for the calling tier to escalate.
//
// ai.jsonl redaction (PLAN.md §5 Phase 5): the writer stays dumb — it NEVER redacts. When a
// `Redactor` is wired into the runtime (and `enabled`), `aiCall` populates the already-redacted
// `redactedPrompt`/`redactedResponse` fields UPSTREAM of the writer, satisfying the REDACTION
// CONTRACT in `artifacts/events.ts`. With no redactor those fields stay OMITTED, so AI runs are
// byte-identical to pre-redaction behavior.

import type { z } from "zod";
import type { AiCallEvent, AiCallRole } from "../artifacts/events.ts";
import type { Redactor } from "../redaction/index.ts";
import type { ModelRoleName } from "../types.ts";
import type { BudgetTracker } from "./budget.ts";
import type { CostAccumulator } from "./cost.ts";
import { extractUsageCost } from "./cost.ts";
import type { ResolvedRegistry } from "./registry.ts";
import { roleModel } from "./registry.ts";
import type { AiCallContext, AiCallResult, AiCallSink, AiMessage, GenerateFn } from "./types.ts";

/**
 * Role-aware per-attempt wall-clock ceiling (ms), passed as `GenerateRequest.timeoutMs` so
 * `defaultGenerate` bounds EACH `generateText` attempt with `AbortSignal.timeout(ms)`. L2/L3
 * (resolver/vision) sit in the hot per-step path, so a hung call should escalate quickly;
 * advisor (L4) is a terminal, rarely-reached tier, so it gets a bit more headroom but stays
 * bounded — never unbounded like the pre-fix 174s hang. Overridable per call via
 * `AiCallRuntime.timeoutMsByRole` (tests use this to shrink the wait to milliseconds).
 */
export const DEFAULT_TIMEOUT_MS_BY_ROLE: Record<ModelRoleName, number> = {
  resolver: 20_000,
  vision: 25_000,
  advisor: 40_000,
  // The L5 planner (PLAN_v003 v003-6): cheap `planner` sits in the per-divergence hot path so it
  // escalates quickly like the resolver; the capable `planner_capable` arm gets advisor-tier
  // headroom since it is a rarely-reached escalation.
  planner: 25_000,
  planner_capable: 40_000,
};

/** The runtime slice `aiCall` consumes (a subset of `AiRuntime`). */
export interface AiCallRuntime {
  registry: ResolvedRegistry;
  budget: BudgetTracker;
  cost: CostAccumulator;
  generate: GenerateFn;
  aiWriter: AiCallSink;
  /** Optional redaction policy. When `enabled`, fills `redactedPrompt`/`redactedResponse`. */
  redactor?: Redactor;
  /** Optional ADDITIVE telemetry observer (Phase 5, R5). Mirrors each emitted `ai_call` payload. */
  onAiCall?: (event: Omit<AiCallEvent, "ts" | "type">) => void;
  /**
   * Optional per-role timeout override (ms), merged over {@link DEFAULT_TIMEOUT_MS_BY_ROLE}.
   * Production callers normally omit this; tests use it to keep the "hung call" test fast.
   */
  timeoutMsByRole?: Partial<Record<ModelRoleName, number>>;
}

/**
 * Coerce a `modelRole` into the `AiCallRole` it should be LOGGED as when no explicit `callRole` was
 * given. `planner_capable` (the escalation arm — a model role, not a call role) logs as `planner`;
 * every other model role is already a valid call role.
 */
function modelRoleToCallRole(role: ModelRoleName): AiCallRole {
  return role === "planner_capable" ? "planner" : role;
}

/** Invoke the optional `onAiCall` observer, swallowing any error (telemetry never breaks a run). */
function notifyAiCall(rt: AiCallRuntime, payload: Omit<AiCallEvent, "ts" | "type">): void {
  if (!rt.onAiCall) return;
  try {
    rt.onAiCall(payload);
  } catch {
    /* an observer error must never propagate into the run */
  }
}

/**
 * Flatten a multimodal message list to plain text for redacted logging. Text parts are joined;
 * `file` parts (base64 image data — huge + unredactable) are replaced by a `[file:<mediaType>]`
 * placeholder so the screenshot bytes never reach `ai.jsonl`.
 */
function renderMessages(messages: AiMessage[] | undefined): string {
  if (!messages) return "";
  const parts: string[] = [];
  for (const m of messages) {
    for (const c of m.content) {
      parts.push(c.type === "text" ? c.text : `[file:${c.mediaType}]`);
    }
  }
  return parts.join("\n");
}

/** Build the (already-redacted) prompt/response fields for an `ai_call` event, when a redactor is active. */
function redactedFields(
  redactor: Redactor | undefined,
  input: { prompt?: string; messages?: AiMessage[] },
  output: unknown,
): { redactedPrompt?: string; redactedResponse?: string } {
  if (!redactor?.enabled) return {};
  const prompt = input.prompt ?? renderMessages(input.messages);
  return {
    redactedPrompt: redactor.redactText(prompt),
    redactedResponse: redactor.redactText(JSON.stringify(output)),
  };
}

/** Classify a generate failure into an `ai_call` outcome label (without importing the SDK). */
function failureOutcome(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "AI_NoOutputGeneratedError" || /no output generated/i.test(msg)) return "no_output";
  // `AbortSignal.timeout(ms)` firing on the LAST attempt in the fallback chain surfaces here as
  // either a DOMException/Error named "TimeoutError" (spec) or "AbortError" (some fetch shims),
  // or an AI SDK wrapper whose message mentions "timed out" / "timeout". Distinguish "hung" from
  // a genuine provider error/refusal so `ai.jsonl` telemetry can tell them apart.
  if (name === "TimeoutError" || name === "AbortError" || /timed?\s*out/i.test(msg))
    return "timeout";
  return "error";
}

/**
 * Run one logical AI call: budget pre-check (`max_model_calls`), invoke the `GenerateFn` (which
 * iterates fallbacks), accrue cost, emit ONE `ai_call` event, check `max_cost_usd`, and return the
 * validated/typed output. `modelRole` selects the registry entry (model chain + pricing + cost
 * attribution); `callRole` (defaulting to `modelRole`) is what the event records (a `judge`
 * differs from its underlying text/vision model role).
 */
export async function aiCall<S extends z.ZodType>(
  rt: AiCallRuntime,
  ctx: AiCallContext<S>,
): Promise<AiCallResult<z.infer<S>>> {
  const modelRole: ModelRoleName = ctx.modelRole;
  // The LOGGED role is always a valid `AiCallRole`. `callRole` (when given) already is; when it is
  // omitted we fall back to `modelRole`, coercing `planner_capable` (a model role, not a call role)
  // to `planner` so the escalation arm logs under the same call role as the cheap arm (PLAN_v003
  // v003-6). Every other `ModelRoleName` is itself a valid `AiCallRole`.
  const callRole: AiCallRole = ctx.callRole ?? modelRoleToCallRole(modelRole);
  const entry = roleModel(rt.registry, modelRole);
  const models = [entry.model, ...entry.fallbacks];

  // (1) Pre-check + count the model call. Throws BudgetExceededError('max_model_calls').
  rt.budget.noteModelCall();

  // (2) Invoke the seam (fallback iteration is internal). On failure: emit + rethrow.
  const timeoutMs = rt.timeoutMsByRole?.[modelRole] ?? DEFAULT_TIMEOUT_MS_BY_ROLE[modelRole];
  let result: Awaited<ReturnType<GenerateFn>>;
  try {
    result = await rt.generate({
      modelRole,
      models,
      schema: ctx.schema,
      maxOutputTokens: ctx.maxOutputTokens,
      timeoutMs,
      ...(ctx.prompt !== undefined ? { prompt: ctx.prompt } : {}),
      ...(ctx.messages !== undefined ? { messages: ctx.messages } : {}),
      // Prompt caching (PLAN_v003 v003-6): pass the cacheable-prefix marker straight through; the
      // provider owns the SDK cache-control breakpoint. Omitted → no caching (byte-identical).
      ...(ctx.cache !== undefined ? { cache: ctx.cache } : {}),
    });
  } catch (err) {
    const failurePayload = {
      role: callRole,
      model: models[0] ?? "unknown",
      purpose: ctx.purpose,
      inputTokens: 0,
      outputTokens: 0,
      cost_usd: 0,
      outcome: failureOutcome(err),
    };
    await rt.aiWriter.emitAiCall(failurePayload);
    notifyAiCall(rt, failurePayload);
    throw err;
  }

  // (3) Cost (provider cost if present, else pricing-derived) + per-role/model accumulation.
  const cost = extractUsageCost(result.usage, entry.pricing);
  rt.cost.add(modelRole, result.model, cost);

  // (4) Validate/type the output (defense-in-depth; the GenerateFn already validated it).
  const output = ctx.schema.parse(result.output);
  const derived = ctx.deriveOutcome?.(output);

  // (5) Emit ONE ai_call event (model/tokens/cost/outcome + already-redacted prompt/response when a
  //     redactor is active — see header REDACTION CONTRACT).
  const payload = {
    role: callRole,
    model: result.model,
    purpose: ctx.purpose,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    cost_usd: cost.cost_usd,
    outcome: derived?.outcome ?? "ok",
    ...(derived?.advisoryVerdict !== undefined ? { advisoryVerdict: derived.advisoryVerdict } : {}),
    ...redactedFields(rt.redactor, { prompt: ctx.prompt, messages: ctx.messages }, output),
  };
  await rt.aiWriter.emitAiCall(payload);
  notifyAiCall(rt, payload);

  // (6) Check the cost ceiling AFTER logging (the call happened + cost is recorded). May throw.
  rt.budget.addCost(cost.cost_usd);

  return {
    output,
    model: result.model,
    cost_usd: cost.cost_usd,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
  };
}
