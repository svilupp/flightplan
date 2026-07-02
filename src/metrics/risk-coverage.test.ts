// Risk-coverage integrity test (Unit G). The traceability matrix maps PLAN.md §8 risks + the §6
// escalation matrix to the tests that cover them. This test is the offline integrity check: every
// referenced test file path MUST actually exist, so the matrix can never silently rot.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  coveredTestFiles,
  liveValidationRisks,
  offlineCoveredRisks,
  RISK_COVERAGE,
} from "./risk-coverage.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

describe("risk-coverage", () => {
  test("the matrix is non-empty and every entry has a description + riskId", () => {
    expect(RISK_COVERAGE.length).toBeGreaterThan(0);
    for (const e of RISK_COVERAGE) {
      expect(e.riskId).toBeTruthy();
      expect(e.description).toBeTruthy();
    }
  });

  test("riskIds are unique", () => {
    const ids = RISK_COVERAGE.map((e) => e.riskId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every referenced test file actually exists (offline integrity check)", () => {
    const missing: string[] = [];
    for (const path of coveredTestFiles()) {
      if (!existsSync(join(repoRoot, path))) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  test("the live-only and offline-covered partitions are disjoint and cover the matrix", () => {
    const live = liveValidationRisks();
    const offline = offlineCoveredRisks();
    expect(live.length + offline.length).toBe(RISK_COVERAGE.length);
    const liveIds = new Set(live.map((e) => e.riskId));
    expect(offline.every((e) => !liveIds.has(e.riskId))).toBe(true);
  });

  test("every entry references at least one covering test file", () => {
    for (const e of RISK_COVERAGE) {
      expect(e.coveredBy.length).toBeGreaterThan(0);
    }
  });
});
