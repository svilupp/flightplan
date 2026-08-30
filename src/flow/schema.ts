// Flightplan — flow zod schemas (source of truth for FlowFile/Step/Assertion validation).
//
// Types in `./types.ts` are derived from these via `z.infer`. The discriminated unions
// (Step by `do`, Assertion by `type`) enforce required-fields-per-variant at the schema
// level; the linter (separate module) layers higher-level semantic rules on top.
//
// Canonical reference: PLAN.md §4 (FlowFile / Step / Assertion / ImportTable) and
// PROPOSAL_v1.md "Step vocabulary" / "Assertion vocabulary" / "AI judge" / "Composition".

import { z } from "zod";
import { ConfigSchema, RunLimitsSchema } from "../config/schema.ts";
import {
  AI_JUDGE_INPUTS,
  ASSERT_PURPOSES,
  ASSERT_WHENS,
  EFFECTS,
  FILE_KINDS,
  RETRY_POLICIES,
  STATE_ASSERTIONS,
  TEXT_MATCH_MODES,
  TRANSITION_ASSERTIONS,
  URL_MATCH_MODES,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Assertion — discriminated union on `type` (PLAN.md §4 AssertType).
// ---------------------------------------------------------------------------

/** Fields common to every assertion: timing + per-assertion timeout. */
const assertionCommon = {
  when: z.enum(ASSERT_WHENS).optional(), // default 'after' (applied at use-site)
  purpose: z.enum(ASSERT_PURPOSES).optional(),
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
    match: z.enum(TEXT_MATCH_MODES).optional(),
    /** Optional landmark selector; when supplied it scopes the read independently of `selector`. */
    landmark: z.string().optional(),
  })
  .strict();

export const UrlAssertionSchema = z
  .object({
    type: z.literal("url"),
    ...assertionCommon,
    url: z.string(), // url assertion requires the expected URL (glob/substring)
    match: z.enum(URL_MATCH_MODES).optional(),
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

/** Deterministic UI/business state assertion. */
export const StateAssertionSchema = z
  .object({
    type: z.literal("state"),
    ...assertionCommon,
    state: z.enum(STATE_ASSERTIONS),
    selector: z.string().optional(),
    value: z.string().optional(),
    count: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Deterministic transition assertion, normally evaluated after an action. */
export const TransitionAssertionSchema = z
  .object({
    type: z.literal("transition"),
    ...assertionCommon,
    kind: z.enum(TRANSITION_ASSERTIONS),
    selector: z.string().optional(),
    /** A named capture to compare against; omitted means the step's before-state. */
    from: z.string().optional(),
    capture: z.string().optional(),
  })
  .strict();

/** Deterministic assertion against the structured result of a webmcp_call step. */
export const ResultAssertionSchema = z
  .object({
    type: z.literal("result"),
    ...assertionCommon,
    /** Dot-path into the tool result; omitted addresses the result root. */
    path: z.string().min(1).optional(),
    /** Exact typed equality. TOML callers can use strings, numbers, booleans, or null. */
    equals: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    /** Assert that the path is present (or absent) without comparing its value. */
    exists: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.equals === undefined && value.exists === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["equals"],
        message: "result assertion requires equals or exists",
      });
    }
    if (value.equals !== undefined && value.exists !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["equals"],
        message: "result assertion cannot set both equals and exists",
      });
    }
  });

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
  StateAssertionSchema,
  TransitionAssertionSchema,
  ResultAssertionSchema,
]);

export const AssertionSchema = z.discriminatedUnion("type", [
  VisibleAssertionSchema,
  HiddenAssertionSchema,
  TextAssertionSchema,
  UrlAssertionSchema,
  ValueAssertionSchema,
  CountAssertionSchema,
  StateAssertionSchema,
  TransitionAssertionSchema,
  ResultAssertionSchema,
  AiJudgeAssertionSchema,
]);

/** A value captured from the live page for later templating or transition checks. */
export const CaptureSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["url", "text", "value", "state", "result"]),
    selector: z.string().optional(),
    state: z.enum(STATE_ASSERTIONS).optional(),
    /** Dot-path into the current webmcp_call result; required for type = result. */
    path: z.string().min(1).optional(),
    /** Mask this runtime capture in persisted artifacts while retaining it in memory. */
    secret: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === "result" && value.path === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "result captures require a path (use . for the root result)",
      });
    }
  });

/** Declarative popup/new-page expectation attached to the triggering step. */
export const PopupExpectationSchema = z
  .object({
    opener: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    target_id: z.string().min(1).optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Step — discriminated union on `do` (PLAN.md §4 StepDo).
// ---------------------------------------------------------------------------

/**
 * Control flow: `on_fail = { goto, max }`. When a step would otherwise FAIL the run (target
 * resolution exhausts the ladder, or a post-assertion fails), control jumps to the step id in
 * `goto` instead of failing. `goto = "self"` (or the step's own id) retries the same step. `max`
 * caps how many times a step may be RE-ENTERED via a jump before the run fails normally (loop
 * safety); omitted → default 1 extra entry. See `src/runner/runner.ts` for the jump semantics.
 */
export const OnFailSchema = z
  .object({
    goto: z.string().min(1),
    max: z.number().int().positive().optional(),
  })
  .strict();

/** Fields common to every step. */
const stepCommon = {
  id: z.string().min(1),
  /** Optional per-step assertions ([[steps.assert]]). */
  assert: z.array(AssertionSchema).optional(),
  /** Optional per-step timeout override (PLAN.md §4 mentions per-step timeout_ms). */
  timeout_ms: z.number().int().positive().optional(),
  /** Control flow: jump to another step (or retry `self`) instead of failing the run. */
  on_fail: OnFailSchema.optional(),
  /** Side-effect contract. Omitted is accepted for backwards compatibility and linted. */
  effect: z.enum(EFFECTS).optional(),
  /** Optional explicit natural-language anchor; otherwise the target's NL entry is carried. */
  anchor: z.string().min(1).optional(),
  /** Dynamic retry authorization, deliberately separate from on_fail routing. */
  retry: z
    .object({
      policy: z.enum(RETRY_POLICIES).optional(),
      max: z.number().int().nonnegative().optional(),
    })
    .strict()
    .optional(),
  /** Native dialog behavior for this step; the flow-level browser setting remains the default. */
  dialog: z.enum(["accept", "dismiss", "fail", "prompt", "manual"]).optional(),
  /** Values captured after this step's action. A single object is shorthand for a one-item list. */
  capture: z.union([CaptureSchema, z.array(CaptureSchema)]).optional(),
  /** New-page expectation aliases are accepted to keep TOML ergonomic across callers. */
  expect_page: PopupExpectationSchema.optional(),
  popup: PopupExpectationSchema.optional(),
  new_page: PopupExpectationSchema.optional(),
} as const;

/** Fields shared by the locator-targeting actions (click / fill / select / ai_pick). */
const targetingCommon = {
  /** Ordered locator list (PLAN_v002 §1): selectors (`ref:`/`role:`/`text:`/`css:`/`[...]`
   * prefixed) tried in author order at L1, plus at most one natural-language query that feeds
   * fuzzy ranking + L2/L3. A bare string is a one-entry list. See `./normalize-target.ts`. */
  target: z.union([z.string(), z.array(z.string())]).optional(),
  /** Per-step L0 cache-match mode (L0 cache-hit quality, Layer 2). Overrides the flow-level
   * `[cache] signature`. `struct-only` trusts a cached recipe when the role-tree skeleton is
   * unchanged even if the (masked) text drifts. Omitted → the flow/config default. */
  cache: z.enum(["full", "struct-only"]).optional(),
  /** Hard tier hint (PLAN_v003 §2 (c) / §4 v003-3). `"vision"` marks a target text tiers can't
   * resolve (an unlabeled icon / Nth glyph) so the runner routes it STRAIGHT to vision (L3),
   * skipping the L2 text tier — and, when ≥2 consecutive vision-hinted targeting steps sit on the
   * SAME page, batches them into ONE screenshot + ONE vision call. Omitted → the normal cheap-first
   * ladder (L0→L1→L2→L3→L4). */
  tier_hint: z.literal("vision").optional(),
} as const;

export const GotoStepSchema = z
  .object({
    ...stepCommon,
    do: z.literal("goto"),
    url: z.string().min(1),
    secret: z.boolean().optional(), // secret → the (templated) URL is redacted everywhere
  })
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
    /** Fill-verification strictness, forwarded to browser-pilot's native `page.fill` `verify`
     * option (requires browser-pilot >= 0.2.1). `"normalized"` (default) tolerates
     * auto-formatting (NFKC + whitespace-collapse, e.g. phone/card spacing); `"off"` skips
     * verification entirely (use when a formatter inserts punctuation like dashes/parens);
     * `"exact"` requires the typed value to stick unchanged. */
    verify: z.enum(["exact", "normalized", "off"]).optional(),
  })
  .strict();

export const SelectStepSchema = z
  .object({
    ...stepCommon,
    do: z.literal("select"),
    ...targetingCommon,
    value: z.string(), // select requires a value to choose
    secret: z.boolean().optional(), // secret → the (templated) value is redacted everywhere
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

/**
 * switch_frame — ENTER a same-origin `<iframe>` (and, per browser-pilot, a cross-origin OOPIF) so
 * that SUBSEQUENT steps' targets resolve INSIDE that frame. `target` is the usual ordered locator
 * list, but it identifies the `<iframe>` ELEMENT in the CURRENT document — so at least one
 * CSS/attribute (or `ref:`/`role:`/`text:`) selector is REQUIRED: a frame cannot be entered by
 * natural language alone (browser-pilot resolves the frame element by selector). Frame context is
 * STATEFUL: it persists for later steps until a `switch_to_main`, a `goto` navigation, or teardown.
 * Delegates to browser-pilot's `Page.switchToFrame`. NB: a `switch_frame` step takes NO `value`; it
 * is not a locator-targeting (L1) verb — the runner enters the frame directly, it does not resolve
 * the iframe element through the cost ladder.
 */
export const SwitchFrameStepSchema = z
  .object({
    ...stepCommon,
    do: z.literal("switch_frame"),
    /** Ordered locator list identifying the `<iframe>` element (a selector entry is required). */
    target: z.union([z.string(), z.array(z.string())]),
  })
  .strict();

/**
 * switch_to_main — LEAVE the current frame and return to the top document (browser-pilot's
 * `Page.switchToMain`). Takes no target. The counterpart to `switch_frame`; a `goto` navigation and
 * teardown also implicitly reset the frame context to the top document.
 */
export const SwitchToMainStepSchema = z
  .object({ ...stepCommon, do: z.literal("switch_to_main") })
  .strict();

/**
 * run — execute another flow at this position (PLAN_v002 §3, v002-5..v002-9). `flow` names an
 * imported flow id (recommended) or a direct path (contains `/` or ends `.toml` — v002-6).
 * `with` passes inputs to the child, templated against the parent's scope. Expansion is static
 * at load time (v002-8) — see `./run.ts` for the flattening pass.
 */
export const RunStepSchema = z
  .object({
    ...stepCommon,
    do: z.literal("run"),
    flow: z.string().min(1),
    with: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/**
 * Field-equality map used to correlate an emitted message with its reply — dot paths against the
 * parsed JSON reply payload (browser-pilot's `AwaitReplyOptions.where`). Values are JSON scalars.
 */
export const EmitAwaitReplySchema = z
  .object({
    where: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
    /** Glob matched against the raw reply payload text. */
    match: z.string().min(1).optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

/**
 * emit — inject a message on a WebSocket the page itself owns (browser-pilot's `page.emitMessage`,
 * >=0.2.0). Inherently `at_most_once`: the frame is dispatched at most once and browser-pilot never
 * retries it, so `effect` is FORCED to `"at_most_once"` here (the field is overridden after the
 * `stepCommon` spread — a bare `effect` key or an explicit non-`"at_most_once"` value is a schema
 * error). `channel` is restricted to `"ws"` (the only channel browser-pilot currently supports).
 * `payload` is a string OR an inline table — a table is JSON-serialized at the driver boundary
 * (`JSON.stringify`) before it reaches browser-pilot, which only accepts string payloads.
 */
export const EmitStepSchema = z
  .object({
    ...stepCommon,
    do: z.literal("emit"),
    channel: z.literal("ws"),
    /** URL glob selecting the socket when the page owns more than one; browser-pilot enforces it. */
    match: z.string().min(1).optional(),
    payload: z.union([z.string(), z.record(z.string(), z.unknown())]),
    /** Treat `payload` as base64 and send it as a binary frame. */
    base64: z.boolean().optional(),
    await_reply: EmitAwaitReplySchema.optional(),
    secret: z.boolean().optional(), // secret → the (templated) payload is redacted everywhere
    // Forced/defaulted: emit is inherently at-most-once (browser-pilot never retries a dispatched
    // frame). Overrides `stepCommon`'s generic `effect` field for this variant only.
    effect: z.literal("at_most_once").optional().default("at_most_once"),
  })
  .strict();

/**
 * webmcp_call — invoke a named tool exposed by the current page's WebMCP model context.
 *
 * This is deliberately a direct, exact-name operation: WebMCP discovery is a page capability,
 * not a selector-resolution problem, so the step never enters the ladder or lock. The effect
 * annotation is also the mutation acknowledgement: observe (the default) requires the tool's
 * readOnlyHint, while idempotent/at_most_once allow a mutating tool.
 */
export const WebMcpCallStepSchema = z
  .object({
    ...stepCommon,
    do: z.literal("webmcp_call"),
    tool: z.string().min(1),
    input: z.record(z.string(), z.unknown()).optional().default({}),
    /** Exact tool origin; also opts that origin into WebMCP cross-origin discovery. */
    origin: z.string().min(1).optional(),
    /** Additional origins explicitly allowed during discovery. */
    from_origins: z.array(z.string().min(1)).optional(),
    secret: z.boolean().optional(),
    effect: z.enum(EFFECTS).optional().default("observe"),
  })
  .strict();

/**
 * eval — an escape-hatch verb that runs raw JavaScript in the page (or, when `frame` is given, in
 * a same-origin `<iframe>`/genuine cross-origin OOPIF) via browser-pilot's `Page.evaluate`, which
 * pierces cross-origin child sessions (unlike the element verbs, which only route
 * fill/click/focus/etc. into an OOPIF's own child session — resolving a SELECTOR inside a real
 * cross-origin frame is not yet supported there). Use it ONLY when no targeting verb can reach the
 * element (documented gotcha: a genuine OOPIF, e.g. an Adyen secure card field).
 *
 * `args` is passed as STRUCTURED data — a JSON literal spliced at the driver boundary into an
 * async-function-call wrapper around `script` — never string-interpolated into the script body
 * itself (`script` is authored once; `args` supplies the per-run values). `script`'s statements run
 * inside `(async function (args) { ...script... })(<args-as-JSON>)`, so `return <value>` inside
 * `script` becomes the step's result and `await` is valid.
 *
 * `expect` gates success: `"truthy"` (default) passes when the result is JS-truthy; any other
 * string is compared to `JSON.stringify(result)` for an exact literal match. This REPLACES the
 * normal fill-verification path other verbs get — eval owns its own success predicate.
 *
 * eval is EXEMPT from the healing ladder (L0 only; it never escalates and is never learned into the
 * lock file — the escape hatch is intentionally invisible to self-healing, PLAN.md/README skill
 * guidance). It otherwise behaves like any other step for `retry`/`on_fail`.
 */
export const EvalStepSchema = z
  .object({
    ...stepCommon,
    do: z.literal("eval"),
    /** CSS selector identifying the `<iframe>` element to evaluate inside; omitted = main frame. */
    frame: z.string().min(1).optional(),
    /** The script body, run as `(async function (args) { <script> })(<args>)`. */
    script: z.string().min(1),
    /** Structured arguments passed to `script` as `args`, templated like any other step value. */
    args: z.record(z.string(), z.unknown()).optional(),
    /** secret → args/script/result are redacted everywhere. */
    secret: z.boolean().optional(),
    /** `"truthy"` (default) or a literal string compared against `JSON.stringify(result)`. */
    expect: z.string().min(1).optional().default("truthy"),
  })
  .strict();

/**
 * evaluate — a bare escape-hatch verb that runs a raw JS expression via browser-pilot's
 * `page.evaluate`, which pierces cross-origin child sessions (OOPIFs) that a `switch_frame` step
 * has entered — unlike the element verbs (fill/click/etc.), which cannot resolve a SELECTOR inside
 * a genuine cross-origin frame. Use it ONLY when no targeting verb can reach the element
 * (documented gotcha: a genuine OOPIF, e.g. an Adyen secure card field).
 *
 * Deliberately minimal relative to `eval` (no `frame`, `args`, or `expect` predicate — just a
 * single expression string run as-is): this is a narrow, no-frills escape hatch, not a scripting
 * surface. `effect` is REQUIRED (not defaulted) — a raw expression's side effects are opaque to
 * the schema, so the author must state them explicitly.
 */
export const EvaluateStepSchema = z
  .object({
    ...stepCommon,
    do: z.literal("evaluate"),
    /** The raw JS expression run via `page.evaluate(expression)`. */
    expression: z.string().min(1),
    /** secret → the (templated) expression is redacted everywhere. */
    secret: z.boolean().optional(),
    effect: z.enum(EFFECTS),
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
  RunStepSchema,
  SwitchFrameStepSchema,
  SwitchToMainStepSchema,
  EmitStepSchema,
  WebMcpCallStepSchema,
  EvalStepSchema,
  EvaluateStepSchema,
]);

// ---------------------------------------------------------------------------
// Imports — string | string[] (PLAN_v002 v002-5: imports are a LIBRARY — they register flow
// ids and compose locks, never execute; inputs are passed at each `run` site. The old
// [[imports]]+`with` table form is dropped; `imports/no-with` lints the migration.)
// ---------------------------------------------------------------------------

export const ImportsSchema = z.union([z.string().min(1), z.array(z.string().min(1))]);

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
    /**
     * The durable WHAT the flow accomplishes (PLAN_v003 §4 Phase C / v003-6). Load-bearing for the
     * L5 path-repair planner's NON-LOCAL repairs: a divergence far from the intent needs the goal to
     * re-anchor. Optional — when absent it defaults to `description` at resolve time (see
     * `resolveFlowGoal`), so an author who wrote only a `description` still gets a usable goal.
     */
    goal: z.string().min(1).optional(),
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
