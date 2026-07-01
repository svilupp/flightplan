// Flightplan — typed span/event attribute builders (P5_DESIGN.md §4 span/event model).
//
// These map the runner's existing artifact-event objects (READ-ONLY contract in
// `artifacts/events.ts`) onto telemetry `SpanAttributes`, so Unit E's call sites stay terse and
// the attribute keys stay consistent with the run/step/ai_call data. Attribute keys are
// snake_case to match the wire/PROPOSAL style. `undefined` fields are dropped on record.
//
// NOTE (defense-in-depth): `ai_call` telemetry deliberately OMITS `redactedPrompt`/
// `redactedResponse` — telemetry carries metrics, never prompt/response text.

import type {
  AiCallEvent,
  AssertionResultEvent,
  BrowserActionEvent,
  ResolutionAttemptEvent,
} from "../artifacts/events.ts";
import type { SpanAttributes } from "./types.ts";

/** Root run span attributes (set at `startRun`). */
export function runSpanAttrs(a: { flowId: string; runId: string }): SpanAttributes {
  return { flow_id: a.flowId, run_id: a.runId };
}

/** Run span end attributes (set at `runSpan.end(...)`). */
export function runEndAttrs(a: { verdict?: string; driftCount?: number }): SpanAttributes {
  return { verdict: a.verdict, drift_count: a.driftCount };
}

/** Per-step span attributes (set at `runSpan.child(...)`). */
export function stepSpanAttrs(a: { stepId: string; do: string; intent?: string }): SpanAttributes {
  return { step_id: a.stepId, do: a.do, intent: a.intent };
}

/** Per-step span end attributes (set at `stepSpan.end(...)`). */
export function stepEndAttrs(a: {
  ok: boolean;
  tier?: string;
  healed: boolean;
  repaired?: boolean;
  durationMs?: number;
}): SpanAttributes {
  return {
    ok: a.ok,
    tier: a.tier,
    healed: a.healed,
    repaired: a.repaired,
    duration_ms: a.durationMs,
  };
}

/** `ai_call` event attributes — mirrors `AiCallEvent` (minus redacted text). */
export function aiCallEventAttrs(e: AiCallEvent): SpanAttributes {
  return {
    role: e.role,
    model: e.model,
    purpose: e.purpose,
    input_tokens: e.inputTokens,
    output_tokens: e.outputTokens,
    cost_usd: e.cost_usd,
    outcome: e.outcome,
    advisory_verdict: e.advisoryVerdict,
  };
}

/** `browser_action` event attributes — mirrors `BrowserActionEvent`. */
export function browserActionEventAttrs(e: BrowserActionEvent): SpanAttributes {
  return {
    action: e.action,
    selector_or_intent: e.selectorOrIntent,
    selector_used: e.selectorUsed,
    strategy: e.strategy,
    ok: e.ok,
    failure_reason: e.failureReason,
    covering_element: e.coveringElement,
    duration_ms: e.durationMs,
  };
}

/** `resolution_attempt` event attributes — mirrors `ResolutionAttemptEvent` (incl. repair notes). */
export function resolutionAttemptEventAttrs(e: ResolutionAttemptEvent): SpanAttributes {
  return {
    step_id: e.stepId,
    tier: e.tier,
    strategy: e.strategy,
    candidates: e.candidates,
    outcome: e.outcome,
    duration_ms: e.durationMs,
  };
}

/** `assertion_result` event attributes — mirrors `AssertionResultEvent`. */
export function assertionResultEventAttrs(e: AssertionResultEvent): SpanAttributes {
  return {
    step_id: e.stepId,
    assert_type: e.assertType,
    pass: e.pass,
    message: e.message,
    duration_ms: e.durationMs,
  };
}

/** `artifact_created` event attributes (screenshot / video / proposed-patch). */
export function artifactCreatedAttrs(a: { kind: string; path: string }): SpanAttributes {
  return { kind: a.kind, path: a.path };
}

/** `lock_read` / `lock_write` / `lock_proposed_update` event attributes. */
export function lockEventAttrs(a: {
  source?: string;
  namespace?: string;
  step?: string;
  healed?: boolean;
}): SpanAttributes {
  return { source: a.source, namespace: a.namespace, step: a.step, healed: a.healed };
}
