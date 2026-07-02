// Aggregator tests (Unit A). Three layers:
//   1. The committed green-campaign fixture (4 run dirs under src/cli/__fixtures__/green-campaign/,
//      tracked text-only goldens — two wizard runs + async + rerender) → the P6 green-campaign
//      invariants (L1 hit-rate 100%, zero escalation, zero cost, zero drift, lock-stable). This is
//      HERMETIC: it does NOT depend on the gitignored `.flightplan-runs/` dir.
//   2. Each synthetic golden in __fixtures__/ → exact PerRunMetrics match against its committed
//      expected.json (the goldens were hand-verified against independent calculation).
//   3. The false-positive / false-negative detectors + the cost-honesty invariant.
//
// All offline: no Chrome, no network, no SDK. Canonical reference: PLAN.md §6/§7.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractUsageCost } from "../ai/cost.ts";
import { resolveRegistry } from "../ai/registry.ts";
import { loadRun } from "../cli/explain.ts";
import type { ModelRoleName } from "../types.ts";
import { aggregateCampaign, aggregateRun } from "./aggregate.ts";
import { CAMPAIGN_EXPECTED_TIERS } from "./cost-model.ts";
import { checkLockStability } from "./lock-stability.ts";
import type { ExpectedTierEntry, PerRunMetrics } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "__fixtures__");
// The committed, tracked green-campaign fixture (4 run dirs), replacing the old dependency on the
// gitignored `.flightplan-runs/` dir so this suite is hermetic in a fresh clone / CI.
const campaignDir = join(here, "..", "cli", "__fixtures__", "green-campaign");

const SYNTHETIC = [
  "l0-hit",
  "l1-heal",
  "l2-escalate",
  "l3-vision",
  "budget-inconclusive",
  "false-positive",
];

function campaignRunDirs(): string[] {
  return readdirSync(campaignDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(campaignDir, d.name))
    .sort();
}

// ---------------------------------------------------------------------------
// 1. The committed green-campaign fixture (4 run dirs) — the green-campaign exit invariants.
// ---------------------------------------------------------------------------

describe("aggregate: the committed green-campaign fixture (4 run dirs)", () => {
  test("there are exactly 4 campaign run dirs, all loadable", () => {
    expect(campaignRunDirs().length).toBe(4);
  });

  test("campaign invariants: 100% L1, zero escalation, zero cost, zero drift", async () => {
    const loaded = await Promise.all(campaignRunDirs().map((d) => loadRun(d)));
    const campaign = aggregateCampaign(loaded);

    expect(campaign.runCount).toBe(4);
    expect(campaign.passCount).toBe(4);
    expect(campaign.runs.every((r) => r.verdict === "passed")).toBe(true);

    // Every resolving step landed at L1 (the deterministic strategy race).
    expect(campaign.histogram).toEqual({ L0: 0, L1: 13, L2: 0, L3: 0, L4: 0, total: 13 });
    expect(campaign.l1HitRate).toBe(1);
    expect(campaign.l0HitRate).toBe(0);
    expect(campaign.deterministicShare).toBe(1);
    expect(campaign.escalationRate).toBe(0);
    expect(campaign.l2Rate).toBe(0);
    expect(campaign.l3Rate).toBe(0);
    expect(campaign.l4Rate).toBe(0);

    // Cost + drift are zero across the green campaign.
    expect(campaign.totalCostUsd).toBe(0);
    expect(campaign.maxRunCostUsd).toBe(0);
    expect(campaign.costPerPass).toBe(0);
    expect(campaign.perRoleCost).toEqual({});
    expect(campaign.totalDriftCount).toBe(0);
    expect(campaign.totalHealedSteps).toBe(0);
    expect(campaign.driftRuns).toBe(0);
    expect(campaign.driftHealSuccessRate).toBe(1); // vacuously: nothing to heal

    // No wrong-element resolutions.
    expect(campaign.falsePositiveSteps).toEqual([]);
  });

  test("per-run: goto steps carry no tier and are excluded from the denominator", async () => {
    // examples.wizard run: 6 step_end events but only 5 carry a tier (goto excluded).
    const dirs = campaignRunDirs();
    const loaded = await loadRun(dirs[0] as string);
    const m = aggregateRun(loaded);
    expect(m.totalSteps).toBeGreaterThan(m.tieredSteps); // goto excluded
    expect(m.tieredSteps).toBe(m.histogram.total);
    expect(m.l1HitRate).toBe(1);
  });

  test("lock byte-stability cross-check: clean green runs expect no lock write", async () => {
    const loaded = await Promise.all(campaignRunDirs().map((d) => loadRun(d)));
    for (const run of loaded) {
      const m = aggregateRun(run);
      // Simulate an unchanged lock around the run (identical bytes before/after).
      const bytes = "[[targets]]\nstep = 'x'\n";
      const stability = checkLockStability({
        before: bytes,
        after: bytes,
        driftCount: m.driftCount,
        verdict: m.verdict,
      });
      expect(stability.stable).toBe(true);
      expect(stability.expectedNoWrite).toBe(true); // drift 0 + passed
      expect(stability.contractViolation).toBe(false);
    }
  });

  test("per-fixture matrix coverage maps campaign flows to their expected tiers", async () => {
    const loaded = await Promise.all(campaignRunDirs().map((d) => loadRun(d)));
    const campaign = aggregateCampaign(loaded, { expectedTiers: CAMPAIGN_EXPECTED_TIERS });
    // wizard / async / rerender appear; each is L1 and its expected set includes L1.
    const flows = new Set(campaign.perFixture.map((f) => f.flowId));
    expect(flows.has("examples.wizard")).toBe(true);
    expect(flows.has("examples.async")).toBe(true);
    expect(flows.has("examples.rerender")).toBe(true);
    expect(campaign.perFixture.every((f) => f.expectedTierHit)).toBe(true);
    expect(campaign.falseNegatives).toEqual([]); // nothing escalated past expectation
  });
});

// ---------------------------------------------------------------------------
// 2. Synthetic goldens — exact PerRunMetrics match.
// ---------------------------------------------------------------------------

describe("aggregate: synthetic goldens (exact match)", () => {
  for (const fixture of SYNTHETIC) {
    test(`${fixture} → expected.json`, async () => {
      const loaded = await loadRun(join(fixturesDir, fixture));
      const metrics = aggregateRun(loaded);
      const golden = JSON.parse(
        readFileSync(join(fixturesDir, fixture, "expected.json"), "utf8"),
      ) as PerRunMetrics;
      expect(metrics).toEqual(golden);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. False-positive / false-negative detectors + cost honesty.
// ---------------------------------------------------------------------------

describe("aggregate: resolution-quality detectors", () => {
  test("false-positive: ok step with a failed assertion is flagged (wrong element resolved)", async () => {
    const loaded = await loadRun(join(fixturesDir, "false-positive"));
    const m = aggregateRun(loaded);
    expect(m.verdict).toBe("failed");
    expect(m.falsePositiveSteps).toEqual(["s_click"]);
    // The step still resolved at L1 (the action "succeeded" on the wrong element).
    expect(m.histogram.L1).toBe(1);

    const campaign = aggregateCampaign([loaded]);
    expect(campaign.falsePositiveSteps).toEqual([{ runId: "false-positive", stepId: "s_click" }]);
  });

  test("false-negative: a step reaching L2+ where the table marks ≤L1 is flagged", async () => {
    const loaded = await loadRun(join(fixturesDir, "l2-escalate"));
    // Pretend the fixture was expected to resolve deterministically (L1) — the L2 step is then
    // a false negative (the deterministic tiers should have caught it).
    const table: ExpectedTierEntry[] = [
      { fixture: "l2-escalate", flowId: "examples.l2-escalate", tiers: ["L1"], costTier: "L1" },
    ];
    const campaign = aggregateCampaign([loaded], { expectedTiers: table });
    expect(campaign.falseNegatives).toEqual([
      { runId: "l2-escalate", flowId: "examples.l2-escalate", stepId: "s_pick", tier: "L2" },
    ]);
    const fixture = campaign.perFixture.find((f) => f.fixture === "l2-escalate");
    expect(fixture?.falseNegativeSteps).toEqual([
      { runId: "l2-escalate", stepId: "s_pick", tier: "L2" },
    ]);
  });

  test("no false-negative when the observed tier is within the expected set", async () => {
    const loaded = await loadRun(join(fixturesDir, "l2-escalate"));
    const table: ExpectedTierEntry[] = [
      { fixture: "l2-escalate", flowId: "examples.l2-escalate", tiers: ["L2"], costTier: "L2" },
    ];
    const campaign = aggregateCampaign([loaded], { expectedTiers: table });
    expect(campaign.falseNegatives).toEqual([]);
    expect(campaign.perFixture[0]?.expectedTierHit).toBe(true);
  });

  test("cost honesty: synthetic ai.jsonl tokens × registry pricing == summary total_cost_usd", async () => {
    const registry = resolveRegistry();
    for (const fixture of ["l2-escalate", "l3-vision", "budget-inconclusive"]) {
      const loaded = await loadRun(join(fixturesDir, fixture));
      const recomputed = loaded.aiEvents.reduce((sum, call) => {
        const role = call.role as ModelRoleName; // fixtures only use resolver/vision
        const { cost_usd } = extractUsageCost(
          { inputTokens: call.inputTokens, outputTokens: call.outputTokens },
          registry[role].pricing,
        );
        return sum + cost_usd;
      }, 0);
      const stored = aggregateRun(loaded).costUsd;
      expect(recomputed).toBeCloseTo(stored, 10);
    }
  });
});
