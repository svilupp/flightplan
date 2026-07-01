// Flightplan — Phase 6 cost-model calculator (Unit E).
//
// A PURE projector: given the per-fixture expected-tier table (§6 escalation matrix) and the
// resolved model registry (the single source of truth for pricing), it projects the per-run and
// whole-campaign USD spend WITHOUT running anything. Deterministic fixtures (resolve at L0/L1)
// project to $0; a model fixture projects to one call at its headline tier — a resolver (L2)
// text call (~$0.0000065) or a vision (L3) call (~$0.0006).
//
// The cost path reuses `ai/cost.ts` `extractUsageCost` (cost = inTok/1e6·pricing.in +
// outTok/1e6·pricing.out) so the projection uses the SAME arithmetic as the live cost tracker —
// the registry pricing is never re-encoded here.
//
// Exit-criterion budgets (PLAN.md §6/§7): campaign cost well under a cent per pass, and no single
// run over a small ceiling. Both are asserted by `withinBudget`.

import { extractUsageCost } from "../ai/cost.ts";
import type { ResolvedRegistry } from "../ai/registry.ts";
import type { AiCallRole, LadderTier } from "../artifacts/events.ts";
import type { ModelRoleName } from "../types.ts";
import type { ExpectedTierEntry } from "./types.ts";

/** Per-call token estimate for a model tier (used for projection only). */
export interface TierCallTokens {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Default per-call token estimates per model tier, calibrated to the spike baseline:
 *   - L2 resolver ≈ $0.0000065/call (deepseek text)
 *   - L3 vision   ≈ $0.0006/call    (gemini base64 screenshot)
 *   - L4 advisor  ≈ $0.0003/call    (glm classification)
 * Deterministic tiers (L0/L1) make no model call and project to $0.
 */
export const DEFAULT_TIER_TOKENS: Record<"L2" | "L3" | "L4", TierCallTokens> = {
  L2: { inputTokens: 40, outputTokens: 16 },
  L3: { inputTokens: 120, outputTokens: 180 },
  L4: { inputTokens: 200, outputTokens: 90 },
};

/** Map a resolving tier to the model role that pays for it (null for the free deterministic tiers). */
export function tierRole(tier: LadderTier): ModelRoleName | null {
  switch (tier) {
    case "L2":
      return "resolver";
    case "L3":
      return "vision";
    case "L4":
      return "advisor";
    default:
      return null; // L0 / L1 are free, in-process.
  }
}

/** Project the USD cost of resolving one step at `tier` against the registry pricing. */
export function tierCostUsd(
  tier: LadderTier,
  registry: ResolvedRegistry,
  tokens: Record<"L2" | "L3" | "L4", TierCallTokens> = DEFAULT_TIER_TOKENS,
): number {
  const role = tierRole(tier);
  if (role === null) return 0;
  const call = tokens[tier as "L2" | "L3" | "L4"];
  const { cost_usd } = extractUsageCost(
    { inputTokens: call.inputTokens, outputTokens: call.outputTokens },
    registry[role].pricing,
  );
  return cost_usd;
}

/** The projected cost of one fixture's run (one headline call at its cost tier). */
export interface FixtureCostProjection {
  fixture: string;
  flowId: string;
  costTier: LadderTier;
  /** The role billed (null for a deterministic fixture). */
  role: AiCallRole | null;
  /** Model calls projected for this fixture (0 deterministic, 1 model). */
  calls: number;
  costUsd: number;
}

/** The whole-campaign cost projection + budget verdict. */
export interface CostModelResult {
  perFixture: FixtureCostProjection[];
  /** Sum across all fixtures (one run each). */
  campaignUsd: number;
  /** Number of fixtures (assumed all pass → all count toward cost/pass). */
  passCount: number;
  /** campaignUsd / passCount. */
  costPerPass: number;
  /** The most expensive single fixture run. */
  maxRunCostUsd: number;
  /** The per-pass ceiling enforced ($0.01 — "well under a cent per pass"). */
  costPerPassCeilingUsd: number;
  /** The per-run ceiling enforced ($0.05). */
  perRunCeilingUsd: number;
  /** True iff costPerPass < costPerPassCeilingUsd AND maxRunCostUsd < perRunCeilingUsd. */
  withinBudget: boolean;
}

/** Options for {@link projectCampaignCost}. */
export interface CostModelOptions {
  tokens?: Record<"L2" | "L3" | "L4", TierCallTokens>;
  costPerPassCeilingUsd?: number;
  perRunCeilingUsd?: number;
}

/**
 * Project per-fixture + whole-campaign cost from the expected-tier table and the resolved
 * registry. Pure; deterministic from pricing × token estimates.
 */
export function projectCampaignCost(
  table: ExpectedTierEntry[],
  registry: ResolvedRegistry,
  options: CostModelOptions = {},
): CostModelResult {
  const tokens = options.tokens ?? DEFAULT_TIER_TOKENS;
  const costPerPassCeilingUsd = options.costPerPassCeilingUsd ?? 0.01;
  const perRunCeilingUsd = options.perRunCeilingUsd ?? 0.05;

  const perFixture: FixtureCostProjection[] = table.map((entry) => {
    const role = tierRole(entry.costTier);
    const costUsd = tierCostUsd(entry.costTier, registry, tokens);
    return {
      fixture: entry.fixture,
      flowId: entry.flowId,
      costTier: entry.costTier,
      role,
      calls: role === null ? 0 : 1,
      costUsd,
    };
  });

  const campaignUsd = perFixture.reduce((sum, f) => sum + f.costUsd, 0);
  const passCount = perFixture.length;
  const maxRunCostUsd = perFixture.reduce((max, f) => Math.max(max, f.costUsd), 0);
  const costPerPass = passCount === 0 ? 0 : campaignUsd / passCount;

  return {
    perFixture,
    campaignUsd,
    passCount,
    costPerPass,
    maxRunCostUsd,
    costPerPassCeilingUsd,
    perRunCeilingUsd,
    withinBudget: costPerPass < costPerPassCeilingUsd && maxRunCostUsd < perRunCeilingUsd,
  };
}

/**
 * The canonical per-fixture expected-tier table — the PLAN.md §6 escalation matrix. `tiers` are
 * the legitimate resolving tier(s); `costTier` is the worst-case (headline) tier used for cost
 * projection. The deterministic fixtures (01–05, 08) project to $0; only 06/07 (L2) and 09 (L3)
 * cost anything.
 */
export const CAMPAIGN_EXPECTED_TIERS: ExpectedTierEntry[] = [
  { fixture: "01-wizard", flowId: "examples.wizard", tiers: ["L0", "L1"], costTier: "L1" },
  { fixture: "02-async", flowId: "examples.async", tiers: ["L1"], costTier: "L1" },
  { fixture: "03-rerender", flowId: "examples.rerender", tiers: ["L1"], costTier: "L1" },
  { fixture: "04-overlays", flowId: "examples.overlays", tiers: ["L1"], costTier: "L1" },
  { fixture: "05-contexts", flowId: "examples.contexts", tiers: ["L1"], costTier: "L1" },
  { fixture: "06-gauntlet", flowId: "examples.gauntlet", tiers: ["L2"], costTier: "L2" },
  { fixture: "07-drift", flowId: "examples.drift", tiers: ["L0", "L1", "L2"], costTier: "L2" },
  { fixture: "08-signature", flowId: "examples.signature", tiers: ["L0", "L1"], costTier: "L1" },
  { fixture: "09-vision", flowId: "examples.vision", tiers: ["L3"], costTier: "L3" },
];
