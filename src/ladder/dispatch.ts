// Flightplan — the single ladder dispatch owner.
//
// Resolution code may inspect snapshots, rank candidates, and apply policy. It must not call the
// browser until that work is complete. Every ladder action funnels through this helper so a tier
// cannot accidentally re-dispatch after an uncertain result.

import { normalizeBatchResult } from "../driver/dispatch-metadata.ts";
import type { BatchOptions, BatchResult, BatchStep, Driver, StepResult } from "../driver/index.ts";
import type { ActionReceipt, DispatchState, RetryDecisionReason } from "../driver/types.ts";

export interface DispatchPolicy {
  allowed: boolean;
  reason?: string;
}

export interface DispatchResult {
  result?: BatchResult;
  stepResult?: StepResult;
  dispatchState: DispatchState;
  retrySafe: boolean;
  attempts: number;
  retryDecisionReason?: RetryDecisionReason;
  retryReason?: string;
  receipt: ActionReceipt;
}

/**
 * Dispatch one already-resolved batch step, or return a pre-dispatch veto without touching the
 * driver. A batch with no step result is uncertain because the driver was called but could not
 * provide enough evidence to prove that no input reached the page.
 */
export async function dispatchResolved(
  driver: Driver,
  steps: [BatchStep],
  opts: BatchOptions | undefined,
  policy: DispatchPolicy = { allowed: true },
): Promise<DispatchResult> {
  if (!policy.allowed) {
    const retryReason = policy.reason ?? "dispatch vetoed before browser input";
    const retryDecisionReason: RetryDecisionReason = "retry_unsafe";
    const receipt: ActionReceipt = {
      dispatchState: "not_dispatched",
      retrySafe: true,
      inputEventsSent: [],
      attempts: 0,
      retryDecisionReason,
      retryReason,
    };
    return {
      dispatchState: "not_dispatched",
      retrySafe: true,
      attempts: 0,
      retryDecisionReason,
      retryReason,
      receipt,
    };
  }

  const result = normalizeBatchResult(await driver.batch(steps, opts));
  const stepResult = result.steps[0];

  if (!stepResult) {
    const retryReason = "driver returned no step result after dispatch was attempted";
    const retryDecisionReason: RetryDecisionReason = "missing_retry_metadata";
    const receipt: ActionReceipt = {
      dispatchState: "uncertain",
      retrySafe: false,
      inputEventsSent: [],
      attempts: 1,
      retryDecisionReason,
      retryReason,
    };
    return {
      result,
      dispatchState: "uncertain",
      retrySafe: false,
      attempts: 1,
      retryDecisionReason,
      retryReason,
      receipt,
    };
  }

  const dispatchState =
    stepResult.dispatchState ?? (stepResult.success ? "dispatched" : "uncertain");
  const retrySafe = stepResult.retrySafe ?? false;
  const attempts = stepResult.attempts ?? 1;
  const retryDecisionReason = stepResult.retryDecisionReason;
  const retryReason = stepResult.retryReason ?? retryDecisionReason;
  return {
    result,
    stepResult,
    dispatchState,
    retrySafe,
    attempts,
    ...(retryDecisionReason !== undefined ? { retryDecisionReason } : {}),
    ...(retryReason !== undefined ? { retryReason } : {}),
    receipt: stepResult.receipt ?? {
      dispatchState,
      retrySafe,
      inputEventsSent: [],
      attempts,
      ...(retryDecisionReason !== undefined ? { retryDecisionReason } : {}),
      ...(retryReason !== undefined ? { retryReason } : {}),
    },
  };
}

/** Whether a result crossed the effect boundary and must not be replayed automatically. */
export function mayHaveDispatched(state: DispatchState | undefined): boolean {
  return state === "dispatched" || state === "uncertain";
}
