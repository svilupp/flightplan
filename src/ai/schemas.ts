// Flightplan — zod Output schemas for the AI tiers (PROPOSAL_v1.md "AI judge" / "Advisory
// verdict (typed)"; PLAN.md §5 Phase 4). These are the schemas passed to the AI SDK's Output API
// (`output: Output.object({ schema })`) — but zod itself is NOT the AI SDK, so these schemas (and
// the types derived from them) are SDK-free and usable throughout `ai/` and the tests.

import { z } from "zod";
import { STRATEGIES } from "../types.ts";
import type { AdvisoryVerdict } from "../types.ts";

// ---------------------------------------------------------------------------
// Resolver / vision decision (L2 + L3 share this — both pick a candidate by INDEX)
// ---------------------------------------------------------------------------

/**
 * The resolver/vision decision. The model is given an INDEX-numbered candidate packet and must
 * pick by `index` (never a raw selector). `decision`:
 *  - `pick`              — choose `index` with `confidence` (acted on iff `confidence ≥ 0.5`).
 *  - `screenshot_needed` — (L2 only) the text packet is insufficient → escalate to L3 vision.
 *  - `give_up`           — no candidate matches → escalate to the advisor (L4).
 */
export const ResolverDecisionSchema = z
  .object({
    decision: z.enum(["pick", "screenshot_needed", "give_up"]),
    index: z.number().int().min(0).optional(),
    confidence: z.number().min(0).max(1).optional(),
    reason: z.string().optional(),
  })
  .strict();

export type ResolverDecision = z.infer<typeof ResolverDecisionSchema>;

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
