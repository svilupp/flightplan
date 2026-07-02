// Flightplan — L5 path-repair planner UNIT tests (PLAN_v003 v003-6, OFFLINE + SDK-free).
//
// These exercise the planner MODULE (`ai/planner-l5.ts`) in isolation — the prompt builder + the
// decision/threshold logic + the proposed-step validation — with no runner, no MockDriver, and no
// `generate` seam. The end-to-end wiring (divergence → cheap repair → escalation → budget stop →
// inert-without-runtime) lives in `runner/runner.path-repair.test.ts`.
//
// Coverage:
//   - buildPlannerPrompt: the STABLE PREFIX (goal + instructions) is byte-identical across two
//     different page contexts with the SAME goal, and CHANGES when the goal changes; the volatile
//     suffix carries the page-specific candidates/history.
//   - shouldEscalate: confidence at/below PLANNER_ESCALATE_CONFIDENCE OR attempt ≥
//     PLANNER_ESCALATE_ATTEMPTS triggers escalation; a confident early attempt does not.
//   - usableRepairSteps (proposed-step validation vs PLANNER_STEP_DOS/StepSchema): a valid `repair`
//     plan yields id-namespaced steps; a `give_up` plan yields none; a proposal missing a
//     verb-required field is dropped.

import { describe, expect, test } from "bun:test";
import type { Step } from "../flow/types.ts";
import { usableRepairSteps } from "../runner/path-repair.ts";
import {
  buildPlannerPrompt,
  PLANNER_ESCALATE_ATTEMPTS,
  PLANNER_ESCALATE_CONFIDENCE,
  type PlannerPageContext,
  pickDuelWinner,
  shouldEscalate,
} from "./planner-l5.ts";
import type { PlannerPlan } from "./schemas.ts";
import { PLANNER_STEP_DOS } from "./schemas.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A page context. `overrides` tweak url / diverged step / candidates / history per test. */
function pageCtx(overrides: Partial<PlannerPageContext> = {}): PlannerPageContext {
  return {
    url: "http://localhost:3000/checkout",
    divergedStepId: "submit",
    candidates: [{ index: 0, role: "button", name: "Continue", score: 0.42 }],
    recent: [{ id: "fill-email", do: "fill", intent: "email field", ok: true }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildPlannerPrompt — stable cacheable prefix + volatile suffix
// ---------------------------------------------------------------------------

describe("buildPlannerPrompt — cacheable prefix vs volatile suffix", () => {
  test("the prefix is BYTE-IDENTICAL for two different page contexts with the same goal", () => {
    const goal = "Complete checkout";

    const a = buildPlannerPrompt(
      goal,
      pageCtx({
        url: "http://localhost:3000/checkout",
        divergedStepId: "submit",
        candidates: [{ index: 0, role: "button", name: "Continue", score: 0.42 }],
        recent: [{ id: "fill-email", do: "fill", ok: true }],
      }),
    );
    const b = buildPlannerPrompt(
      goal,
      pageCtx({
        url: "http://localhost:3000/review", // different page
        divergedStepId: "confirm", // different diverged step
        candidates: [{ index: 0, role: "link", name: "Place order", score: 0.9 }], // different candidates
        recent: [{ id: "click-next", do: "click", ok: false }], // different history
      }),
    );

    // The cacheable prefix (goal + instructions) is byte-stable across page changes → the provider
    // reuses one cached prefix across replans in a run (prompt-caching invariant, PLAN_v003 v003-6).
    expect(a.prefix).toBe(b.prefix);
    // The prefix anchors on the goal + the step vocabulary.
    expect(a.prefix).toContain(JSON.stringify(goal));
    for (const verb of PLANNER_STEP_DOS) expect(a.prefix).toContain(verb);

    // But the full prompts DIFFER — the volatile suffix carries the page-specific state.
    expect(a.prompt).not.toBe(b.prompt);
    expect(a.prompt.startsWith(a.prefix)).toBe(true);
    expect(a.prompt).toContain("http://localhost:3000/checkout");
    expect(b.prompt).toContain("http://localhost:3000/review");
    expect(a.prompt).toContain("Continue");
    expect(b.prompt).toContain("Place order");
  });

  test("the prefix CHANGES when the goal changes (cache key is the goal)", () => {
    const ctx = pageCtx();
    const a = buildPlannerPrompt("Complete checkout", ctx);
    const b = buildPlannerPrompt("Cancel the subscription", ctx);
    expect(a.prefix).not.toBe(b.prefix);
    expect(a.prefix).toContain(JSON.stringify("Complete checkout"));
    expect(b.prefix).toContain(JSON.stringify("Cancel the subscription"));
  });

  test("the volatile suffix reflects candidates + history; an empty page renders placeholders", () => {
    const empty = buildPlannerPrompt("Complete checkout", pageCtx({ candidates: [], recent: [] }));
    expect(empty.prompt).toContain("(no interactive candidates)");
    expect(empty.prompt).toContain("(none)");
    // The prefix is still byte-identical to a populated page's prefix (same goal).
    const full = buildPlannerPrompt("Complete checkout", pageCtx());
    expect(empty.prefix).toBe(full.prefix);
  });
});

// ---------------------------------------------------------------------------
// shouldEscalate — the low-confidence / repeated-replan escalation signal
// ---------------------------------------------------------------------------

describe("shouldEscalate — confidence + attempt thresholds", () => {
  const repair = (confidence: number): PlannerPlan => ({
    decision: "repair",
    confidence,
    steps: [{ do: "click", target: "Continue" }],
  });

  test("a CONFIDENT plan on the first attempt does NOT escalate", () => {
    expect(shouldEscalate(repair(0.9), 1)).toBe(false);
  });

  test("confidence AT the threshold escalates (`<=` is inclusive)", () => {
    expect(shouldEscalate(repair(PLANNER_ESCALATE_CONFIDENCE), 1)).toBe(true);
  });

  test("confidence BELOW the threshold escalates", () => {
    expect(shouldEscalate(repair(PLANNER_ESCALATE_CONFIDENCE - 0.2), 1)).toBe(true);
  });

  test("a confident plan escalates once the attempt count reaches PLANNER_ESCALATE_ATTEMPTS", () => {
    // Confident but this is the repeated-replan signal (Nth attempt for the SAME divergence).
    expect(shouldEscalate(repair(0.99), PLANNER_ESCALATE_ATTEMPTS)).toBe(true);
    // Just under the attempt bar, still confident → no escalation.
    expect(shouldEscalate(repair(0.99), PLANNER_ESCALATE_ATTEMPTS - 1)).toBe(false);
  });

  test("caller-supplied overrides replace the default thresholds", () => {
    // A stricter confidence bar escalates a plan the default would have kept.
    expect(shouldEscalate(repair(0.7), 1, 0.8)).toBe(true);
    // A laxer attempt bar keeps a plan the default would have escalated on attempts.
    expect(shouldEscalate(repair(0.99), 2, 0.5, 5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pickDuelWinner — the dueling capable-arm tie-break (UNPROVEN)
// ---------------------------------------------------------------------------

describe("pickDuelWinner — agreement keeps the more confident, disagreement prefers repair", () => {
  const repair = (confidence: number): PlannerPlan => ({
    decision: "repair",
    confidence,
    steps: [{ do: "click", target: "Continue" }],
  });
  const giveUp = (confidence: number): PlannerPlan => ({ decision: "give_up", confidence });

  test("AGREEMENT: both repair → keep the more confident plan", () => {
    const a = repair(0.6);
    const b = repair(0.9);
    expect(pickDuelWinner(a, b)).toBe(b);
    expect(pickDuelWinner(b, a)).toBe(b);
  });

  test("AGREEMENT: both give_up → keep the more confident plan", () => {
    const a = giveUp(0.4);
    const b = giveUp(0.7);
    expect(pickDuelWinner(a, b)).toBe(b);
    expect(pickDuelWinner(b, a)).toBe(b);
  });

  test("AGREEMENT: an exact confidence tie keeps the first plan", () => {
    const a = repair(0.7);
    const b = repair(0.7);
    expect(pickDuelWinner(a, b)).toBe(a);
  });

  test("DISAGREEMENT: prefer repair over give_up even when give_up is more confident", () => {
    const rep = repair(0.3);
    const give = giveUp(0.99);
    expect(pickDuelWinner(rep, give)).toBe(rep);
    expect(pickDuelWinner(give, rep)).toBe(rep);
  });
});

// ---------------------------------------------------------------------------
// usableRepairSteps — proposed-step validation against PLANNER_STEP_DOS / StepSchema
// ---------------------------------------------------------------------------

describe("usableRepairSteps — proposed-step validation + id namespacing", () => {
  test("a `repair` plan yields validated, id-namespaced Steps (<divergedId>:repair:<n>.<i>)", () => {
    const plan: PlannerPlan = {
      decision: "repair",
      confidence: 0.9,
      steps: [
        { do: "click", target: "Continue" },
        { do: "fill", target: "Email", value: "a@b.co" },
        { do: "goto", url: "http://localhost:3000/next" },
      ],
    };
    const steps = usableRepairSteps(plan, "submit", 1);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.id)).toEqual([
      "submit:repair:1.0",
      "submit:repair:1.1",
      "submit:repair:1.2",
    ]);
    expect(steps.map((s) => s.do)).toEqual(["click", "fill", "goto"]);
    // Each is a real, StepSchema-valid Step (the verb-specific fields survived).
    const fill = steps[1] as Extract<Step, { do: "fill" }>;
    expect(fill.target).toBe("Email");
    expect(fill.value).toBe("a@b.co");
  });

  test("a `give_up` plan yields NO steps", () => {
    const plan: PlannerPlan = { decision: "give_up", confidence: 0.1 };
    expect(usableRepairSteps(plan, "submit", 1)).toEqual([]);
  });

  test("a proposal missing a verb-required field is DROPPED, valid siblings survive", () => {
    const plan: PlannerPlan = {
      decision: "repair",
      confidence: 0.9,
      steps: [
        { do: "goto" }, // missing `url` → dropped
        { do: "fill", target: "Email" }, // missing `value` → dropped
        { do: "press", key: "Enter" }, // valid
        { do: "click", target: "Save" }, // valid
      ],
    };
    const steps = usableRepairSteps(plan, "submit", 2);
    expect(steps.map((s) => s.do)).toEqual(["press", "click"]);
    // Ids reflect the ORIGINAL index in the proposed list (dropped entries leave gaps).
    expect(steps.map((s) => s.id)).toEqual(["submit:repair:2.2", "submit:repair:2.3"]);
  });

  test("only the PLANNER_STEP_DOS vocabulary is proposable (schema-typed at the source)", () => {
    // PLANNER_STEP_DOS is the exact proposable set; each maps to a shapeable full Step.
    expect([...PLANNER_STEP_DOS].sort()).toEqual(["click", "fill", "goto", "press", "select"]);
  });
});
