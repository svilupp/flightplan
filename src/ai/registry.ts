// Flightplan — the config-driven model registry (PLAN.md §4 / §8 risk #4; FINDINGS §1).
//
// Model IDs ROTATE (preview/dated). They are NEVER hardcoded into call sites — the registry is
// the single source of truth, seeded with the defaults proven by FINDINGS_ai_integration and
// overridable per-role via `[ai.models.*]` config. Each role carries `model` + ordered
// `fallbacks` + `pricing` (USD per 1M tokens). Pricing is what makes cost deterministic + offline-
// testable (cost = tokens × role pricing) regardless of provider cost reporting.

import type { ModelPricing, ModelRegistry, ModelRole } from "../config/types.ts";
import type { ModelRoleName } from "../types.ts";

/** A fully-resolved role entry: a model, its ordered fallbacks, and pricing (all present). */
export interface ResolvedModelRole {
  model: string;
  fallbacks: string[];
  pricing: ModelPricing;
}

/** A fully-resolved registry: one {@link ResolvedModelRole} per role. */
export type ResolvedRegistry = Record<ModelRoleName, ResolvedModelRole>;

/**
 * The built-in defaults. IDs + pricing verified against PLAN.md §4 (mermaid (b)) and
 * FINDINGS_ai_integration §1 (no discrepancy). Every fallback is prefixed with its family so the
 * id is a valid OpenRouter slug.
 *  - resolver:        deepseek/deepseek-v4-flash  {in:0.09, out:0.18}
 *  - vision:          google/gemini-3-flash-preview {in:0.50, out:3.00}
 *  - advisor:         z-ai/glm-5.2 {in:0.94, out:3.00}
 *  - planner:         deepseek/deepseek-v4-flash  {in:0.09, out:0.18}  (cheap-first default)
 *  - planner_capable: z-ai/glm-5.2 {in:0.94, out:3.00}  (escalation-only; UNPROVEN)
 *
 * PLAN_v003 §4 Phase C / v003-6: the L5 path-repair planner defaults to the CHEAP `planner` model
 * (resolver-tier pricing — the same cheap DeepSeek family that matched Opus 100% on replanning,
 * FINDINGS §2 pillar b). `planner_capable` is the escalation-only capable arm at advisor-tier
 * pricing; it fires ONLY on the low-confidence / repeated-replan signal and is marked UNPROVEN — a
 * standing expensive planner is a non-goal (PLAN_v003 §6).
 */
export const DEFAULT_MODEL_REGISTRY: ResolvedRegistry = {
  resolver: {
    model: "deepseek/deepseek-v4-flash",
    fallbacks: [
      "deepseek/deepseek-v3.2",
      "deepseek/deepseek-chat-v3.1",
      "deepseek/deepseek-v3.1-terminus",
    ],
    pricing: { in: 0.09, out: 0.18 },
  },
  vision: {
    model: "google/gemini-3-flash-preview",
    fallbacks: [
      "google/gemini-3.1-flash-lite",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-flash-lite",
    ],
    pricing: { in: 0.5, out: 3.0 },
  },
  advisor: {
    model: "z-ai/glm-5.2",
    fallbacks: ["z-ai/glm-4.7", "z-ai/glm-5", "z-ai/glm-4.7-flash"],
    pricing: { in: 0.94, out: 3.0 },
  },
  // Cheap-first planner (default arm). Same cheap DeepSeek family + resolver-tier pricing.
  planner: {
    model: "deepseek/deepseek-v4-flash",
    fallbacks: [
      "deepseek/deepseek-v3.2",
      "deepseek/deepseek-chat-v3.1",
      "deepseek/deepseek-v3.1-terminus",
    ],
    pricing: { in: 0.09, out: 0.18 },
  },
  // Capable planner (escalation-only; UNPROVEN). Advisor-tier model + pricing.
  planner_capable: {
    model: "z-ai/glm-5.2",
    fallbacks: ["z-ai/glm-4.7", "z-ai/glm-5", "z-ai/glm-4.7-flash"],
    pricing: { in: 0.94, out: 3.0 },
  },
};

const ROLES: readonly ModelRoleName[] = [
  "resolver",
  "vision",
  "advisor",
  "planner",
  "planner_capable",
];

/** Merge one role override (field-by-field) onto a default role entry. */
function mergeRole(base: ResolvedModelRole, over: ModelRole | undefined): ResolvedModelRole {
  if (!over) return { ...base, fallbacks: [...base.fallbacks], pricing: { ...base.pricing } };
  return {
    model: over.model ?? base.model,
    // `fallbacks` is an array → replace wholesale when provided (never concatenated), matching
    // config resolution's array policy (resolve.ts header).
    fallbacks: over.fallbacks ? [...over.fallbacks] : [...base.fallbacks],
    pricing: over.pricing ? { ...over.pricing } : { ...base.pricing },
  };
}

/**
 * Resolve the effective registry by merging `config.ai.models` (already config-layer-merged by
 * `resolveConfig`) over {@link DEFAULT_MODEL_REGISTRY}, role-by-role and field-by-field. A config
 * that overrides only `resolver.model` keeps the default resolver fallbacks/pricing AND the full
 * default vision/advisor entries.
 */
export function resolveRegistry(config?: { ai?: { models?: ModelRegistry } }): ResolvedRegistry {
  const over = config?.ai?.models;
  const out = {} as ResolvedRegistry;
  for (const role of ROLES) {
    out[role] = mergeRole(DEFAULT_MODEL_REGISTRY[role], over?.[role]);
  }
  return out;
}

/** The resolved entry for a role. */
export function roleModel(registry: ResolvedRegistry, role: ModelRoleName): ResolvedModelRole {
  return registry[role];
}

/** The ordered model-id list for a role: `[model, ...fallbacks]`. */
export function modelChain(registry: ResolvedRegistry, role: ModelRoleName): string[] {
  const r = registry[role];
  return [r.model, ...r.fallbacks];
}
