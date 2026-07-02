// Flightplan — L5: the cheap-first path-repair planner (PLAN_v003 §4 Phase C / v003-6).
//
// A SEPARATE surface from the L4 advisor (`advisor-l4.ts`) — the advisor CLASSIFIES a persistent
// per-target failure and never acts; the planner REPAIRS the flow's PATH when the run diverges from
// its recorded playbook, proposing the next step(s) to get back on track. It is invoked at the
// RUNNER level (`runner/path-repair.ts`), NOT inside the L0→L4 per-target ladder — the ladder is
// untouched.
//
// CHEAP-FIRST IS MANDATORY. `planRepair` defaults to the cheap `planner` model (the same DeepSeek
// family that matched Opus 100% on replanning, FINDINGS §2 pillar b). The capable arm
// (`planRepairEscalated`, `modelRole:"planner_capable"`) is ESCALATION-ONLY — it fires solely on the
// defined low-confidence / repeated-replan signal, never standing/default.
//
//   ⚠️ UNPROVEN: a STANDING expensive planner is an explicit non-goal (PLAN_v003 §6 / §7). The
//   `planner_capable` arm + the dueling variant below are UNPROVEN — the precise escalation signal
//   is to be tuned in the field. Do NOT promote it to the default without evidence.
//
// PROMPT CACHING IS MANDATORY (PLAN_v003 v003-6; uncached measured 3.85× the cost). Every call
// carries `cache:{prefix,key}`: the STABLE PREFIX (goal + the step vocabulary/constraints) is
// cacheable and byte-stable across replans in a run, keyed on the GOAL so it invalidates on a goal
// change, NOT on page nav. The VOLATILE SUFFIX (current-page candidates + recent action history) is
// never cached. `provider.ts` owns the SDK cache-control breakpoint.

import type { Step } from "../flow/types.ts";
import type { ResolveContext } from "../ladder/index.ts";
import { isBudgetExceeded } from "./budget.ts";
import type { AiCallRuntime } from "./call.ts";
import { aiCall } from "./call.ts";
import type { CandidatePacketEntry } from "./resolve-common.ts";
import { buildCandidatePacket, gatherCandidates } from "./resolve-common.ts";
import { AI_MIN_OUTPUT_TOKENS } from "./resolver-l2.ts";
import type { PlannerPlan } from "./schemas.ts";
import { PLANNER_STEP_DOS, PlannerPlanSchema } from "./schemas.ts";

// ---------------------------------------------------------------------------
// Escalation constants (UNPROVEN thresholds — PLAN_v003 §7; tune in the field)
// ---------------------------------------------------------------------------

/**
 * Planner confidence at/BELOW which the cheap arm's plan is escalated to the capable arm. The
 * low-confidence escalation signal (pillar b: no text-only task separated the tiers, so the
 * expensive arm only earns its keep when the cheap arm is unsure). UNPROVEN.
 */
export const PLANNER_ESCALATE_CONFIDENCE = 0.5;

/**
 * How many CHEAP attempts one divergence gets before the NEXT attempt escalates to the capable arm
 * (the repeated-replan signal). UNPROVEN.
 */
export const PLANNER_ESCALATE_ATTEMPTS = 2;

/**
 * The hard per-divergence attempt ceiling (cheap + escalated combined). After this many attempts
 * for the SAME divergence the planner gives up (the run fails normally). Distinct from the
 * run-level `max_replans` budget. UNPROVEN.
 */
export const PLANNER_MAX_ATTEMPTS_PER_DIVERGENCE = 3;

// ---------------------------------------------------------------------------
// Prompt building — STABLE PREFIX (cacheable) + VOLATILE SUFFIX (never cached)
// ---------------------------------------------------------------------------

/** One recent action, projected for the planner's history block (redaction-safe: ids + verbs only). */
export interface RecentAction {
  /** The step id that ran. */
  id: string;
  /** The step verb (`click`/`fill`/…). */
  do: string;
  /** A short NL description of the target/intent (never a secret value). */
  intent?: string;
  /** Whether the step succeeded. */
  ok: boolean;
}

/** The current-page context handed to the planner (the volatile suffix). */
export interface PlannerPageContext {
  /** The current page URL. */
  url: string;
  /** The step the run DIVERGED at (the next recorded step that no longer fits the page). */
  divergedStepId: string;
  /** The current page's index-numbered interactive candidates (from `gatherCandidates`). */
  candidates: CandidatePacketEntry[];
  /** The recent action history (best-effort; the runner supplies what it has). */
  recent: RecentAction[];
}

/**
 * The STABLE, CACHEABLE prefix: the flow goal + the step vocabulary/constraints. Byte-stable across
 * every replan in a run (it depends ONLY on `goal`), so the provider caches it once and reuses it.
 * Keep this deterministic — no timestamps, no page state, no per-attempt text.
 */
export function buildPlannerPrefix(goal: string): string {
  return [
    "You are Flightplan's PATH-REPAIR planner. A recorded browser flow has DIVERGED from its known",
    "path (the page no longer matches the next recorded step). Propose the next step(s) that get the",
    "flow back on track toward its GOAL, or give up if it cannot be repaired.",
    `GOAL: ${JSON.stringify(goal)}`,
    "",
    "RULES:",
    `- Propose at most 3 steps, each with a "do" from: ${PLANNER_STEP_DOS.join(", ")}.`,
    '- Be EXPLICIT about navigation and submission: use do="goto" (with "url") to navigate and',
    '  do="press" (with "key", e.g. "Enter") to submit — do not assume they happen implicitly.',
    '- For do="click"/"fill"/"select" give a natural-language "target"; add "value" for fill/select.',
    "- Prefer the fewest steps that re-anchor on the GOAL. If the divergence cannot be repaired,",
    '  respond decision="give_up".',
    '- Respond decision="repair" with the "steps" and a "confidence" (0..1), or decision="give_up".',
  ].join("\n");
}

/**
 * The VOLATILE suffix: the current page, the diverged step, the ranked candidates, and the recent
 * action history. NEVER cached — it changes every page. An optional `note` (advisory) is appended.
 */
export function buildPlannerSuffix(ctx: PlannerPageContext, note?: string): string {
  const candidates = ctx.candidates.length
    ? ctx.candidates
        .map((c) => `  [${c.index}] role=${c.role} name=${JSON.stringify(c.name)} score=${c.score}`)
        .join("\n")
    : "  (no interactive candidates)";
  const history = ctx.recent.length
    ? ctx.recent
        .map(
          (a) =>
            `  - ${a.id} (${a.do})${a.intent ? ` → ${a.intent}` : ""}: ${a.ok ? "ok" : "FAILED"}`,
        )
        .join("\n")
    : "  (none)";
  const lines = [
    `CURRENT PAGE: ${ctx.url}`,
    `DIVERGED AT recorded step: ${ctx.divergedStepId} (the page no longer matches it).`,
    "RECENT ACTIONS:",
    history,
    "INTERACTIVE CANDIDATES ON THE CURRENT PAGE:",
    candidates,
  ];
  if (note) lines.push(`NOTE (advisory context only): ${JSON.stringify(note)}`);
  return lines.join("\n");
}

/**
 * Build the full planner prompt as PREFIX + "\n\n" + SUFFIX. Returns both the joined `prompt` and
 * the `prefix` so the caller can pass `cache:{prefix, key:goal}` — the provider marks the prefix
 * cacheable, and the caller can assert the prefix is byte-stable across replans.
 */
export function buildPlannerPrompt(
  goal: string,
  ctx: PlannerPageContext,
  note?: string,
): { prompt: string; prefix: string } {
  const prefix = buildPlannerPrefix(goal);
  const suffix = buildPlannerSuffix(ctx, note);
  return { prompt: `${prefix}\n\n${suffix}`, prefix };
}

// ---------------------------------------------------------------------------
// planRepair — the CHEAP-FIRST default call
// ---------------------------------------------------------------------------

/** Inputs a planner call needs beyond the runtime + goal. */
export interface PlanRepairOpts {
  /** The current-page context (URL, diverged step, candidates, recent actions). */
  page: PlannerPageContext;
  /** The optional advisory note to prepend (unused today; reserved). */
  note?: string;
}

/** The planner's result: the validated plan + which arm produced it. */
export interface PlanRepairResult {
  plan: PlannerPlan;
  /** `"planner"` (cheap default) or `"planner_capable"` (escalated). */
  arm: "planner" | "planner_capable";
}

/**
 * Gather the current page's context for the planner (URL + ranked candidates), building on the
 * SAME `gatherCandidates` spine L2/L3 use. `divergedStep` is the recorded step that no longer fits;
 * its intent seeds the candidate ranking. Returns the page context minus `recent` (the runner
 * supplies the action history).
 */
export async function gatherPlannerPage(
  divergedStep: Step,
  ctx: ResolveContext,
  recent: RecentAction[],
): Promise<PlannerPageContext> {
  const gathered = await gatherCandidates(divergedStep, ctx, { maxResults: 12 });
  return {
    url: gathered.signatureBasis.url,
    divergedStepId: divergedStep.id,
    candidates: buildCandidatePacket(gathered.ranked),
    recent,
  };
}

/**
 * Call the CHEAP planner (`modelRole:"planner"`) for one divergence. Prompt-cached: the stable
 * prefix (goal + vocabulary) is cacheable, keyed on the goal. Budget errors propagate (the runner
 * maps them to `inconclusive`); any other generate failure is re-thrown for the caller to handle.
 */
export async function planRepair(
  rt: AiCallRuntime,
  goal: string,
  opts: PlanRepairOpts,
): Promise<PlanRepairResult> {
  const { prompt, prefix } = buildPlannerPrompt(goal, opts.page, opts.note);
  const res = await aiCall(rt, {
    modelRole: "planner",
    callRole: "planner",
    purpose: `replan:${opts.page.divergedStepId}`,
    schema: PlannerPlanSchema,
    maxOutputTokens: AI_MIN_OUTPUT_TOKENS,
    prompt,
    cache: { prefix, key: goal },
    deriveOutcome: (p) => ({ outcome: p.decision }),
  });
  return { plan: res.output, arm: "planner" };
}

/**
 * Re-issue the plan on the CAPABLE arm (`modelRole:"planner_capable"`) — ESCALATION ONLY (fired by
 * `runner/path-repair.ts` on the low-confidence / repeated-replan signal, NEVER standing).
 *
 *   ⚠️ UNPROVEN. Also runs an OPTIONAL dueling variant: `duel:true` issues TWO capable calls and
 *   keeps the higher-confidence plan (or, when they agree on `decision`, the more confident one).
 *   The dueling arm is likewise UNPROVEN and off by default.
 *
 * The logged `callRole` stays `"planner"` so cost + telemetry attribute both arms to the one planner
 * surface (cost attribution still uses the `planner_capable` model pricing via `modelRole`).
 */
export async function planRepairEscalated(
  rt: AiCallRuntime,
  goal: string,
  opts: PlanRepairOpts & { duel?: boolean },
): Promise<PlanRepairResult> {
  const { prompt, prefix } = buildPlannerPrompt(goal, opts.page, opts.note);
  const call = (): Promise<PlannerPlan> =>
    aiCall(rt, {
      modelRole: "planner_capable",
      callRole: "planner",
      purpose: `replan:${opts.page.divergedStepId}:capable`,
      schema: PlannerPlanSchema,
      maxOutputTokens: AI_MIN_OUTPUT_TOKENS,
      prompt,
      cache: { prefix, key: goal },
      deriveOutcome: (p) => ({ outcome: p.decision }),
    }).then((r) => r.output);

  if (!opts.duel) return { plan: await call(), arm: "planner_capable" };

  // Dueling (UNPROVEN): two capable calls, keep the higher-confidence / agreeing plan.
  const [a, b] = await Promise.all([call(), call()]);
  const winner = pickDuelWinner(a, b);
  return { plan: winner, arm: "planner_capable" };
}

/**
 * Pick the winner of a two-plan duel (UNPROVEN). When both plans AGREE on `decision`, keep the more
 * confident one (ties keep `a`, the first). When they DISAGREE (one `repair`, one `give_up`), prefer
 * the `repair` plan regardless of confidence — bias toward attempting a fix over giving up.
 */
export function pickDuelWinner(a: PlannerPlan, b: PlannerPlan): PlannerPlan {
  if (a.decision === b.decision) return b.confidence > a.confidence ? b : a;
  return a.decision === "repair" ? a : b;
}

/**
 * Should the cheap arm's plan escalate to the capable arm? The low-confidence signal (confidence at
 * or below {@link PLANNER_ESCALATE_CONFIDENCE}) OR the repeated-replan signal (this is at least the
 * {@link PLANNER_ESCALATE_ATTEMPTS}-th attempt for the SAME divergence). UNPROVEN — tuned in the
 * field. `escalateConfidence` overrides the default threshold (from `[plan].escalate_confidence`).
 */
export function shouldEscalate(
  plan: PlannerPlan,
  attemptNumber: number,
  escalateConfidence: number = PLANNER_ESCALATE_CONFIDENCE,
  escalateAttempts: number = PLANNER_ESCALATE_ATTEMPTS,
): boolean {
  return plan.confidence <= escalateConfidence || attemptNumber >= escalateAttempts;
}

/** Re-export so the runner can guard planner calls without importing budget.ts directly. */
export { isBudgetExceeded };
