// Flightplan — zod Output schemas for the AI tiers (PROPOSAL_v1.md "AI judge" / "Advisory
// verdict (typed)"; PLAN.md §5 Phase 4). These are the schemas passed to the AI SDK's Output API
// (`output: Output.object({ schema })`) — but zod itself is NOT the AI SDK, so these schemas (and
// the types derived from them) are SDK-free and usable throughout `ai/` and the tests.

import { z } from "zod";
import type { AdvisoryVerdict } from "../types.ts";
import { STRATEGIES } from "../types.ts";

// ---------------------------------------------------------------------------
// Resolver / vision decision (L2 + L3 share this — both pick a candidate by INDEX)
// ---------------------------------------------------------------------------

/** Max length of an emitted advisory `note` (DESIGN §4.1 caps it at 160 chars — sparse prose). */
export const NOTE_MAX_LENGTH = 160;

/**
 * The resolver/vision decision. The model is given an INDEX-numbered candidate packet and must
 * pick by `index` (never a raw selector). `decision`:
 *  - `pick`              — choose `index` with `confidence` (acted on iff `confidence ≥ 0.5`).
 *  - `screenshot_needed` — (L2 only) the text packet is insufficient → escalate to L3 vision.
 *  - `give_up`           — no candidate matches → escalate to the advisor (L4).
 *
 * `note` is the OPTIONAL "note-to-future-self" (DESIGN §4): sparse freeform prose the model MAY emit
 * to help a FUTURE AI resolution of this same target (e.g. "icon-only toolbar, floppy-disk glyph
 * top-right, no testid"). It is advisory context ONLY — never a selector, a routing directive, or a
 * correctness signal — capped at {@link NOTE_MAX_LENGTH} chars, redacted + decayed before reuse.
 */
export const ResolverDecisionSchema = z
  .object({
    decision: z.enum(["pick", "screenshot_needed", "give_up"]),
    index: z.number().int().min(0).optional(),
    confidence: z.number().min(0).max(1).optional(),
    reason: z.string().optional(),
    note: z.string().max(NOTE_MAX_LENGTH).optional(),
  })
  .strict();

export type ResolverDecision = z.infer<typeof ResolverDecisionSchema>;

// ---------------------------------------------------------------------------
// Planner plan — the L5 path-repair decision (PLAN_v003 §4 Phase C / v003-6)
// ---------------------------------------------------------------------------

/**
 * The step verbs the L5 planner may propose. A DELIBERATELY SMALL, EXPLICIT set — the plan calls out
 * that the incremental next-step formulation under-specifies navigation/submit, so the planner must
 * name them explicitly (`goto` for navigation, `press` for submit-by-key). Each proposed step is
 * validated against the real `StepSchema` before it executes (see `runner/path-repair.ts`).
 */
export const PLANNER_STEP_DOS = ["click", "fill", "select", "press", "goto"] as const;

/** Max repair steps a single planner plan may propose (bounded — PLAN_v003 v003-6). */
export const PLANNER_MAX_STEPS = 3;

/** One repair step the planner proposes (a compact projection of a flow `Step`). */
const PlannerStepSchema = z
  .object({
    do: z.enum(PLANNER_STEP_DOS),
    /** NL target / locator for a `click`/`fill`/`select` (resolved through L0–L4 like any step). */
    target: z.string().optional(),
    /** Value for a `fill` / `select`. */
    value: z.string().optional(),
    /** Absolute/relative URL for a `goto` (explicit navigation). */
    url: z.string().optional(),
    /** Key for a `press` (explicit submit, e.g. "Enter"). */
    key: z.string().optional(),
  })
  .strict();

/**
 * The planner's plan (PLAN_v003 v003-6): on a path divergence it proposes the next step(s) to get
 * back on track, or gives up.
 *  - `decision`   — `"repair"` (propose `steps`) or `"give_up"` (the divergence is not repairable).
 *  - `confidence` — 0..1 self-reported confidence. Below the escalate threshold the CHEAP arm's
 *    plan is re-issued on the capable arm (the escalation signal — UNPROVEN, tuned in the field).
 *  - `steps`      — bounded (≤ {@link PLANNER_MAX_STEPS}) repair steps; required for `"repair"`.
 *  - `reason`     — short human note for the trace/log.
 *  - `note`       — optional advisory note (unused for now; reserved, mirrors the resolver `note`).
 *
 * Uses the Output API structured style (NO provider `response_format: json_object` — the plan warns
 * a blind `json_object` degraded some models; PLAN_v003 §4).
 */
export const PlannerPlanSchema = z
  .object({
    decision: z.enum(["repair", "give_up"]),
    confidence: z.number().min(0).max(1),
    steps: z.array(PlannerStepSchema).max(PLANNER_MAX_STEPS).optional(),
    reason: z.string().optional(),
    note: z.string().max(NOTE_MAX_LENGTH).optional(),
  })
  .strict();

export type PlannerPlan = z.infer<typeof PlannerPlanSchema>;
export type PlannerStep = z.infer<typeof PlannerStepSchema>;

// ---------------------------------------------------------------------------
// ai_judge verdict — boolean pass + optional reason (NO threshold; PROPOSAL "AI judge")
// ---------------------------------------------------------------------------

export const JudgeSchema = z
  .object({
    pass: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();

export type JudgeVerdict = z.infer<typeof JudgeSchema>;

// ---------------------------------------------------------------------------
// Advisor verdict — discriminated union (heal | bug | flake | intent_changed)
// ---------------------------------------------------------------------------

/** The re-resolvable recipe an advisor `heal` proposes (NEVER a `ref:eN`). */
const AdvisorRecipeSchema = z
  .object({
    strategy: z.enum(STRATEGIES),
    selector: z.string().min(1),
  })
  .strict();

/**
 * The advisor's typed verdict, validated via the Output API. Mirrors {@link AdvisoryVerdict} in
 * `../types.ts` (the shared contract) — the compile-time assertion below guarantees they agree.
 * `intent_changed.proposed_patch_path` is the model's suggested path; the runner (Round 2)
 * materializes the actual `proposed-patches/` file and may overwrite it.
 */
export const AdvisorVerdictSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("heal"),
      target: z.string(),
      recipe: AdvisorRecipeSchema,
      confidence: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bug"),
      summary: z.string(),
      evidence: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("flake"),
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("intent_changed"),
      summary: z.string(),
      proposed_patch_path: z.string(),
    })
    .strict(),
]);

// Compile-time guard: the schema's inferred type MUST be assignable to the shared AdvisoryVerdict
// contract (and vice-versa). If either drifts, this fails typecheck.
type _SchemaToType = z.infer<typeof AdvisorVerdictSchema> extends AdvisoryVerdict ? true : never;
type _TypeToSchema = AdvisoryVerdict extends z.infer<typeof AdvisorVerdictSchema> ? true : never;
const _schemaMatchesType: _SchemaToType = true;
const _typeMatchesSchema: _TypeToSchema = true;
void _schemaMatchesType;
void _typeMatchesSchema;
