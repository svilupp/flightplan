// Flightplan — Phase 6 campaign-metrics aggregator (Unit A, the centerpiece).
//
// Pure functions over `loadRun`-ed run dirs. `aggregateRun` rolls up ONE run; `aggregateCampaign`
// folds many into the campaign exit-criteria metrics. No IO here — the caller loads artifacts via
// `loadRun` (REUSED from `cli/explain.ts`, the robust multi-stream loader) and passes the parsed
// `LoadedRun`(s) in.
//
// Denominator rule (PLAN.md §6/§7): the resolution-rate denominator R = steps that emitted a
// `step_end.tier`. `goto`/`wait`/non-resolving steps carry no tier and are excluded from rates.
//
// Sources, per metric:
//   - tier histogram / rates ........ `step_end.tier`
//   - cost / per-run ................. `run_end.totals.total_cost_usd`
//   - per-role cost .................. `ai.jsonl` `ai_call.{role,cost_usd}`
//   - drift / heal ................... `run_end.totals.drift_count` + `summary.healed_steps`
//   - step latency ................... `step_end.durationMs`
//   - per-tier latency ............... `trace.jsonl` `resolution_attempt.{tier,durationMs}`
//   - false positive ................. `step_end.ok` vs subsequent `assertion_result.pass`
//   - false negative ................. observed tier vs the §6 expected-tier table

import type {
  AiCallEvent,
  AssertionResultEvent,
  LadderTier,
  ResolutionAttemptEvent,
  RunEndEvent,
  RunEvent,
  RunStartEvent,
  StepEndEvent,
} from "../artifacts/events.ts";
import type { LoadedRun } from "../cli/explain.ts";
import type { RunVerdict } from "../types.ts";
import type {
  CampaignMetrics,
  ExpectedTierEntry,
  LatencyStats,
  PerFixtureMetrics,
  PerRoleCost,
  PerRunMetrics,
  PerTierLatency,
  TierHistogram,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const TIERS = ["L0", "L1", "L2", "L3", "L4"] as const;
const TIER_INDEX: Record<LadderTier, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

function emptyHistogram(): TierHistogram {
  return { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0, total: 0 };
}

function addHistogram(into: TierHistogram, from: TierHistogram): void {
  for (const t of TIERS) into[t] += from[t];
  into.total += from.total;
}

/** Safe division: 0 when the denominator is 0 (never NaN/Infinity in a metric). */
function ratio(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

/**
 * Nearest-rank percentile (1-based rank = ceil(p/100 · n)), returning an actual observed value
 * (no interpolation) so goldens stay clean and deterministic. Empty input → 0.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[idx] ?? 0;
}

function latencyStats(values: number[]): LatencyStats {
  return { p50: percentile(values, 50), p95: percentile(values, 95), count: values.length };
}

/** The highest tier with a non-zero count (null when the histogram is empty). */
function maxTier(h: TierHistogram): LadderTier | null {
  let found: LadderTier | null = null;
  for (const t of TIERS) if (h[t] > 0) found = t;
  return found;
}

// ---------------------------------------------------------------------------
// Per-run collection
// ---------------------------------------------------------------------------

/** Per-run metrics plus the raw arrays the campaign roll-up needs (kept off the public type). */
interface RunRaw {
  metrics: PerRunMetrics;
  stepDurations: number[];
  perTierDurations: Map<LadderTier, number[]>;
  /** Resolving steps (those with a tier), for false-negative attribution. */
  resolvingSteps: Array<{ stepId: string; tier: LadderTier }>;
}

function findRunStart(events: RunEvent[]): RunStartEvent | undefined {
  return events.find((e): e is RunStartEvent => e.type === "run_start");
}
function findRunEnd(events: RunEvent[]): RunEndEvent | undefined {
  return events.find((e): e is RunEndEvent => e.type === "run_end");
}

function collectRun(loaded: LoadedRun): RunRaw {
  const { runEvents, traceEvents, aiEvents, summary } = loaded;
  const runStart = findRunStart(runEvents);
  const runEnd = findRunEnd(runEvents);

  const stepEnds = runEvents.filter((e): e is StepEndEvent => e.type === "step_end");
  const assertions = runEvents.filter(
    (e): e is AssertionResultEvent => e.type === "assertion_result",
  );

  // --- identity / verdict ---
  const runId = runStart?.runId ?? summary?.run_id ?? loaded.runDir;
  const flowId = runStart?.flowId ?? summary?.flow_id ?? "(unknown)";
  const verdict: RunVerdict = runEnd?.verdict ?? summary?.verdict ?? "error";

  // --- tier histogram (denominator R) ---
  const histogram = emptyHistogram();
  const resolvingSteps: Array<{ stepId: string; tier: LadderTier }> = [];
  for (const s of stepEnds) {
    if (s.tier !== undefined) {
      histogram[s.tier] += 1;
      histogram.total += 1;
      resolvingSteps.push({ stepId: s.stepId, tier: s.tier });
    }
  }
  const r = histogram.total;

  // --- cost (authoritative = run_end totals; fall back to summary, then ai.jsonl sum) ---
  const costUsd =
    runEnd?.totals.total_cost_usd ??
    summary?.total_cost_usd ??
    aiEvents.reduce((sum, c) => sum + c.cost_usd, 0);
  const perRoleCost = rollupRoleCost(aiEvents);

  // --- drift / heal ---
  const healedFromEvents = stepEnds.filter((s) => s.healed).map((s) => s.stepId);
  const healedSteps =
    summary?.healed_steps !== undefined && summary.healed_steps.length > 0
      ? summary.healed_steps
      : healedFromEvents;
  const driftCount = runEnd?.totals.drift_count ?? summary?.drift_count ?? healedSteps.length;
  const driftHealSuccess =
    verdict === "passed" &&
    driftCount >= 1 &&
    healedFromEvents.length > 0 &&
    healedFromEvents.every((id) => healedSteps.includes(id));

  // --- latency ---
  const stepDurations = stepEnds.map((s) => s.durationMs);
  const perTierDurations = new Map<LadderTier, number[]>();
  for (const ev of traceEvents) {
    if (ev.type !== "resolution_attempt") continue;
    const attempt: ResolutionAttemptEvent = ev;
    const bucket = perTierDurations.get(attempt.tier) ?? [];
    bucket.push(attempt.durationMs);
    perTierDurations.set(attempt.tier, bucket);
  }
  const perTierLatency: PerTierLatency = {};
  for (const t of TIERS) {
    const durations = perTierDurations.get(t);
    if (durations !== undefined) perTierLatency[t] = latencyStats(durations);
  }

  // --- false-positive resolution: ok step with a failed assertion on it ---
  const failedAssertionSteps = new Set(assertions.filter((a) => !a.pass).map((a) => a.stepId));
  const falsePositiveSteps = stepEnds
    .filter((s) => s.ok && failedAssertionSteps.has(s.stepId))
    .map((s) => s.stepId);

  const metrics: PerRunMetrics = {
    runId,
    flowId,
    verdict,
    totalSteps: stepEnds.length,
    tieredSteps: r,
    histogram,
    l0HitRate: ratio(histogram.L0, r),
    l1HitRate: ratio(histogram.L1, r),
    deterministicShare: ratio(histogram.L0 + histogram.L1, r),
    escalationRate: ratio(histogram.L2 + histogram.L3 + histogram.L4, r),
    l2Rate: ratio(histogram.L2, r),
    l3Rate: ratio(histogram.L3, r),
    l4Rate: ratio(histogram.L4, r),
    costUsd,
    perRoleCost,
    driftCount,
    healedSteps,
    driftHealSuccess,
    stepLatency: latencyStats(stepDurations),
    perTierLatency,
    falsePositiveSteps,
  };

  return { metrics, stepDurations, perTierDurations, resolvingSteps };
}

/** Group `ai_call` spend by role into a {calls, cost_usd} rollup. */
function rollupRoleCost(aiEvents: AiCallEvent[]): PerRoleCost {
  const out: PerRoleCost = {};
  for (const call of aiEvents) {
    const existing = out[call.role];
    if (existing === undefined) {
      out[call.role] = { calls: 1, cost_usd: call.cost_usd };
    } else {
      existing.calls += 1;
      existing.cost_usd += call.cost_usd;
    }
  }
  return out;
}

function mergeRoleCost(into: PerRoleCost, from: PerRoleCost): void {
  for (const role of Object.keys(from) as Array<keyof PerRoleCost>) {
    const add = from[role];
    if (add === undefined) continue;
    const existing = into[role];
    if (existing === undefined) {
      into[role] = { calls: add.calls, cost_usd: add.cost_usd };
    } else {
      existing.calls += add.calls;
      existing.cost_usd += add.cost_usd;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Roll up the metrics for ONE loaded run dir. Pure. */
export function aggregateRun(loaded: LoadedRun): PerRunMetrics {
  return collectRun(loaded).metrics;
}

/** Options for {@link aggregateCampaign}. */
export interface CampaignOptions {
  /** The §6 expected-tier table, keyed by fixture; enables per-fixture + false-negative metrics. */
  expectedTiers?: ExpectedTierEntry[];
}

/**
 * Fold one OR many loaded run dirs into the campaign exit-criteria metrics. Pure.
 *
 * When `expectedTiers` is supplied, per-fixture matrix coverage and false-negative detection
 * (a step reaching L2+ on a fixture the table marks ≤L1) are computed; otherwise those are empty.
 */
export function aggregateCampaign(
  loadedRuns: LoadedRun[],
  options: CampaignOptions = {},
): CampaignMetrics {
  const raws = loadedRuns.map(collectRun);
  const runs = raws.map((r) => r.metrics);

  const histogram = emptyHistogram();
  const perRoleCost: PerRoleCost = {};
  const allStepDurations: number[] = [];
  const perTierDurations = new Map<LadderTier, number[]>();
  const falsePositiveSteps: CampaignMetrics["falsePositiveSteps"] = [];

  let totalCostUsd = 0;
  let maxRunCostUsd = 0;
  let passCount = 0;
  let totalDriftCount = 0;
  let totalHealedSteps = 0;
  let driftRuns = 0;
  let driftHealSuccessRuns = 0;

  for (const raw of raws) {
    const m = raw.metrics;
    addHistogram(histogram, m.histogram);
    mergeRoleCost(perRoleCost, m.perRoleCost);
    allStepDurations.push(...raw.stepDurations);
    for (const [tier, durations] of raw.perTierDurations) {
      const bucket = perTierDurations.get(tier) ?? [];
      bucket.push(...durations);
      perTierDurations.set(tier, bucket);
    }
    for (const stepId of m.falsePositiveSteps) {
      falsePositiveSteps.push({ runId: m.runId, stepId });
    }
    totalCostUsd += m.costUsd;
    maxRunCostUsd = Math.max(maxRunCostUsd, m.costUsd);
    if (m.verdict === "passed") passCount += 1;
    totalDriftCount += m.driftCount;
    totalHealedSteps += m.healedSteps.length;
    if (m.driftCount >= 1) {
      driftRuns += 1;
      if (m.driftHealSuccess) driftHealSuccessRuns += 1;
    }
  }

  const perTierLatency: PerTierLatency = {};
  for (const t of TIERS) {
    const durations = perTierDurations.get(t);
    if (durations !== undefined) perTierLatency[t] = latencyStats(durations);
  }

  const r = histogram.total;
  const { perFixture, falseNegatives } = options.expectedTiers
    ? computeFixtureCoverage(raws, options.expectedTiers)
    : { perFixture: [], falseNegatives: [] };

  return {
    runCount: runs.length,
    passCount,
    histogram,
    l0HitRate: ratio(histogram.L0, r),
    l1HitRate: ratio(histogram.L1, r),
    deterministicShare: ratio(histogram.L0 + histogram.L1, r),
    escalationRate: ratio(histogram.L2 + histogram.L3 + histogram.L4, r),
    l2Rate: ratio(histogram.L2, r),
    l3Rate: ratio(histogram.L3, r),
    l4Rate: ratio(histogram.L4, r),
    totalCostUsd,
    costPerPass: ratio(totalCostUsd, passCount),
    maxRunCostUsd,
    perRoleCost,
    totalDriftCount,
    totalHealedSteps,
    driftRuns,
    driftHealSuccessRuns,
    // 1 when there was no drift to heal (vacuously successful — nothing churned).
    driftHealSuccessRate: driftRuns === 0 ? 1 : driftHealSuccessRuns / driftRuns,
    stepLatency: latencyStats(allStepDurations),
    perTierLatency,
    falsePositiveSteps,
    perFixture,
    falseNegatives,
    runs,
  };
}

/** Build per-fixture matrix coverage + false-negative attribution from the expected-tier table. */
function computeFixtureCoverage(
  raws: RunRaw[],
  table: ExpectedTierEntry[],
): {
  perFixture: PerFixtureMetrics[];
  falseNegatives: CampaignMetrics["falseNegatives"];
} {
  const byFlow = new Map<string, ExpectedTierEntry>();
  for (const entry of table) byFlow.set(entry.flowId, entry);

  const falseNegatives: CampaignMetrics["falseNegatives"] = [];
  const perFixtureAcc = new Map<
    string,
    {
      entry: ExpectedTierEntry;
      observed: TierHistogram;
      runs: number;
      fn: PerFixtureMetrics["falseNegativeSteps"];
    }
  >();

  for (const raw of raws) {
    const m = raw.metrics;
    const entry = byFlow.get(m.flowId);
    if (entry === undefined) continue;

    let acc = perFixtureAcc.get(entry.fixture);
    if (acc === undefined) {
      acc = { entry, observed: emptyHistogram(), runs: 0, fn: [] };
      perFixtureAcc.set(entry.fixture, acc);
    }
    addHistogram(acc.observed, m.histogram);
    acc.runs += 1;

    // false negative: a step escalated past a fixture the matrix marks as deterministic (≤L1).
    const expectedMax = Math.max(...entry.tiers.map((t) => TIER_INDEX[t]));
    if (expectedMax <= TIER_INDEX.L1) {
      for (const step of raw.resolvingSteps) {
        if (TIER_INDEX[step.tier] >= TIER_INDEX.L2) {
          acc.fn.push({ runId: m.runId, stepId: step.stepId, tier: step.tier });
          falseNegatives.push({
            runId: m.runId,
            flowId: m.flowId,
            stepId: step.stepId,
            tier: step.tier,
          });
        }
      }
    }
  }

  const perFixture: PerFixtureMetrics[] = [];
  for (const entry of table) {
    const acc = perFixtureAcc.get(entry.fixture);
    if (acc === undefined) continue;
    const observedMax = maxTier(acc.observed);
    const expectedTierHit = TIERS.some((t) => acc.observed[t] > 0 && entry.tiers.includes(t));
    perFixture.push({
      fixture: entry.fixture,
      flowId: entry.flowId,
      expectedTiers: entry.tiers,
      observed: acc.observed,
      maxTierObserved: observedMax,
      expectedTierHit,
      falseNegativeSteps: acc.fn,
      runs: acc.runs,
    });
  }

  return { perFixture, falseNegatives };
}
