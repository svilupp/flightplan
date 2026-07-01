// Flightplan — flow zod schemas (source of truth for FlowFile/Step/Assertion validation).
//
// Types in `./types.ts` are derived from these via `z.infer`. The discriminated unions
// (Step by `do`, Assertion by `type`) enforce required-fields-per-variant at the schema
// level; the linter (separate module) layers higher-level semantic rules on top.
//
// Canonical reference: PLAN.md §4 (FlowFile / Step / Assertion / ImportTable) and
// PROPOSAL_v1.md "Step vocabulary" / "Assertion vocabulary" / "AI judge" / "Composition".

import { z } from "zod";
import {
  AI_JUDGE_INPUTS,
  ASSERT_WHENS,
  DETERMINISTIC_ASSERT_TYPES,
  FILE_KINDS,
} from "../types.ts";
import { ConfigSchema, RunLimitsSchema } from "../config/schema.ts";

// ---------------------------------------------------------------------------
// Assertion — discriminated union on `type` (PLAN.md §4 AssertType).
// ---------------------------------------------------------------------------

/** Fields common to every assertion: timing + per-assertion timeout. */
const assertionCommon = {
  when: z.enum(ASSERT_WHENS).optional(), // default 'after' (applied at use-site)
  timeout_ms: z.number().int().positive().optional(),
} as const;

// Deterministic assertion variants. Each carries only the field(s) it needs, plus an
// optional `selector` to scope the check (PLAN.md §4 Assertion).
export const VisibleAssertionSchema = z
  .object({
    type: z.literal("visible"),
    ...assertionCommon,
    text: z.string().optional(),
    selector: z.string().optional(),
  })
  .strict();

export const HiddenAssertionSchema = z
  .object({
    type: z.literal("hidden"),
    ...assertionCommon,
    text: z.string().optional(),
    selector: z.string().optional(),
  })
  .strict();

export const TextAssertionSchema = z
  .object({
    type: z.literal("text"),
    ...assertionCommon,
    text: z.string(), // text assertion requires the expected text
    selector: z.string().optional(),
  })
  .strict();

export const UrlAssertionSchema = z
  .object({
    type: z.literal("url"),
    ...assertionCommon,
    url: z.string(), // url assertion requires the expected URL (glob/substring)
  })
  .strict();

export const ValueAssertionSchema = z
  .object({
    type: z.literal("value"),
    ...assertionCommon,
    value: z.string(), // expected value
    selector: z.string().optional(),
  })
  .strict();

export const CountAssertionSchema = z
  .object({
    type: z.literal("count"),
    ...assertionCommon,
    count: z.number().int().nonnegative(), // expected count
    selector: z.string().optional(),
  })
  .strict();

/**
 * ai_judge — boolean judge. A SINGLE `prompt`, a list of `inputs` modalities, and NO
 * `threshold` (PROPOSAL "AI judge"; PLAN.md §4). `.strict()` makes an unknown key such as
 * `threshold` a validation error, which is exactly what the linter requires.
 */
export const AiJudgeAssertionSchema = z
  .object({
    type: z.literal("ai_judge"),
    ...assertionCommon,
    prompt: z.string().min(1),
    inputs: z.array(z.enum(AI_JUDGE_INPUTS)).min(1).optional(),
  })
  .strict();

export const DeterministicAssertionSchema = z.discriminatedUnion("type", [
  VisibleAssertionSchema,
  HiddenAssertionSchema,
  TextAssertionSchema,
  UrlAssertionSchema,
  ValueAssertionSchema,
  CountAssertionSchema,
]);

export const AssertionSchema = z.discriminatedUnion("type", [
  VisibleAssertionSchema,
  HiddenAssertionSchema,
  TextAssertionSchema,
  UrlAssertionSchema,
  ValueAssertionSchema,
  CountAssertionSchema,
  AiJudgeAssertionSchema,
]);

// ---------------------------------------------------------------------------
// Step — discriminated union on `do` (PLAN.md §4 StepDo).
// ---------------------------------------------------------------------------

/** Fields common to every step. */
const stepCommon = {
  id: z.string().min(1),
  /** Optional per-step assertions ([[steps.assert]]). */
  assert: z.array(AssertionSchema).optional(),
  /** Optional per-step timeout override (PLAN.md §4 mentions per-step timeout_ms). */
  timeout_ms: z.number().int().positive().optional(),
} as const;

/** Fields shared by the NL-targeting actions (click / fill / select / ai_pick). */
const targetingCommon = {
  target: z.string().optional(), // NL target description
  hints: z.array(z.string()).optional(), // explicit selector/text hints tried in L1
  intent: z.string().optional(), // NL intent fed to fuzzy match + models
} as const;

export const GotoStepSchema = z
  .object({ ...stepCommon, do: z.literal("goto"), url: z.string().min(1) })
  .strict();

export const ClickStepSchema = z
  .object({ ...stepCommon, do: z.literal("click"), ...targetingCommon })
  .strict();

export const FillStepSchema = z
  .object({
    ...stepCommon,
    do: z.literal("fill"),
    ...targetingCommon,
    value: z.string(), // fill requires a value
    secret: z.boolean().optional(), // secret → redacted everywhere
  })
  .strict();

export const SelectStepSchema = z
  .object({
    ...stepCommon,
    do: z.literal("select"),
    ...targetingCommon,
    value: z.string(), // select requires a value to choose
  })
  .strict();

export const PressStepSchema = z
  .object({ ...stepCommon, do: z.literal("press"), key: z.string().min(1) })
  .strict();

export const WaitStepSchema = z
  .object({ ...stepCommon, do: z.literal("wait"), ms: z.number().int().nonnegative() })
  .strict();

/** A standalone assert step — runs at its own position. Requires at least one assertion. */
export const AssertStepSchema = z
  .object({
    ...stepCommon,
    do: z.literal("assert"),
    assert: z.array(AssertionSchema).min(1),
  })
  .strict();

export const AiPickStepSchema = z
  .object({
    ...stepCommon,
    do: z.literal("ai_pick"),
    ...targetingCommon,
  })
  .strict();

export const StepSchema = z.discriminatedUnion("do", [
  GotoStepSchema,
  ClickStepSchema,
  FillStepSchema,
  SelectStepSchema,
  PressStepSchema,
  WaitStepSchema,
  AssertStepSchema,
  AiPickStepSchema,
]);

// ---------------------------------------------------------------------------
// Imports — string | string[] | [[imports]] tables (PROPOSAL "Composition").
// ---------------------------------------------------------------------------

export const ImportTableSchema = z
  .object({
    module: z.string().min(1),
    with: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const ImportsSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)),
  z.array(ImportTableSchema),
]);

// ---------------------------------------------------------------------------
// FlowFile — header + body (PLAN.md §4).
// ---------------------------------------------------------------------------

export const FlowFileSchema = z
  .object({
    // header
    version: z.number().int().positive(),
    kind: z.literal(FILE_KINDS[1]), // "flow"
    id: z.string().min(1),
    description: z.string().min(1),
    // composition
    imports: ImportsSchema.optional(),
    setup: z.string().min(1).optional(),
    teardown: z.string().min(1).optional(),
    // flow-level config (rare; mostly for self-contained flows). [config.*]
    config: ConfigSchema.optional(),
    // declared inputs ([inputs]) — ${inputs.*} / ${env.*} templated values
    inputs: z.record(z.string(), z.string()).optional(),
    // flow-local run budgets ([run])
    run: RunLimitsSchema.optional(),
    // the ordered step list
    steps: z.array(StepSchema).min(1),
  })
  .strict();
