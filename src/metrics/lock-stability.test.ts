// Lock byte-stability tests (Unit D). Identical bytes ⇒ stable; a one-byte diff ⇒ churn flagged;
// the write-policy cross-check (drift 0 ∧ passed ⇒ no write expected) catches unexpected churn.

import { describe, expect, test } from "bun:test";

import { checkLockStability, sha256 } from "./lock-stability.ts";

const LOCK_A = "[[targets]]\nstep = 'login'\nstrategy = 'role_name'\n";
const LOCK_B = "[[targets]]\nstep = 'login'\nstrategy = 'role_name'\n "; // one trailing byte

describe("lock-stability", () => {
  test("sha256 is deterministic and differs for a one-byte change", () => {
    expect(sha256(LOCK_A)).toBe(sha256(LOCK_A));
    expect(sha256(LOCK_A)).not.toBe(sha256(LOCK_B));
    // 64 hex chars.
    expect(sha256(LOCK_A)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("identical bytes ⇒ stable, no contract violation", () => {
    const r = checkLockStability({
      before: LOCK_A,
      after: LOCK_A,
      driftCount: 0,
      verdict: "passed",
    });
    expect(r.stable).toBe(true);
    expect(r.beforeHash).toBe(r.afterHash);
    expect(r.expectedNoWrite).toBe(true);
    expect(r.contractViolation).toBe(false);
  });

  test("one-byte diff on a clean green run ⇒ churn flagged as a contract violation", () => {
    const r = checkLockStability({
      before: LOCK_A,
      after: LOCK_B,
      driftCount: 0,
      verdict: "passed",
    });
    expect(r.stable).toBe(false);
    expect(r.beforeHash).not.toBe(r.afterHash);
    expect(r.expectedNoWrite).toBe(true);
    expect(r.contractViolation).toBe(true); // unchanged bytes were expected, churned anyway
  });

  test("a legitimate heal write (drift ≥ 1) churns but is NOT a contract violation", () => {
    const r = checkLockStability({
      before: LOCK_A,
      after: LOCK_B,
      driftCount: 1,
      verdict: "passed",
    });
    expect(r.stable).toBe(false);
    expect(r.expectedNoWrite).toBe(false); // drift > 0 → a write was expected
    expect(r.contractViolation).toBe(false);
  });

  test("no lock on either side ⇒ stable", () => {
    const r = checkLockStability({ before: null, after: null, driftCount: 0, verdict: "passed" });
    expect(r.stable).toBe(true);
    expect(r.beforeHash).toBeNull();
    expect(r.afterHash).toBeNull();
    expect(r.contractViolation).toBe(false);
  });

  test("a created lock (null → bytes) is not stable", () => {
    const r = checkLockStability({ before: null, after: LOCK_A, driftCount: 1, verdict: "passed" });
    expect(r.stable).toBe(false);
    expect(r.beforeHash).toBeNull();
    expect(r.afterHash).toBe(sha256(LOCK_A));
  });
});
