// Flightplan — config zod schemas (the source of truth for Config validation).
//
// Types in `./types.ts` are derived from these schemas via `z.infer` so the runtime
// validator and the compile-time types can never drift. Canonical reference: PLAN.md §4
// ("Config" + "[config.*]" sections) and §3 (ConnectConfig discriminated union), plus
// PROPOSAL_v1.md "Global config example" / "Resolution and overrides".

import { z } from "zod";
import {
  ASSERTION_MODES,
  FILE_KINDS,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Model registry — [ai.models.{resolver,advisor,vision}] (PLAN.md §4 ModelRole)
// ---------------------------------------------------------------------------

/** Per-role model pricing in USD per 1M tokens (`in` = prompt, `out` = completion). */
export const ModelPricingSchema = z
  .object({
    in: z.number().nonnegative(),
    out: z.number().nonnegative(),
  })
  .strict();

/** A single model role: primary `model` id, optional ordered `fallbacks`, optional pricing. */
export const ModelRoleSchema = z
  .object({
    model: z.string().min(1),
    fallbacks: z.array(z.string().min(1)).optional(),
    pricing: ModelPricingSchema.optional(),
  })
  .strict();

/** The `[ai.models]` registry: one entry per named role. All optional (merged key-by-key). */
export const ModelRegistrySchema = z
  .object({
    resolver: ModelRoleSchema.optional(),
    advisor: ModelRoleSchema.optional(),
    vision: ModelRoleSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// [ai] — provider, key env, budgets, model registry
// ---------------------------------------------------------------------------

export const AiConfigSchema = z
  .object({
    provider: z.string().min(1).optional(),
    api_key_env: z.string().min(1).optional(),
    // budgets may live under [ai] (global) and/or [run] (flow-local). Both are allowed.
    max_model_calls: z.number().int().nonnegative().optional(),
    max_screenshots: z.number().int().nonnegative().optional(),
    models: ModelRegistrySchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// [browser] — provider / version pin / connect mode / record
// ---------------------------------------------------------------------------

export const BrowserConfigSchema = z
  .object({
    provider: z.string().min(1).optional(),
    /** Pinned browser-pilot version (pre-1.0). */
    version: z.string().min(1).optional(),
    /** true → attach (Mode A) to an existing window; false → launch (Mode B). */
    reuse_window: z.boolean().optional(),
    /** Enable browser-pilot record/trace (screenshots + video on disk). */
    record: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Connect config — discriminated union (PLAN.md §3). Derived from [browser] +
// connection fields. Mode A = attach (BYO/debug Chrome), Mode B = launch.
// ---------------------------------------------------------------------------

export const ChromeChannelSchema = z.enum(["stable", "beta", "dev", "canary"]);

export const ConnectAttachSchema = z
  .object({
    mode: z.literal("attach"),
    /** Most deterministic — passed straight to connect(). */
    wsUrl: z.string().min(1).optional(),
    /** 'host:port' → resolved to a wsUrl via getBrowserWebSocketUrl() (CLI-only flag). */
    browserURL: z.string().min(1).optional(),
    autodiscover: z
      .object({
        channel: ChromeChannelSchema.optional(),
        userDataDir: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    /** Reuse a matching tab instead of opening a fresh one. */
    targetUrl: z.string().min(1).optional(),
    sessionName: z.string().min(1).optional(),
  })
  .strict();

export const ConnectLaunchSchema = z
  .object({
    mode: z.literal("launch"),
    headless: z.boolean().optional(), // default true (applied in resolve defaults)
    channel: z.string().min(1).optional(),
    userDataDir: z.string().min(1).optional(),
    chromeFlags: z.array(z.string()).optional(),
  })
  .strict();

export const ConnectConfigSchema = z.discriminatedUnion("mode", [
  ConnectAttachSchema,
  ConnectLaunchSchema,
]);

// ---------------------------------------------------------------------------
// [run] — RunLimits (PLAN.md §4). Budgets + assertion behavior.
// ---------------------------------------------------------------------------

export const RunLimitsSchema = z
  .object({
    max_steps: z.number().int().nonnegative().optional(),
    max_model_calls: z.number().int().nonnegative().optional(),
    max_screenshots: z.number().int().nonnegative().optional(),
    max_cost_usd: z.number().nonnegative().optional(),
    assertions: z.enum(ASSERTION_MODES).optional(),
    fail_on_assertion: z.boolean().optional(),
    assert_timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// [assertions] — global assertion defaults (PROPOSAL "[assertions]").
// Note the proposal's global block uses `mode`/`fail_on_failure`, while [run] uses
// `assertions`/`fail_on_assertion`. We accept both spellings here and normalize in resolve.
// ---------------------------------------------------------------------------

export const AssertionsConfigSchema = z
  .object({
    mode: z.enum(ASSERTION_MODES).optional(),
    fail_on_failure: z.boolean().optional(),
    assert_timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// [telemetry.logfire] (PROPOSAL "Logfire")
// ---------------------------------------------------------------------------

export const LogfireConfigSchema = z
  .object({
    /** auto | true | false (string in TOML; `true`/`false` booleans also accepted). */
    enabled: z.union([z.enum(["auto"]), z.boolean()]).optional(),
    token_env: z.string().min(1).optional(),
    service_name: z.string().min(1).optional(),
  })
  .strict();

export const TelemetryConfigSchema = z
  .object({
    logfire: LogfireConfigSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// [redaction] (PROPOSAL "Secrets and redaction")
// ---------------------------------------------------------------------------

export const RedactionConfigSchema = z
  .object({
    mask_text: z.boolean().optional(),
    redact_media: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// [artifacts] — output/lock path policy (PROPOSAL "Run artifacts" / "Locks")
// ---------------------------------------------------------------------------

export const ArtifactsConfigSchema = z
  .object({
    /** Collocate locks/runs next to the flow file (default true). */
    collocate: z.boolean().optional(),
    /** Default run-output directory (overridable via CLI -o). */
    out_dir: z.string().min(1).optional(),
    /** Default lock path (overridable via CLI --lock). */
    lock_path: z.string().min(1).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// The full Config object (all sections optional; built-in defaults fill the gaps).
// ---------------------------------------------------------------------------

export const ConfigSchema = z
  .object({
    browser: BrowserConfigSchema.optional(),
    connect: ConnectConfigSchema.optional(),
    ai: AiConfigSchema.optional(),
    run: RunLimitsSchema.optional(),
    assertions: AssertionsConfigSchema.optional(),
    telemetry: TelemetryConfigSchema.optional(),
    redaction: RedactionConfigSchema.optional(),
    artifacts: ArtifactsConfigSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// The on-disk config FILE (flightplan.toml): the header + a Config body.
// kind === 'config'. Header fields per PLAN.md §4 / PROPOSAL "File kinds".
// ---------------------------------------------------------------------------

export const ConfigFileSchema = ConfigSchema.extend({
  version: z.number().int().positive(),
  kind: z.literal(FILE_KINDS[0]), // "config"
  id: z.string().min(1),
  description: z.string().min(1),
}).strict();
