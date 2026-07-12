// Flightplan — Phase 6 campaign-metrics types (the offline measurement contract).
//
// These types describe the metrics the P6 validation campaign reports. They are computed
// OFFLINE from a completed run's artifacts (loaded via `loadRun` from `cli/explain.ts`) — the
// LIVE runs (Chrome + AI key) emit the artifacts; this harness only ingests + measures them.
//
// Denominator note (the single most important convention): the resolution-rate denominator
// `R` is the count of steps that emit a `step_end.tier` (L0..L4). `goto`/`wait` and other
// non-resolving steps carry NO tier and are EXCLUDED from every rate denominator. `totalSteps`
// (all `step_end` events) is reported separately so the two are never conflated.
//
// Canonical references: PLAN.md §6 (escalation matrix), §7 (cost ladder), §8 (risks),
// and the Phase 6 exit criteria.

import type { AiCallRole, LadderTier } from "../artifacts/events.ts";
import type { RunVerdict } from "../types.ts";

// ---------------------------------------------------------------------------
// Histograms + latency
// ---------------------------------------------------------------------------

/** Count of resolving steps by the tier that resolved them (`step_end.tier`). */
export interface TierHistogram {
  L0: number;
  L1: number;
  L2: number;
  L3: number;
  L4: number;
  /** R — the sum L0+L1+L2+L3+L4 = steps that emitted a tier (the rate denominator). */
  total: number;
}

/** A latency distribution summary over a set of durations (milliseconds). */
export interface LatencyStats {
  p50: number;
  p95: number;
  count: number;
}

/** Per-tier latency, derived from `resolution_attempt.durationMs` grouped by tier. */
export type PerTierLatency = Partial<Record<LadderTier, LatencyStats>>;

/** Per-role spend, derived from `ai.jsonl` `ai_call.cost_usd` grouped by `ai_call.role`. */
export type PerRoleCost = Partial<Record<AiCallRole, { calls: number; cost_usd: number }>>;

// ---------------------------------------------------------------------------
// Per-run + per-fixture + campaign metrics
// ---------------------------------------------------------------------------

/** The full metric rollup for ONE run directory. */
export interface PerRunMetrics {
  runId: string;
  flowId: string;
  verdict: RunVerdict;
  /** All `step_end` events (resolving + non-resolving). */
  totalSteps: number;
  /** R — `step_end` events that carried a `tier`. The rate denominator. */
  tieredSteps: number;
  histogram: TierHistogram;
  /** L0 / R. */
  l0HitRate: number;
  /** L1 / R. */
  l1HitRate: number;
  /** (L0+L1) / R — the deterministic (free, in-process) share. */
  deterministicShare: number;
  /** (L2+L3+L4) / R — the model-tier escalation share. */
  escalationRate: number;
  /** L2 / R. */
  l2Rate: number;
  /** L3 / R. */
  l3Rate: number;
  /** L4 / R. */
  l4Rate: number;
  /** `run_end.totals.total_cost_usd` (the authoritative budget number). */
  costUsd: number;
  perRoleCost: PerRoleCost;
  /** `run_end.totals.drift_count` (== healed-step count). */
  driftCount: number;
  /** Step ids that auto-healed (`summary.healed_steps`, else `step_end.healed`). */
  healedSteps: string[];
  /** verdict passed ∧ drift_count≥1 ∧ every drifted step is recorded as healed. */
  driftHealSuccess: boolean;
  /** p50/p95 over `step_end.durationMs` for ALL steps in the run. */
  stepLatency: LatencyStats;
  perTierLatency: PerTierLatency;
  /** Steps where `step_end.ok===true` but an `assertion_result.pass===false` exists
   *  for that step — the wrong element was resolved (a false-positive resolution). */
  falsePositiveSteps: string[];
}

/** Per-fixture rollup, comparing observed tiers against the expected-tier table (§6 matrix). */
export interface PerFixtureMetrics {
  fixture: string;
  flowId: string;
  /** Expected resolving tier(s) from the escalation matrix. */
  expectedTiers: LadderTier[];
  /** Observed tiers summed across every run of this fixture. */
  observed: TierHistogram;
  /** The highest tier observed (null when no resolving step ran). */
  maxTierObserved: LadderTier | null;
  /** True when at least one observed tier is in `expectedTiers`. */
  expectedTierHit: boolean;
  /** Steps that reached L2+ on a fixture the matrix marks as ≤L1 (false negatives). */
  falseNegativeSteps: Array<{ runId: string; stepId: string; tier: LadderTier }>;
  /** Number of runs of this fixture folded in. */
  runs: number;
}

/** The aggregate metrics across an entire campaign (one OR many run dirs). */
export interface CampaignMetrics {
  runCount: number;
  /** Runs whose verdict is `passed`. */
  passCount: number;
  /** Tier histogram summed across all runs. */
  histogram: TierHistogram;
  l0HitRate: number;
  l1HitRate: number;
  deterministicShare: number;
  escalationRate: number;
  l2Rate: number;
  l3Rate: number;
  l4Rate: number;
  /** Sum of every run's `costUsd`. */
  totalCostUsd: number;
  /** totalCostUsd / passCount (0 when no passes). */
  costPerPass: number;
  /** The single most expensive run's `costUsd`. */
  maxRunCostUsd: number;
  perRoleCost: PerRoleCost;
  totalDriftCount: number;
  totalHealedSteps: number;
  /** Runs with drift_count≥1. */
  driftRuns: number;
  /** Runs where `driftHealSuccess`. */
  driftHealSuccessRuns: number;
  /** driftHealSuccessRuns / driftRuns (1 when there was no drift to heal). */
  driftHealSuccessRate: number;
  /** p50/p95 over every step's `durationMs` across all runs. */
  stepLatency: LatencyStats;
  perTierLatency: PerTierLatency;
  falsePositiveSteps: Array<{ runId: string; stepId: string }>;
  /** Populated only when an expected-tier table is supplied. */
  perFixture: PerFixtureMetrics[];
  /** Steps that escalated past the matrix-expected tier (false negatives). */
  falseNegatives: Array<{ runId: string; flowId: string; stepId: string; tier: LadderTier }>;
  /** The per-run rollups, in input order. */
  runs: PerRunMetrics[];
}

// ---------------------------------------------------------------------------
// Lock byte-stability
// ---------------------------------------------------------------------------

/** The result of a lock byte-stability check across a green run (Unit D). */
export interface StabilityResult {
  /** beforeHash === afterHash — the lock bytes did not change. */
  stable: boolean;
  /** sha256 of the pre-run lock bytes (null when no lock existed). */
  beforeHash: string | null;
  /** sha256 of the post-run lock bytes (null when no lock existed). */
  afterHash: string | null;
  driftCount: number;
  verdict: RunVerdict;
  /** Cross-check: drift_count==0 ∧ verdict=="passed" ⇒ no lock write is expected. */
  expectedNoWrite: boolean;
  /** True when a write was NOT expected but the bytes changed anyway (a churn bug). */
  contractViolation: boolean;
}

// ---------------------------------------------------------------------------
// Expected-tier table (§6 escalation matrix) + risk coverage (§8)
// ---------------------------------------------------------------------------

/** One row of the per-fixture expected-tier table (drives cost projection + matrix checks). */
export interface ExpectedTierEntry {
  /** The fixture name, e.g. "01-wizard". */
  fixture: string;
  /** The flow id the fixture run reports, e.g. "examples.wizard". */
  flowId: string;
  /** Expected resolving tier(s) — a fixture may legitimately resolve at any of these. */
  tiers: LadderTier[];
  /** The headline tier used for cost projection (worst-case resolving tier). */
  costTier: LadderTier;
}

/** One residual-risk → unit-test traceability row (Unit G). */
export interface RiskCoverageEntry {
  /** Stable id, e.g. "risk-8" (PLAN.md §8 row) or "matrix-06-gauntlet" (§6 row). */
  riskId: string;
  description: string;
  /** Repo-relative test file paths that cover this risk offline (each MUST exist). */
  coveredBy: string[];
  /** True when the risk can only be fully discharged by the LIVE P6 campaign. */
  liveValidationRequired: boolean;
  /** The fixture that exercises this risk, when applicable. */
  fixture?: string;
}
