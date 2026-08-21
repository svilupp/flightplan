// Flightplan — config/ public surface.
// TOML parse, config zod schemas, type definitions (PLAN.md §4), and the layered
// resolution/merge order (PROPOSAL "Resolution and overrides"). The linter lives in a
// separate module (a different agent owns it) and consumes these exports.

export type { LoadedConfigFile } from "./parse.ts";
// Parsing / loading.
export {
  ConfigValidationError,
  formatIssues,
  loadConfigFile,
  parseToml,
  TomlParseError,
} from "./parse.ts";
// Resolution / merge.
export {
  BUILTIN_DEFAULTS,
  DEFAULT_AI,
  DEFAULT_BROWSER,
  DEFAULT_PLAN,
  DEFAULT_REDACTION,
  DEFAULT_RUN_LIMITS,
  mergeConfigLayer,
  resolveConfig,
  resolveConfigWithDefaults,
} from "./resolve.ts";
// Schemas (zod 4) — exported so the linter / downstream phases can re-validate.
export {
  AiConfigSchema,
  ArtifactsConfigSchema,
  AssertionsConfigSchema,
  AuthConfigSchema,
  AuthCookieConfigSchema,
  BrowserConfigSchema,
  CacheConfigSchema,
  CfAccessConfigSchema,
  ChromeChannelSchema,
  ConfigFileSchema,
  ConfigSchema,
  ConnectAttachSchema,
  ConnectConfigSchema,
  ConnectLaunchSchema,
  ExtraHeadersConfigSchema,
  LogfireConfigSchema,
  ModelPricingSchema,
  ModelRegistrySchema,
  ModelRoleSchema,
  PlanConfigSchema,
  RedactionConfigSchema,
  RunLimitsSchema,
  TelemetryConfigSchema,
} from "./schema.ts";
// Types (derived from the schemas; see ./types.ts).
export type {
  AiConfig,
  ArtifactsConfig,
  AssertionsConfig,
  AuthConfig,
  AuthCookieConfig,
  BrowserConfig,
  CacheConfig,
  CfAccessConfig,
  Config,
  ConfigFile,
  ConnectAttachConfig,
  ConnectConfig,
  ConnectLaunchConfig,
  ExtraHeadersConfig,
  LogfireConfig,
  ModelPricing,
  ModelRegistry,
  ModelRole,
  PlanConfig,
  RedactionConfig,
  ResolvedConfig,
  RunLimits,
  TelemetryConfig,
} from "./types.ts";
