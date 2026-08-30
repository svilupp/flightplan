// Flightplan — the assertion engine (dispatch + phase/eager/deferred orchestration).
//
// `runAssertion` evaluates ONE assertion (resolving its effective timeout + routing on `type`).
// `runAssertions` runs the subset for a phase ('before'/'after'), honouring eager vs deferred.
// The engine only REPORTS results — it never decides the run verdict and never heals. The
// runner (Phase 2 `ladder/` orchestrator, not in this module) consults `failOnAssertion` to
// turn results into a verdict. See the eager/deferred × fail_on_assertion × when table below.
//
// ---------------------------------------------------------------------------------------
// How `when` × `mode` (eager|deferred) × `failOnAssertion` interact
// ---------------------------------------------------------------------------------------
// `when` (filtering) — `runAssertions(assertions, ctx, phase)` evaluates ONLY assertions whose
//   resolved `when` equals `phase`. An assertion with no `when` defaults to 'after'. So the
//   before-phase call runs the (usually few) precondition checks; the after-phase call runs the
//   validation checks. The two phases are independent invocations.
//
// `mode` (within ONE phase) —
//   - eager:    evaluate assertions in order; STOP at the first failure. The returned array has
//               the results up to and including that first failure (later same-phase assertions
//               are NOT evaluated). This is the cheap fail-fast path.
//   - deferred: evaluate ALL assertions in the phase regardless of failures; collect every
//               result (so the report lists every failure, not just the first).
//
// `failOnAssertion` (the runner's verdict policy; the engine does NOT apply it itself) —
//   - The engine ALWAYS returns the full result list; `pass:false` entries are failures.
//   - eager  + failOnAssertion=true  → first failure short-circuits the phase; the runner sees a
//     failing result and ABORTS the run at that point (fail-fast).
//   - eager  + failOnAssertion=false → still short-circuits evaluation (eager is about
//     evaluation cost), but the runner treats failures as non-fatal warnings and continues.
//   - deferred + failOnAssertion=true → the runner collects ALL failures, then fails the run at
//     the END if ANY assertion failed.
//   - deferred + failOnAssertion=false → all evaluated; failures reported as warnings; run
//     continues.
//   NOTE: `mode` controls *how many* assertions are evaluated; `failOnAssertion` controls
//   *whether a failure fails the run*. They are orthogonal. The engine encodes only the first;
//   the runner encodes the second. `runAssertions` accepts `failOnAssertion` via the ctx purely
//   so a future fail-fast-across-phases policy can read it — current behaviour keys eager
//   short-circuit on `mode` alone, which is the documented + tested contract.

import type { Assertion } from "../flow/types.ts";
import { DEFAULT_POLL_INTERVAL_MS, systemClock } from "./clock.ts";
import { evaluateDeterministic } from "./conditions.ts";
import type { AssertContext, AssertionResult, AssertPhase, ConditionOpts } from "./types.ts";

/** The default per-assertion timeout when neither the assertion nor `RunLimits` set one. */
export const DEFAULT_ASSERT_TIMEOUT_MS = 5000;

/**
 * The marker error thrown when an `ai_judge` assertion is evaluated in Phase 2. `ai_judge` is
 * implemented in Phase 4 (vision/text routing). The runner detects this error (via
 * {@link isPhase4NotImplemented}) and skips-with-message rather than crashing the run.
 */
export class Phase4NotImplementedError extends Error {
  readonly assertionType = "ai_judge" as const;
  constructor() {
    super("ai_judge assertions are implemented in Phase 4 (not available in Phase 2)");
    this.name = "Phase4NotImplementedError";
  }
}

/** Type guard the runner uses to detect the `ai_judge` Phase-4 stub and skip-with-message. */
export function isPhase4NotImplemented(err: unknown): err is Phase4NotImplementedError {
  return err instanceof Phase4NotImplementedError;
}

/** Resolve the per-assertion condition options from the context + this assertion's overrides. */
function resolveConditionOpts(assertion: Assertion, ctx: AssertContext): ConditionOpts {
  const timeoutMs = assertion.timeout_ms ?? ctx.defaultTimeoutMs;
  return {
    driver: ctx.driver,
    timeoutMs,
    pollIntervalMs: ctx.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    clock: ctx.clock ?? systemClock,
    ...(ctx.captures ? { captures: ctx.captures } : {}),
    ...(ctx.actionResult !== undefined ? { actionResult: ctx.actionResult } : {}),
    ...(ctx.beforeState ? { beforeState: ctx.beforeState } : {}),
  };
}

/** The resolved phase of an assertion (`when` defaults to 'after'). */
export function assertionPhase(assertion: Assertion): AssertPhase {
  return assertion.when ?? (assertion.purpose === "precondition" ? "before" : "after");
}

/** Resolve an assertion's purpose without making authors repeat the common phase mapping. */
export function assertionPurpose(assertion: Assertion): "precondition" | "postcondition" {
  return (
    assertion.purpose ?? (assertionPhase(assertion) === "before" ? "precondition" : "postcondition")
  );
}

/**
 * Evaluate ONE assertion. Resolves the effective timeout (`assertion.timeout_ms ??
 * RunLimits.assert_timeout_ms`), dispatches on `assertion.type`, and stamps the resolved
 * `when` phase onto the result. `ai_judge` routes to the Phase-4 stub: it throws a
 * {@link Phase4NotImplementedError} (clearly marked — NEVER silently passes), which the runner
 * catches to skip-with-message.
 */
export async function runAssertion(
  assertion: Assertion,
  ctx: AssertContext,
): Promise<AssertionResult> {
  if (assertion.type === "ai_judge") {
    // Phase 4: route to the injected AI oracle when present; otherwise keep the Phase-2 stub so
    // AI-less runs are unchanged. The oracle returns a pass/fail AssertionResult; it NEVER heals.
    if (ctx.aiJudge) {
      const phase = assertionPhase(assertion);
      const result = await ctx.aiJudge(assertion, {
        driver: ctx.driver,
        timeoutMs: assertion.timeout_ms ?? ctx.defaultTimeoutMs,
        when: phase,
        ...(ctx.stepId !== undefined ? { stepId: ctx.stepId } : {}),
      });
      result.when = phase;
      result.purpose = assertionPurpose(assertion);
      return result;
    }
    throw new Phase4NotImplementedError();
  }
  const opts = resolveConditionOpts(assertion, ctx);
  const result = await evaluateDeterministic(assertion, opts);
  // Stamp the resolved phase (the evaluator defaults it to 'after').
  result.when = assertionPhase(assertion);
  result.purpose = assertionPurpose(assertion);
  return result;
}

/**
 * Run all assertions for a given `phase` ('before' | 'after'), honouring eager vs deferred.
 * Returns ALL results produced (the runner decides fail-fast from `failOnAssertion`).
 *
 *  - Filters to assertions whose resolved `when` === `phase`.
 *  - eager:    stops evaluating at the first failing result (the returned array ends at that
 *              failure). Useful so a failed precondition doesn't burn the remaining timeouts.
 *  - deferred: evaluates every assertion in the phase; collects every result.
 *
 * `ai_judge` in the phase: its Phase-4 marker is caught here and converted into a clearly-marked
 * failing `AssertionResult` (pass:false, message names Phase 4) so the batch does not throw and
 * the runner can surface it. It counts as a failure for eager short-circuit purposes.
 */
export async function runAssertions(
  assertions: readonly Assertion[],
  ctx: AssertContext,
  phase: AssertPhase,
): Promise<AssertionResult[]> {
  const inPhase = assertions.filter((a) => assertionPhase(a) === phase);
  const results: AssertionResult[] = [];

  for (const assertion of inPhase) {
    let result: AssertionResult;
    try {
      result = await runAssertion(assertion, ctx);
    } catch (err) {
      if (isPhase4NotImplemented(err)) {
        result = {
          type: "ai_judge",
          pass: false,
          message: err.message,
          durationMs: 0,
          when: phase,
        };
      } else {
        throw err;
      }
    }
    results.push(result);
    if (ctx.mode === "eager" && !result.pass) break;
  }

  return results;
}
