// Flightplan — artifact event schemas.
//
// Discriminated-union TS types for the three artifact streams written under a run dir:
//   - run.jsonl   — the run/step/assertion lifecycle (RunEvent)
//   - trace.jsonl — low-level browser actions + ladder resolution attempts (TraceEvent)
//   - ai.jsonl    — model calls (AiEvent); the type is defined now so Phase 4 only imports it
//
// Every event carries:
//   - `ts`   — a millisecond epoch timestamp, INJECTABLE for tests (the writers stamp it
//              from an injected `now()`), never read from the wall clock inside a payload.
//   - `type` — the discriminator literal.
//
// These types are the cross-agent contract: the runner (orchestration agent) emits them and
// the Phase 4 (AI) + Phase 5 (explain) agents read them. They MUST match exactly. No `any`
// in any payload — strict discriminated unions only (PLAN.md §4, this module's brief).
//
// Canonical references: PLAN.md §4 (data model, run-summary contract) and §5 Phase 2/4/5.

import type {
  ActionReceipt,
  BrowserPilotProvenance,
  DispatchState,
  MatchedCondition,
} from "../driver/types.ts";
import type {
  AdvisoryVerdictKind,
  AssertType,
  ModelRoleName,
  RunVerdict,
  Strategy,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** The ladder tier that resolved (or attempted to resolve) a step's target. PLAN.md §2 (b). */
export type LadderTier = "L0" | "L1" | "L2" | "L3" | "L4";
export const LADDER_TIERS = ["L0", "L1", "L2", "L3", "L4"] as const;

/**
 * Per-role model cost rollup, as it appears in `run_end` totals and the run summary.
 * `role` is the narrow model-role union (PLAN.md §4 `model_usage[]`).
 */
export interface ModelUsage {
  role: ModelRoleName;
  model: string;
  calls: number;
  cost_usd: number;
}

/** Run-level totals shared by the `run_end` event and the summary. */
export interface RunTotals {
  /** Number of steps actually executed (may be < flow length on fail-fast). */
  steps_run: number;
  /** Count of steps that auto-healed; under --frozen this is drift that was NOT persisted. */
  drift_count: number;
  /** Aggregate model spend across all AI tiers + judges. */
  total_cost_usd: number;
  /** Per-role spend breakdown. */
  model_usage: ModelUsage[];
}

/** Dependency provenance carried by run artifacts. */
export interface ArtifactProvenance {
  browserPilot: BrowserPilotProvenance;
}

// ---------------------------------------------------------------------------
// run.jsonl events — the run/step/assertion lifecycle
// ---------------------------------------------------------------------------

/** Emitted once at the start of a run. */
export interface RunStartEvent {
  type: "run_start";
  ts: number;
  runId: string;
  flowId: string;
  /** Flow inputs after templating; values may be redacted upstream (secret fills). */
  inputs: Record<string, string>;
  /** Compact, human-readable config summary (not the full Config — caller decides shape). */
  configSummary: Record<string, string | number | boolean>;
  /** The run limits in force (max_steps / max_cost_usd / etc.), null fields omitted by caller. */
  limits: Record<string, number | string | boolean>;
  provenance?: ArtifactProvenance;
}

/** Emitted when a step begins, before resolution. */
export interface StepStartEvent {
  type: "step_start";
  ts: number;
  stepId: string;
  /** The step verb (`do`), e.g. "click" / "fill" / "goto". */
  do: string;
  /** The natural-language intent, when present. */
  intent?: string;
  effect?: "observe" | "idempotent" | "at_most_once";
  anchor?: string;
}

/** Emitted when a step completes (success or failure), after any heal. */
export interface StepEndEvent {
  type: "step_end";
  ts: number;
  stepId: string;
  ok: boolean;
  /** The ladder tier that resolved this step's target (absent for non-resolving steps). */
  tier?: LadderTier;
  /** True when the resolved recipe differed from the lock and the step self-healed. */
  healed: boolean;
  durationMs: number;
  /** Present only when `ok` is false. */
  error?: string;
  dispatchState?: DispatchState;
  retrySafe?: boolean;
  matchedConditions?: MatchedCondition[];
  attempts?: number;
  retryDecisionReason?: string;
  retryReason?: string;
  receipt?: ActionReceipt;
  transportAmbiguous?: boolean;
  captures?: Record<string, string>;
  popup?: {
    matched: boolean;
    targetId?: string;
    type?: string;
    url?: string;
    title?: string;
    opener?: string;
    openerTargetId?: string;
    reason?: string;
  };
  effect?: "observe" | "idempotent" | "at_most_once";
  anchor?: string;
}

/** Emitted for each assertion evaluated against a step. */
export interface AssertionResultEvent {
  type: "assertion_result";
  ts: number;
  stepId: string;
  assertType: AssertType;
  pass: boolean;
  message: string;
  durationMs: number;
}

/** Emitted once at the end of a run with the final verdict and totals. */
export interface RunEndEvent {
  type: "run_end";
  ts: number;
  verdict: RunVerdict;
  totals: RunTotals;
  /** Present only when the verdict is `error` (harness crash) or a step errored. */
  error?: string;
}

/** Any event written to run.jsonl. */
export type RunEvent =
  | RunStartEvent
  | StepStartEvent
  | StepEndEvent
  | AssertionResultEvent
  | RunEndEvent;

// ---------------------------------------------------------------------------
// trace.jsonl events — low-level browser actions + ladder resolution attempts
// ---------------------------------------------------------------------------

/** Outcome of a single low-level browser action (a wrapped browser-pilot action). */
export interface BrowserActionEvent {
  type: "browser_action";
  ts: number;
  /** The action verb dispatched to the driver, e.g. "click" / "fill" / "goto". */
  action: string;
  /** The NL target or intent the action was resolving. */
  selectorOrIntent: string;
  /** The selector that actually resolved (driver `selectorUsed`), when known. */
  selectorUsed?: string;
  /** The L1 strategy that won, when known. */
  strategy?: Strategy;
  /**
   * L0 PORTFOLIO health (DESIGN §3.4): the agreement count of the strategy race that resolved the
   * step, `"<agreeing>/<parseable>"` (e.g. `"3/4"`). Present only on an L0 portfolio-race hit; lets
   * `report`/`explain` show how many remembered strategies corroborate the winner. Absent at L1+.
   */
  agreement?: string;
  ok: boolean;
  /** browser-pilot `failureReason`, when the action failed. */
  failureReason?: string;
  /** browser-pilot `coveringElement` (overlay blocking the target), when reported. */
  coveringElement?: string;
  durationMs: number;
  dispatchState?: DispatchState;
  retrySafe?: boolean;
  matchedConditions?: MatchedCondition[];
  attempts?: number;
  retryDecisionReason?: string;
  retryReason?: string;
  receipt?: ActionReceipt;
  effect?: "observe" | "idempotent" | "at_most_once";
  anchor?: string;
  /** A non-fatal human-readable note about the outcome. Absent on a step with nothing to note. */
  note?: string;
}

/** A single rung of the resolution ladder being attempted for a step. */
export interface ResolutionAttemptEvent {
  type: "resolution_attempt";
  ts: number;
  stepId: string;
  tier: LadderTier;
  /** The strategy tried at this tier (L1), when applicable. */
  strategy?: Strategy;
  /** Candidate selectors/intents considered at this tier, when applicable. */
  candidates?: string[];
  /** The result of the attempt, e.g. "resolved" / "unresolved" / "escalated" / "ambiguous". */
  outcome: string;
  durationMs: number;
  dispatchState?: DispatchState;
  retrySafe?: boolean;
  matchedConditions?: MatchedCondition[];
  attempts?: number;
  retryDecisionReason?: string;
  retryReason?: string;
  receipt?: ActionReceipt;
  effect?: "observe" | "idempotent" | "at_most_once";
  anchor?: string;
}

/** Any event written to trace.jsonl. */
export type TraceEvent = BrowserActionEvent | ResolutionAttemptEvent;

// ---------------------------------------------------------------------------
// ai.jsonl events — model calls (Phase 4 emits these; the type is defined now)
// ---------------------------------------------------------------------------

/**
 * The role of a model call. Wider than ModelRoleName in one direction (a `judge` routes to a text
 * or vision model but is logged distinctly) and narrower in another (a `planner_capable` escalation
 * is still logged as `planner`). An L5 path-repair planner call (PLAN_v003 v003-6) is logged as
 * `planner` regardless of which arm — cheap or capable — produced it.
 */
export type AiCallRole = "resolver" | "advisor" | "vision" | "judge" | "planner";
export const AI_CALL_ROLES = ["resolver", "advisor", "vision", "judge", "planner"] as const;

/**
 * A single model call.
 *
 * REDACTION CONTRACT: `redactedPrompt` / `redactedResponse` are exactly that — already
 * redacted. The ai.jsonl writer does NOT redact; redaction (Phase 5 `redaction/`) is applied
 * UPSTREAM by the caller BEFORE the event reaches the writer. The writer must never see a raw
 * secret. (PLAN.md §5 Phase 5; this module's brief.)
 */
export interface AiCallEvent {
  type: "ai_call";
  ts: number;
  role: AiCallRole;
  model: string;
  /** What the call was for, e.g. "resolve" / "classify" / "judge:assert-1". */
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cost_usd: number;
  /** The call outcome, e.g. "ok" / "no_output" / "error" / a typed advisor verdict. */
  outcome: string;
  /** Optionally an advisory verdict kind, when this was an advisor (L4) call. */
  advisoryVerdict?: AdvisoryVerdictKind;
  /** Already-redacted prompt text (see REDACTION CONTRACT above). */
  redactedPrompt?: string;
  /** Already-redacted response text (see REDACTION CONTRACT above). */
  redactedResponse?: string;
}

/** Any event written to ai.jsonl. */
export type AiEvent = AiCallEvent;

// ---------------------------------------------------------------------------
// Run summary — summary.json (same data as run_end + per-step rollup)
// ---------------------------------------------------------------------------

/** Per-step rollup row in the run summary; one entry per executed step. */
export interface StepSummary {
  stepId: string;
  do: string;
  ok: boolean;
  tier?: LadderTier;
  healed: boolean;
  durationMs: number;
  error?: string;
  dispatchState?: DispatchState;
  retrySafe?: boolean;
  matchedConditions?: MatchedCondition[];
  attempts?: number;
  retryDecisionReason?: string;
  retryReason?: string;
  receipt?: ActionReceipt;
  transportAmbiguous?: boolean;
  captures?: Record<string, string>;
  popup?: {
    matched: boolean;
    targetId?: string;
    type?: string;
    url?: string;
    title?: string;
    opener?: string;
    openerTargetId?: string;
    reason?: string;
  };
  effect?: "observe" | "idempotent" | "at_most_once";
  anchor?: string;
}

/**
 * The structured run summary written to `summary.json`. This is the data `--json` mode prints
 * and Phase 5's `explain` reads. It carries the same totals as `run_end` plus the per-step
 * rollup and the resolved artifact paths.
 *
 * Field names mirror PLAN.md §4's `--json` RunSummary contract (snake_case for the wire-facing
 * fields) so the CLI serializer can pass it through directly.
 */
export interface RunSummary {
  verdict: RunVerdict;
  flow_id: string;
  run_id: string;
  run_dir: string;
  failed_step: string | null;
  failed_assertions: Array<{ step: string; type: AssertType; detail: string }>;
  advisory_verdict: AdvisoryVerdictKind | null;
  /** Step ids that auto-healed. */
  healed_steps: string[];
  /** == healed_steps.length; non-zero under --frozen means drift not persisted. */
  drift_count: number;
  screenshot_paths: string[];
  video_path: string | null;
  trace_path: string;
  total_cost_usd: number;
  model_usage: ModelUsage[];
  /** Set on an `intent_changed` advisory verdict. */
  proposed_patch_path: string | null;
  /**
   * L5 path-repair accounting (PLAN_v003 v003-6): how many divergences the planner repaired this
   * run, and the ids of the synthetic repair steps it spliced in + executed. `0` / `[]` when the
   * planner never fired (the overwhelming common case — no divergence, or no AI runtime).
   */
  replan_count: number;
  repaired_steps: string[];
  /** Runtime browser-pilot package/source/build identity. */
  provenance?: ArtifactProvenance;
  /** Runtime named captures, redacted before serialization. */
  captures?: Record<string, string>;
  /** Original and newly observed page identities for declarative popup steps. */
  pages?: Array<{
    targetId?: string;
    type?: string;
    opener?: string;
    openerTargetId?: string;
    url?: string;
    title?: string;
    role: "active" | "popup";
  }>;
  /** Per-step rollup (the addition over the wire RunSummary; consumed by `explain`). */
  steps: StepSummary[];
}
