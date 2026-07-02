// Flightplan — fixture factories for MockDriver scripting.
//
// Convenience builders so ladder/lock/assert tests can construct canned `PageSnapshot` /
// `StepResult` / `BatchResult` values with minimal boilerplate. All fields the escalation
// ladder cares about (`selectorUsed`, `failureReason`, `coveringElement`,
// `interactiveElements`) are first-class parameters here.

import type {
  BatchResult,
  CoveringElement,
  FailureReason,
  InteractiveElement,
  PageSnapshot,
  RankedCandidate,
  StepResult,
} from "./types.ts";

/**
 * Build an interactive element (role + accessible name + optional state/attrs). Since
 * browser-pilot 0.1.0 (Phase 7 Change 3a) the shape carries an optional
 * `attributes?: Record<string,string>` — pass it here to simulate real DOM attributes, e.g.
 * `makeInteractiveElement({ ref:'e1', role:'button', name:'Save', attributes:{ 'data-testid':'save' } })`.
 * Remember the MockDriver only RETURNS attributes when `snapshot({ attributes:true })` is asked.
 */
export function makeInteractiveElement(
  partial: Partial<InteractiveElement> & Pick<InteractiveElement, "ref" | "role" | "name">,
): InteractiveElement {
  return {
    selector: `[data-backend-node-id="${partial.ref.replace(/^e/, "")}"]`,
    ...partial,
  };
}

/**
 * Build a `RankedCandidate` (the shape `Driver.resolveAll` returns — Phase 7 Change 3).
 * Defaults a `role_name` strategy, a `role:Role:Name` selector, and a perfect score so a test
 * only needs to pass `role` + `name`.
 */
export function makeRankedCandidate(
  partial: Partial<RankedCandidate> & Pick<RankedCandidate, "role" | "name">,
): RankedCandidate {
  return {
    selector: `role:${partial.role}:${partial.name}`,
    strategy: "role_name",
    score: 1,
    ...partial,
  };
}

/** Build a `PageSnapshot`. `interactiveElements` defaults to `[]`. */
export function makeSnapshot(partial: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: partial.url ?? "http://localhost:3000/",
    title: partial.title ?? "",
    timestamp: partial.timestamp ?? new Date(0).toISOString(),
    accessibilityTree: partial.accessibilityTree ?? [],
    interactiveElements: partial.interactiveElements ?? [],
    text: partial.text ?? "",
  };
}

/**
 * Build a `StepResult`. `success` defaults to `true`. Pass `selectorUsed` to simulate a
 * winning strategy, or `failureReason`/`coveringElement` to simulate a failure for the
 * escalation/auto-repair branches.
 */
export function makeStepResult(partial: Partial<StepResult> = {}): StepResult {
  const success = partial.success ?? partial.failureReason === undefined;
  return {
    action: partial.action ?? "click",
    index: partial.index ?? 0,
    durationMs: partial.durationMs ?? 0,
    success,
    ...partial,
  };
}

/** A successful single-step batch whose only step used `selectorUsed`. */
export function makeSuccessBatch(
  selectorUsed: string,
  action: StepResult["action"] = "click",
): BatchResult {
  return makeBatchResult([
    makeStepResult({ action, selectorUsed, success: true, outcomeStatus: "success" }),
  ]);
}

/**
 * A failing single-step batch with a `failureReason` (and optional `coveringElement`) — the
 * shape ladder/auto-repair tests assert against ("all strategies fail with reason=covered").
 */
export function makeFailureBatch(
  failureReason: FailureReason,
  opts: { coveringElement?: CoveringElement; action?: StepResult["action"] } = {},
): BatchResult {
  return makeBatchResult(
    [
      makeStepResult({
        action: opts.action ?? "click",
        success: false,
        outcomeStatus: "failed",
        failureReason,
        ...(opts.coveringElement ? { coveringElement: opts.coveringElement } : {}),
      }),
    ],
    false,
  );
}

/** Wrap a list of step results into a `BatchResult`. `success` defaults to all-steps-passed. */
export function makeBatchResult(steps: StepResult[], success?: boolean): BatchResult {
  return {
    steps,
    success: success ?? steps.every((s) => s.success),
    totalDurationMs: steps.reduce((acc, s) => acc + (s.durationMs ?? 0), 0),
  };
}
