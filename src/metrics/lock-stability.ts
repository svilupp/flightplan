// Flightplan — Phase 6 lock byte-stability checker (Unit D).
//
// The P6 exit criterion "locks are stable (no churn) across repeated green runs" is measured by
// hashing the lock bytes BEFORE and AFTER a run and asserting they are unchanged. A second,
// stronger cross-check encodes the write policy (PLAN.md §3/§8): on a clean run
// (`drift_count == 0` ∧ `verdict == "passed"`) the runner must NOT write the lock at all, so any
// byte change there is a churn bug (`contractViolation`).
//
// This is offline + deterministic: callers read the lock file's bytes around a run and pass them
// in. We never touch the lock writer — we only measure its output.

import { createHash } from "node:crypto";

import type { RunVerdict } from "../types.ts";
import type { StabilityResult } from "./types.ts";

/** sha256 of the given bytes (or UTF-8 string), as a lowercase hex digest. */
export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Inputs to {@link checkLockStability}; a null `before`/`after` means "no lock file existed". */
export interface LockStabilityInput {
  /** The lock bytes (or text) captured before the run; null when no lock existed yet. */
  before: Uint8Array | string | null;
  /** The lock bytes (or text) captured after the run; null when no lock exists. */
  after: Uint8Array | string | null;
  /** The run's `drift_count` (`run_end.totals.drift_count`). */
  driftCount: number;
  /** The run's verdict. */
  verdict: RunVerdict;
}

/**
 * Compare lock bytes around a run. `stable` is true when the hashes match (or both sides had no
 * lock). The write-policy cross-check flags a `contractViolation` when a clean green run
 * (`drift_count==0` ∧ passed) nonetheless changed the lock bytes.
 */
export function checkLockStability(input: LockStabilityInput): StabilityResult {
  const beforeHash = input.before === null ? null : sha256(input.before);
  const afterHash = input.after === null ? null : sha256(input.after);
  const stable = beforeHash === afterHash;
  const expectedNoWrite = input.driftCount === 0 && input.verdict === "passed";
  return {
    stable,
    beforeHash,
    afterHash,
    driftCount: input.driftCount,
    verdict: input.verdict,
    expectedNoWrite,
    contractViolation: expectedNoWrite && !stable,
  };
}
