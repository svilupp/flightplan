// Flightplan — normalize optional browser-pilot dispatch metadata.
//
// The pinned browser-pilot package predates dispatch receipts, while paired local development may
// expose them. Keep the compatibility seam here: callers always get fail-closed metadata after a
// batch was attempted, and newer fields pass through unchanged.

import type { BatchResult, StepResult } from "./types.ts";

/**
 * Add the minimum safe metadata to a browser-pilot batch result.
 *
 * A successful result proves that an action completed, so it is marked dispatched. A failed result
 * is deliberately marked uncertain when the browser-pilot release did not say otherwise: the page
 * may have accepted input before transport/reporting failed, and replaying it would be unsafe.
 */
export function normalizeBatchResult(result: BatchResult): BatchResult {
  if (result.steps.length === 0) return result;

  const steps = result.steps.map((step) => normalizeStepResult(step));
  return { ...result, steps };
}

function normalizeStepResult(step: StepResult): StepResult {
  const dispatchState = step.dispatchState ?? (step.success ? "dispatched" : "uncertain");
  const retrySafe = step.retrySafe ?? dispatchState === "not_dispatched";
  const attempts = step.attempts ?? 1;
  const retryDecisionReason =
    step.retryDecisionReason ??
    (dispatchState === "uncertain" ? "missing_retry_metadata" : undefined);
  const retryReason = step.retryReason ?? retryDecisionReason;
  const receipt =
    step.receipt ??
    ({
      dispatchState,
      retrySafe,
      inputEventsSent: [],
      attempts,
      ...(retryDecisionReason !== undefined ? { retryDecisionReason } : {}),
      ...(retryReason !== undefined ? { retryReason } : {}),
    } satisfies NonNullable<StepResult["receipt"]>);

  return {
    ...step,
    dispatchState,
    retrySafe,
    attempts,
    ...(retryDecisionReason !== undefined ? { retryDecisionReason } : {}),
    ...(retryReason !== undefined ? { retryReason } : {}),
    receipt,
  };
}
