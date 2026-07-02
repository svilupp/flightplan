// Flightplan — config TS types.
//
// These are DERIVED from the zod schemas in `./schema.ts` via `z.infer`, so the
// compile-time types and the runtime validator stay in lock-step (a deliberate choice:
// PLAN.md §4 calls out that a type/schema mismatch propagates to every later phase).
// Hand-written aliases below add documentation and the canonical names downstream modules
// import. Canonical reference: PLAN.md §4 ("Config"), §3 (ConnectConfig).

import type { z } from "zod";
import type {
  AiConfigSchema,
  ArtifactsConfigSchema,
  AssertionsConfigSchema,
  BrowserConfigSchema,
  CacheConfigSchema,
  ConfigFileSchema,
  ConfigSchema,
  ConnectAttachSchema,
  ConnectConfigSchema,
  ConnectLaunchSchema,
  LogfireConfigSchema,
  ModelPricingSchema,
  ModelRegistrySchema,
  ModelRoleSchema,
  PlanConfigSchema,
  RedactionConfigSchema,
  ResolveConfigSchema,
  RunLimitsSchema,
  TelemetryConfigSchema,
  TimeoutsConfigSchema,
} from "./schema.ts";

// ---- Model registry ----
export type ModelPricing = z.infer<typeof ModelPricingSchema>;
export type ModelRole = z.infer<typeof ModelRoleSchema>;
export type ModelRegistry = z.infer<typeof ModelRegistrySchema>;

// ---- Sections ----
export type AiConfig = z.infer<typeof AiConfigSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type RunLimits = z.infer<typeof RunLimitsSchema>;
export type AssertionsConfig = z.infer<typeof AssertionsConfigSchema>;
export type LogfireConfig = z.infer<typeof LogfireConfigSchema>;
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;
export type RedactionConfig = z.infer<typeof RedactionConfigSchema>;
export type ArtifactsConfig = z.infer<typeof ArtifactsConfigSchema>;
export type CacheConfig = z.infer<typeof CacheConfigSchema>;
export type PlanConfig = z.infer<typeof PlanConfigSchema>;
export type TimeoutsConfig = z.infer<typeof TimeoutsConfigSchema>;
export type ResolveConfig = z.infer<typeof ResolveConfigSchema>;

// ---- Connect config (discriminated union, PLAN.md §3) ----
export type ConnectAttachConfig = z.infer<typeof ConnectAttachSchema>;
export type ConnectLaunchConfig = z.infer<typeof ConnectLaunchSchema>;
export type ConnectConfig = z.infer<typeof ConnectConfigSchema>;

// ---- The full Config object & on-disk config file ----
export type Config = z.infer<typeof ConfigSchema>;
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/**
 * A fully-resolved config where the fields built-in defaults always supply are guaranteed
 * present. Produced by `resolveConfig` (see `./resolve.ts`). Mergeable maps (model
 * registry) are present; the rest of `Config` stays optional because not every section has
 * a meaningful default.
 */
export interface ResolvedConfig extends Config {
  run: RunLimits; // always populated from DEFAULT_RUN_LIMITS merged with layers
  redaction: RedactionConfig; // mask_text/redact_media always have a default
  /**
   * The L5 path-repair planner policy (PLAN_v003 v003-6), always present in a resolved config with
   * `enabled` defaulted to TRUE (the planner is enabled-by-default for a prod field test). Inert at
   * runtime unless an AI runtime is present AND a divergence has a recorded expectation, so a
   * deterministic run stays byte-identical regardless of this flag.
   */
  plan: PlanConfig & { enabled: boolean };
  /**
   * Action / navigation wall-clock ceilings (`[timeouts]`), always present in a resolved config
   * with `action_ms` (default 5000) and `nav_ms` (default 2000) GUARANTEED. The runner threads
   * these into `BrowserPilotDriver` (`actionTimeoutMs`/`navTimeoutMs`) so browser-pilot's ~30s
   * actionability default never applies — a disabled/wrong leading selector fails fast (≈5s) and
   * escalates instead of dead-hanging. A per-step `timeout_ms` still overrides `action_ms`.
   */
  timeouts: TimeoutsConfig & { action_ms: number; nav_ms: number };
}
