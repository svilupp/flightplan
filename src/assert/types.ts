// Flightplan — assertion engine types.
//
// The deterministic assertion engine is Flightplan's strict validation oracle: it NEVER
// heals (PLAN.md philosophy §3 — "Steps self-heal; assertions validate"). It evaluates the
// six deterministic assertion types (`visible`/`hidden`/`text`/`url`/`value`/`count`) against
// the live page by polling the `Driver` snapshot until the condition holds or a per-assertion
// deadline elapses. `ai_judge` is Phase 4 — it is present in the type switch but routes to a
// stub that throws a clearly-marked "Phase 4" error (so the P2 runner can detect + skip it).
//
// Canonical references: PLAN.md §4 (Assertion / RunLimits) and §5 Phase 2 (assert/).

import type { Driver } from "../driver/types.ts";
import type { Assertion } from "../flow/types.ts";
import type { AssertType } from "../types.ts";

// ---------------------------------------------------------------------------
// Clock — the injectable time/sleep seam (tests MUST NOT actually sleep)
// ---------------------------------------------------------------------------

/**
 * The clock abstraction used by the polling loop. Real runs use {@link systemClock}
 * (wall-clock `Date.now` + a `setTimeout`-backed sleep). Tests inject a {@link FakeClock}
 * (see `clock.ts`) so polling deadlines advance instantly and deterministically — no test
 * ever waits real milliseconds.
 *
 * Named `AssertClock` (not `Clock`) to avoid colliding with `artifacts/`'s `Clock`
 * (`() => number`) under the root barrel's `export *`.
 */
export interface AssertClock {
  /** Current time in milliseconds (monotonic enough for deadline math). */
  now(): number;
  /** Resolve after (at least) `ms` milliseconds of clock time. */
  sleep(ms: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// AssertionResult — what every evaluator returns
// ---------------------------------------------------------------------------

/**
 * The outcome of evaluating a single assertion. `pass` is the only verdict the runner keys
 * its fail/heal decision on; `message` is a human-readable explanation (expected-vs-observed
 * on failure). `durationMs` is measured against the injected clock (so it is 0-ish under a
 * fake clock unless the test advances it). `when` records which phase the assertion ran in;
 * `selectorOrTarget` echoes the assertion's `selector`/`url`/expected target for reporting.
 */
export interface AssertionResult {
  type: AssertType;
  pass: boolean;
  message: string;
  durationMs: number;
  when: AssertPhase;
  /** The selector/url/target the assertion checked (for the run summary + `explain`). */
  selectorOrTarget?: string;
  /** The stable purpose used by the runner for reporting/rescue selection. */
  purpose?: "precondition" | "postcondition";
  /** A redaction-safe observed value when the evaluator has one. */
  observed?: string;
}

// ---------------------------------------------------------------------------
// AssertContext — resolved config the engine evaluates against
// ---------------------------------------------------------------------------

/** The phase an assertion runs in (mirrors flow `Assertion.when`; default 'after'). */
export type AssertPhase = "before" | "after";

/**
 * The resolved configuration the engine carries through a run, assembled by the runner from
 * `RunLimits` (PLAN.md §4):
 *  - `driver` — the page boundary every evaluator polls (`MockDriver` in unit tests).
 *  - `defaultTimeoutMs` — the per-assertion fallback deadline (`RunLimits.assert_timeout_ms`).
 *    An assertion's own `timeout_ms` overrides this.
 *  - `mode` — `eager` (stop at the first failure within a phase) vs `deferred` (evaluate ALL,
 *    collect every failure). See `engine.ts` `runAssertions` for the precise interaction with
 *    `failOnAssertion`.
 *  - `failOnAssertion` — whether a failed assertion should fail the run. The engine only
 *    REPORTS results; the runner consults this flag to decide the run verdict. The engine uses
 *    it ONLY to pick eager fail-fast behaviour (see `runAssertions`).
 *  - `clock` — injectable time source. Omitted → the engine uses the real `systemClock`.
 *  - `pollIntervalMs` — the fixed poll interval (default `DEFAULT_POLL_INTERVAL_MS`).
 */
export interface AssertContext {
  driver: Driver;
  defaultTimeoutMs: number;
  mode: "eager" | "deferred";
  failOnAssertion: boolean;
  clock?: AssertClock;
  pollIntervalMs?: number;
  /**
   * Optional `ai_judge` evaluator (Phase 4). When present, the engine ROUTES an `ai_judge`
   * assertion to it instead of throwing {@link Phase4NotImplementedError}; when absent (AI-less
   * runs), behavior is unchanged. The AI runtime (`ai/runtime.ts` `createAiRuntime().judge`)
   * supplies this; `ai/` implements it, `assert/` only declares the seam (no `ai/` import here →
   * no dependency cycle). The injected oracle NEVER heals — it returns a pass/fail result.
   */
  aiJudge?: (assertion: Assertion, opts: AiJudgeOptions) => Promise<AssertionResult>;
  /**
   * Optional current step id, threaded by the runner so `ai_judge` calls can label their
   * `purpose` as `judge:<stepId>` (PLAN.md §5 Phase 4). Additive + optional — AI-less runs and
   * existing tests omit it.
   */
  stepId?: string;
  /** Runtime captures available to transition assertions and dynamic templates. */
  captures?: Record<string, string>;
  /** Structured result returned by the current WebMCP call, when applicable. */
  actionResult?: unknown;
  /** Before-state captured immediately before the step action. */
  beforeState?: {
    url?: string;
    text?: string;
    values?: Record<string, string | null>;
    states?: Record<string, string>;
  };
}

/**
 * Options the engine hands to a routed {@link AssertContext.aiJudge} call. Carries the page
 * boundary the judge reads (snapshot / screenshot), the resolved per-assertion deadline, and the
 * step id (for the `ai_call` purpose label). Defined in `assert/` so `ai/` implements against
 * this shape without `assert/` ever importing `ai/`.
 */
export interface AiJudgeOptions {
  driver: Driver;
  /** The effective deadline for this assertion (assertion `timeout_ms` ?? default). */
  timeoutMs: number;
  /** The step the assertion is attached to (for the `ai_call` purpose), when known. */
  stepId?: string;
  /** The phase the assertion runs in (stamped onto the returned result). */
  when?: AssertPhase;
}

/**
 * The per-evaluator options derived from an `AssertContext` + a single assertion. This is
 * what the condition functions in `conditions.ts` accept: a fully-resolved deadline + the
 * driver + clock, with no knowledge of flow/config types.
 */
export interface ConditionOpts {
  driver: Driver;
  /** The effective deadline for THIS assertion (assertion `timeout_ms` ?? default). */
  timeoutMs: number;
  /** The fixed interval between polls. */
  pollIntervalMs: number;
  /** Injected clock (defaults to the real system clock at the call site). */
  clock: AssertClock;
  /** Runtime captures available to transition assertions. */
  captures?: Record<string, string>;
  /** Structured result returned by the current WebMCP call, when applicable. */
  actionResult?: unknown;
  /** State observed immediately before the step action. */
  beforeState?: AssertContext["beforeState"];
}
