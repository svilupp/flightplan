// Cost-model tests (Unit E). The pure projector over the §6 expected-tier table + the resolved
// registry: deterministic fixtures → $0; model fixtures → one L2 (~$0.0000065) or vision (~$0.0006)
// call; the whole campaign is well under a cent per pass and under the per-run ceiling.

import { describe, expect, test } from "bun:test";

import { resolveRegistry } from "../ai/registry.ts";
import {
  CAMPAIGN_EXPECTED_TIERS,
  projectCampaignCost,
  tierCostUsd,
  tierRole,
} from "./cost-model.ts";

const registry = resolveRegistry();

describe("cost-model: tier → role + per-call cost", () => {
  test("deterministic tiers are free + roleless", () => {
    expect(tierRole("L0")).toBeNull();
    expect(tierRole("L1")).toBeNull();
    expect(tierCostUsd("L0", registry)).toBe(0);
    expect(tierCostUsd("L1", registry)).toBe(0);
  });

  test("model tiers map to their billed role", () => {
    expect(tierRole("L2")).toBe("resolver");
    expect(tierRole("L3")).toBe("vision");
    expect(tierRole("L4")).toBe("advisor");
  });

  test("an L2 resolver call is a tiny fraction of a cent; vision is ~$0.0006", () => {
    const l2 = tierCostUsd("L2", registry);
    const l3 = tierCostUsd("L3", registry);
    expect(l2).toBeCloseTo(0.00000648, 10);
    expect(l3).toBeCloseTo(0.0006, 8);
    expect(l2).toBeLessThan(l3);
  });
});

describe("cost-model: whole-campaign projection over the §6 matrix", () => {
  const result = projectCampaignCost(CAMPAIGN_EXPECTED_TIERS, registry);

  test("only 06/07 (L2) and 09 (L3) cost anything; the rest are $0", () => {
    const paying = result.perFixture.filter((f) => f.costUsd > 0).map((f) => f.fixture);
    expect(paying.sort()).toEqual(["06-gauntlet", "07-drift", "09-vision"]);
    const free = result.perFixture.filter((f) => f.costUsd === 0);
    expect(free.every((f) => f.role === null && f.calls === 0)).toBe(true);
  });

  test("campaign is well under a cent per pass and under the per-run ceiling", () => {
    expect(result.passCount).toBe(9);
    expect(result.costPerPass).toBeLessThan(0.01); // < a cent per pass
    expect(result.maxRunCostUsd).toBeLessThan(0.05); // < per-run ceiling
    expect(result.withinBudget).toBe(true);
    // Pinned projection: 2 resolver calls + 1 vision call.
    expect(result.campaignUsd).toBeCloseTo(0.00000648 * 2 + 0.0006, 9);
    // The most expensive single run is the vision fixture.
    expect(result.maxRunCostUsd).toBeCloseTo(0.0006, 8);
  });

  test("budget verdict flips when the per-pass ceiling is set absurdly low", () => {
    const strict = projectCampaignCost(CAMPAIGN_EXPECTED_TIERS, registry, {
      costPerPassCeilingUsd: 1e-9,
    });
    expect(strict.withinBudget).toBe(false);
  });
});
