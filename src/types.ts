// Flightplan — shared cross-cutting primitives.
//
// This is the single source of truth for the small set of literal unions and primitive
// types that more than one module needs (config, flow, lock, ladder, assert). Keep this
// file dependency-light: types + `const` arrays only, no runtime logic, no zod. Modules
// that need zod schemas build them from these `const` arrays (e.g. `z.enum(STRATEGIES)`).
//
// Canonical references: PLAN.md §4 (data model), PROPOSAL_v1.md (Locks / Step vocabulary /
// Assertion vocabulary).

// ---------------------------------------------------------------------------
// Selector strategy (lock recipe enum) — PLAN.md §4 / PROPOSAL "Locks"
// ---------------------------------------------------------------------------

/**
 * The stored selector-strategy enum, used by lock recipes and the L1 strategy ladder.
 * The strings are verbatim from PLAN.md §4 and the proposal's lock enum. The L1
 * strategy → stored Strategy mapping (PLAN.md §4) is:
 *   testid                               → 'testid'
 *   role/name                            → 'role_name'
 *   label AND placeholder                → 'label'   (placeholder folds into label)
 *   visible text (interactive-role-only) → 'scoped_text'
 *   scoped accessible tree / structural  → 'structural_fingerprint'
 *   raw CSS fallback                     → 'css'
 */
export const STRATEGIES = [
  "testid",
  "role_name",
  "label",
  "scoped_text",
  "structural_fingerprint",
  "css",
] as const;
export type Strategy = (typeof STRATEGIES)[number];

// ---------------------------------------------------------------------------
// Step actions — PLAN.md §4 (StepDo) / PROPOSAL "Step vocabulary"
// ---------------------------------------------------------------------------

/** The v0 step verbs. Kept deliberately small (PROPOSAL "Step vocabulary"). */
export const STEP_DOS = [
  "goto",
  "click",
  "fill",
  "select",
  "press",
  "wait",
  "assert",
  "ai_pick",
  "run",
  "switch_frame",
  "switch_to_main",
] as const;
export type StepDo = (typeof STEP_DOS)[number];

// ---------------------------------------------------------------------------
// Assertion types — PLAN.md §4 (AssertType) / PROPOSAL "Assertion vocabulary"
// ---------------------------------------------------------------------------

/** The v0 assertion types. `ai_judge` is the only AI-backed (non-deterministic) one. */
export const ASSERT_TYPES = [
  "visible",
  "hidden",
  "text",
  "url",
  "value",
  "count",
  "ai_judge",
] as const;
export type AssertType = (typeof ASSERT_TYPES)[number];

/** The deterministic assertion types — everything except `ai_judge`. */
export const DETERMINISTIC_ASSERT_TYPES = [
  "visible",
  "hidden",
  "text",
  "url",
  "value",
  "count",
] as const;
export type DeterministicAssertType = (typeof DETERMINISTIC_ASSERT_TYPES)[number];

// ---------------------------------------------------------------------------
// Assertion timing — PLAN.md §4 (`when`) / PROPOSAL "When assertions run"
// ---------------------------------------------------------------------------

/** When an attached assertion runs relative to its step's action. Defaults to 'after'. */
export const ASSERT_WHENS = ["before", "after"] as const;
export type AssertWhen = (typeof ASSERT_WHENS)[number];

// ---------------------------------------------------------------------------
// ai_judge input modalities — PLAN.md §4 / PROPOSAL "AI judge"
// ---------------------------------------------------------------------------

/**
 * Modalities an `ai_judge` may look at. A judge whose inputs include `screenshot` MUST be
 * routed to the vision model (the only image-capable role) — PROPOSAL "AI judge".
 */
export const AI_JUDGE_INPUTS = ["source", "text", "screenshot"] as const;
export type AiJudgeInput = (typeof AI_JUDGE_INPUTS)[number];

// ---------------------------------------------------------------------------
// Assertion policy / modality enums — PLAN.md §4 (RunLimits) / PROPOSAL "[assertions]"
// ---------------------------------------------------------------------------

/** Eager (fail/record at the failing assertion) vs deferred (collect, report at end). */
export const ASSERTION_MODES = ["eager", "deferred"] as const;
export type AssertionMode = (typeof ASSERTION_MODES)[number];

// ---------------------------------------------------------------------------
// File kinds — PLAN.md §4 / PROPOSAL "File kinds"
// ---------------------------------------------------------------------------

/** TOML file kinds. A config file is `kind = "config"`; a flow is `kind = "flow"`. */
export const FILE_KINDS = ["config", "flow"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

// ---------------------------------------------------------------------------
// Model roles — PLAN.md §4 / PROPOSAL "AI SDK v7 and OpenRouter"
// ---------------------------------------------------------------------------

/**
 * The named model roles, all routed via OpenRouter. `planner` (cheap) + `planner_capable`
 * (expensive) back the L5 path-repair planner (PLAN_v003 §4 Phase C / v003-6): `planner` is the
 * mandatory cheap-first default; `planner_capable` is the escalation-only capable arm (UNPROVEN —
 * fired only on the low-confidence / repeated-replan signal, never standing).
 */
export const MODEL_ROLES = ["resolver", "advisor", "vision", "planner", "planner_capable"] as const;
export type ModelRoleName = (typeof MODEL_ROLES)[number];

// ---------------------------------------------------------------------------
// Advisory verdict kinds — PLAN.md §4 / PROPOSAL "Advisory verdict (typed)"
// ---------------------------------------------------------------------------

/** The advisor's typed verdict kinds. Only `heal` writes the lock. */
export const ADVISORY_VERDICTS = ["heal", "bug", "flake", "intent_changed"] as const;
export type AdvisoryVerdictKind = (typeof ADVISORY_VERDICTS)[number];

/**
 * The advisor's typed verdict (the L4 classification), a discriminated union on `kind`.
 * Payloads are verbatim from PROPOSAL_v1.md "Advisory verdict (typed)". Owned here (not in
 * `ai/`) so the AI tier files, the ladder `StepExecution`, and the Round-2 runner all share the
 * SAME contract without a race. Hard rules (PROPOSAL): only `heal` writes the lock; `bug` is a
 * real product failure surfaced through assertions; `flake` retries; `intent_changed` emits a
 * proposed patch and is never auto-applied. The advisor NEVER acts — it only classifies.
 */
export interface AdvisoryHealVerdict {
  kind: "heal";
  /** The target the advisor believes should be healed (NL or selector identity). */
  target: string;
  /** The re-resolvable recipe the advisor proposes (NEVER a `ref:eN`). */
  recipe: { strategy: Strategy; selector: string };
  /** Model confidence in the heal, 0..1. */
  confidence: number;
}
export interface AdvisoryBugVerdict {
  kind: "bug";
  /** Human-readable summary of the product bug. */
  summary: string;
  /** Concrete evidence strings (observed states / messages). */
  evidence: string[];
}
export interface AdvisoryFlakeVerdict {
  kind: "flake";
  /** Why the advisor judged this transient. */
  reason: string;
}
export interface AdvisoryIntentChangedVerdict {
  kind: "intent_changed";
  /** Summary of how the app's intended behavior changed. */
  summary: string;
  /** Path the proposed patch is/will-be written to (the runner materializes the file). */
  proposed_patch_path: string;
}

/** The advisor's typed verdict (discriminated union). See {@link AdvisoryVerdictKind}. */
export type AdvisoryVerdict =
  | AdvisoryHealVerdict
  | AdvisoryBugVerdict
  | AdvisoryFlakeVerdict
  | AdvisoryIntentChangedVerdict;

// ---------------------------------------------------------------------------
// Run verdicts — PLAN.md §4 (RunSummary) / PROPOSAL "Budgets and verdicts"
// ---------------------------------------------------------------------------

/** The single top-level run verdict reported in the `--json` run summary. */
export const RUN_VERDICTS = ["passed", "failed", "inconclusive", "error"] as const;
export type RunVerdict = (typeof RUN_VERDICTS)[number];
