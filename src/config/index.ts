// Flightplan — config/ public surface.
// TOML parse, config zod schemas, type definitions (PLAN.md §4), and the layered
// resolution/merge order (PROPOSAL "Resolution and overrides"). The linter lives in a
// separate module (a different agent owns it) and consumes these exports.

// Types (derived from the schemas; see ./types.ts).
export type {
  AiConfig,
  ArtifactsConfig,
  AssertionsConfig,
  BrowserConfig,
  Config,
  ConfigFile,
  ConnectAttachConfig,
  ConnectConfig,
  ConnectLaunchConfig,
  LogfireConfig,
  ModelPricing,
  ModelRegistry,
  ModelRole,
  RedactionConfig,
  ResolvedConfig,
  RunLimits,
  TelemetryConfig,
} from "./types.ts";

// Schemas (zod 4) — exported so the linter / downstream phases can re-validate.
export {
  AiConfigSchema,
  ArtifactsConfigSchema,
  AssertionsConfigSchema,
  BrowserConfigSchema,
  ChromeChannelSchema,
  ConfigFileSchema,
  ConfigSchema,
  ConnectAttachSchema,
  ConnectConfigSchema,
  ConnectLaunchSchema,
  LogfireConfigSchema,
  ModelPricingSchema,
  ModelRegistrySchema,
  ModelRoleSchema,
  RedactionConfigSchema,
  RunLimitsSchema,
  TelemetryConfigSchema,
} from "./schema.ts";

// Parsing / loading.
export {
  ConfigValidationError,
  formatIssues,
  loadConfigFile,
  parseToml,
  TomlParseError,
} from "./parse.ts";
export type { LoadedConfigFile } from "./parse.ts";

// Resolution / merge.
export {
  BUILTIN_DEFAULTS,
  DEFAULT_AI,
  DEFAULT_BROWSER,
  DEFAULT_REDACTION,
  DEFAULT_RUN_LIMITS,
  mergeConfigLayer,
  resolveConfig,
  resolveConfigWithDefaults,
} from "./resolve.ts";
