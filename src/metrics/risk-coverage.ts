// Flightplan — Phase 6 residual-risk → unit-test traceability matrix (Unit G).
//
// A typed data table mapping the PLAN.md §8 open risks and the §6 escalation matrix to the tests
// that cover them. `coveredBy` paths are repo-relative test files that MUST exist (the companion
// test asserts this — an offline integrity check that the traceability never rots). Risks marked
// `liveValidationRequired` can only be fully discharged by the LIVE P6 campaign (Chrome + AI key);
// the offline harness still tracks them and points at the fixture/scenario that exercises them.

import type { RiskCoverageEntry } from "./types.ts";

/**
 * The residual-risk → coverage matrix. Each `coveredBy` entry is a repo-relative path to a test
 * file that EXISTS in this repository (verified offline by `risk-coverage.test.ts`).
 */
export const RISK_COVERAGE: RiskCoverageEntry[] = [
  // -------------------------------------------------------------------------
  // PLAN.md §8 — open risks & assumptions
  // -------------------------------------------------------------------------
  {
    riskId: "risk-1-signature-normalization",
    description:
      "Page-signature normalization (url+text hash vs structural skeleton) → false L0 hits or needless L1 (§8 #1; fixture 08).",
    coveredBy: ["src/lock/signature.test.ts", "src/metrics/aggregate.test.ts"],
    liveValidationRequired: true,
    fixture: "08-signature",
  },
  {
    riskId: "risk-2-native-dialog-hang",
    description:
      "Native alert/confirm hangs the run without a dialog policy (§8 #2; fixture 06 gauntlet).",
    coveredBy: ["src/metrics/risk-coverage.test.ts"],
    liveValidationRequired: true,
    fixture: "06-gauntlet",
  },
  {
    riskId: "risk-3-multiprofile-autodiscovery",
    description:
      "connect({provider:'generic'}) throws multiple-local-browsers when >1 Chrome profile exists (§8 #3).",
    coveredBy: ["src/driver/connect-resolution.test.ts"],
    liveValidationRequired: false,
  },
  {
    riskId: "risk-4-model-id-rotation",
    description:
      "Preview/dated model IDs rotate; pricing must stay config-driven, never hardcoded (§8 #4).",
    coveredBy: ["src/ai/ai.test.ts", "src/metrics/cost-model.test.ts"],
    liveValidationRequired: false,
  },
  {
    riskId: "risk-8-text-matches-any-element",
    description:
      "Bare text: matches non-interactive elements → wrong element resolved (false-positive resolution) (§8 #8).",
    coveredBy: [
      "src/ladder/fuzzy.test.ts",
      "src/ladder/l1.test.ts",
      "src/metrics/aggregate.test.ts",
    ],
    liveValidationRequired: false,
    fixture: "false-positive",
  },
  {
    riskId: "risk-9-node-replacement-staleness",
    description:
      "Node-replacement/re-render staleness under interaction-gated re-render (§8 #9; fixture 03).",
    coveredBy: ["src/ladder/repair.test.ts", "src/metrics/aggregate.test.ts"],
    liveValidationRequired: true,
    fixture: "03-rerender",
  },
  {
    riskId: "lock-stability-no-churn",
    description:
      "Locks must be byte-stable across repeated green runs; a clean pass must not rewrite the lock (P6 exit criterion).",
    coveredBy: ["src/lock/write.test.ts", "src/metrics/lock-stability.test.ts"],
    liveValidationRequired: false,
  },

  // -------------------------------------------------------------------------
  // PLAN.md §6 — escalation matrix (each fixture's expected resolving tier)
  // -------------------------------------------------------------------------
  {
    riskId: "matrix-01-wizard",
    description: "01-wizard multi-step happy path resolves at L0/L1 (deterministic + assertions).",
    coveredBy: ["src/metrics/aggregate.test.ts", "src/metrics/cost-model.test.ts"],
    liveValidationRequired: true,
    fixture: "01-wizard",
  },
  {
    riskId: "matrix-02-async",
    description: "02-async late/async elements resolve at L1 with polling (navigation settling).",
    coveredBy: ["src/metrics/aggregate.test.ts"],
    liveValidationRequired: true,
    fixture: "02-async",
  },
  {
    riskId: "matrix-06-gauntlet",
    description: "06-gauntlet ambiguity/native-confirm/node-replacement escalates to L2.",
    coveredBy: ["src/metrics/cost-model.test.ts"],
    liveValidationRequired: true,
    fixture: "06-gauntlet",
  },
  {
    riskId: "matrix-07-drift",
    description: "07-drift variants a:L0/L1 · b:L1 heal · c:L2 (staleness → L1 heal; hard drift → model).",
    coveredBy: ["src/metrics/aggregate.test.ts", "src/metrics/cost-model.test.ts"],
    liveValidationRequired: true,
    fixture: "07-drift",
  },
  {
    riskId: "matrix-09-vision",
    description: "09-vision unlabeled icon buttons resolve at L3 (vision-only resolution).",
    coveredBy: ["src/metrics/aggregate.test.ts", "src/metrics/cost-model.test.ts"],
    liveValidationRequired: true,
    fixture: "09-vision",
  },
];

/** Every distinct repo-relative test path referenced by the matrix (for the integrity check). */
export function coveredTestFiles(): string[] {
  const seen = new Set<string>();
  for (const entry of RISK_COVERAGE) {
    for (const path of entry.coveredBy) seen.add(path);
  }
  return [...seen].sort();
}

/** The risks that the offline harness fully covers (no live campaign needed). */
export function offlineCoveredRisks(): RiskCoverageEntry[] {
  return RISK_COVERAGE.filter((e) => !e.liveValidationRequired);
}

/** The risks that still require the LIVE P6 campaign (Chrome + AI key) to fully discharge. */
export function liveValidationRisks(): RiskCoverageEntry[] {
  return RISK_COVERAGE.filter((e) => e.liveValidationRequired);
}
