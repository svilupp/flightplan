// Flightplan — metrics/ public surface (Phase 6 campaign-metrics harness).
//
// The OFFLINE measurement engine for the P6 validation campaign: it ingests the artifacts the
// LIVE runs emit (loaded via `loadRun`, REUSED from `cli/explain.ts`) and computes every
// exit-criteria metric — tier histogram + hit/escalation rates, per-run/campaign cost, drift-heal
// success, latency, false-positive/negative resolutions, lock byte-stability, the cost-model
// projection, and the residual-risk traceability matrix.
//
// Named exports throughout (no `export *`), matching the lint/lock module barrels. Canonical
// references: PLAN.md §6 (escalation matrix), §7 (cost ladder), §8 (risks).

export type { LoadedRun } from "../cli/explain.ts";
// --- artifact loader (re-exported for convenience; owned by cli/explain.ts, imported zero-edit) ---
export { loadRun } from "../cli/explain.ts";
export type { CampaignOptions } from "./aggregate.ts";
// --- Unit A: aggregator ---
export { aggregateCampaign, aggregateRun } from "./aggregate.ts";
export type {
  CostModelOptions,
  CostModelResult,
  FixtureCostProjection,
  TierCallTokens,
} from "./cost-model.ts";
// --- Unit E: cost-model calculator ---
export {
  CAMPAIGN_EXPECTED_TIERS,
  DEFAULT_TIER_TOKENS,
  projectCampaignCost,
  tierCostUsd,
  tierRole,
} from "./cost-model.ts";
export type { LockStabilityInput } from "./lock-stability.ts";
// --- Unit D: lock byte-stability ---
export { checkLockStability, sha256 } from "./lock-stability.ts";

// --- Unit G: residual-risk → unit-test traceability matrix ---
export {
  coveredTestFiles,
  liveValidationRisks,
  offlineCoveredRisks,
  RISK_COVERAGE,
} from "./risk-coverage.ts";

// --- types ---
export type {
  CampaignMetrics,
  ExpectedTierEntry,
  LatencyStats,
  PerFixtureMetrics,
  PerRoleCost,
  PerRunMetrics,
  PerTierLatency,
  RiskCoverageEntry,
  StabilityResult,
  TierHistogram,
} from "./types.ts";
