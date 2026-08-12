// Flightplan — config zod schemas (the source of truth for Config validation).
//
// Types in `./types.ts` are derived from these schemas via `z.infer` so the runtime
// validator and the compile-time types can never drift. Canonical reference: PLAN.md §4
// ("Config" + "[config.*]" sections) and §3 (ConnectConfig discriminated union), plus
// PROPOSAL_v1.md "Global config example" / "Resolution and overrides".

import { z } from "zod";
import { ASSERTION_MODES, FILE_KINDS } from "../types.ts";

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

/**
 * The `[ai.models]` registry: one entry per named role. All optional (merged key-by-key).
 * `planner` (cheap) + `planner_capable` (escalation-only, UNPROVEN) back the L5 path-repair planner
 * (PLAN_v003 v003-6); override them via `[ai.models.planner]` / `[ai.models.planner_capable]`.
 *
 * `default` is a reserved, non-role key: `[ai.models.default]` sets fallback values applied to
 * EVERY role (resolver/advisor/vision/planner/planner_capable) before the role's own explicit
 * fields are applied. Precedence per field is: explicit role field > `default` field > built-in
 * DEFAULT_MODEL_REGISTRY[role] field (see `resolveRegistry` in src/ai/registry.ts). `default` is
 * never itself a role — it never appears in `MODEL_ROLES`, `ResolvedRegistry`, cost aggregation,
 * or timeout lookups.
 */
export const ModelRegistrySchema = z
  .object({
    resolver: ModelRoleSchema.optional(),
    advisor: ModelRoleSchema.optional(),
    vision: ModelRoleSchema.optional(),
    planner: ModelRoleSchema.optional(),
    planner_capable: ModelRoleSchema.optional(),
    default: ModelRoleSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// [ai] — provider, key env, budgets, model registry
// ---------------------------------------------------------------------------

/**
 * Supported AI transports (Section 2, PLAN update): `"openrouter"` (default) routes every model
 * through OpenRouter slugs; `"google"` / `"openai"` route directly to the native `@ai-sdk/google` /
 * `@ai-sdk/openai` providers, in which case registry model ids are the PROVIDER'S OWN ids (e.g.
 * `gemini-3-pro`, `gpt-5.6-luna`), not OpenRouter slugs.
 */
export const AI_PROVIDERS = ["openrouter", "google", "openai"] as const;

export const AiConfigSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS).optional(),
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
    /**
     * How the driver auto-answers native `alert`/`confirm`/`beforeunload` dialogs so a flow never
     * hangs (PLAN §8 risk #2). `"dismiss"` (default) cancels confirms / rejects beforeunload — the
     * safe automation choice; `"accept"` confirms/OKs them. Threaded into `BrowserPilotDriver`.
     */
    dialog: z.enum(["dismiss", "accept", "fail", "prompt", "manual"]).optional(),
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
    /**
     * Max L5 path-repair replans this run (PLAN_v003 v003-6). Also settable on `[plan]`.
     * `0` = no replans permitted (the first replan trips it); unset = unlimited.
     */
    max_replans: z.number().int().nonnegative().optional(),
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
// [cache] — L0 cache-hit-quality tuning (L0 cache-hit quality, Layer 2)
// ---------------------------------------------------------------------------

/**
 * The `[cache]` block. All fields optional; zero-config (Layer 1) volatile-text masking is always
 * on regardless of this block.
 *
 *  - `ignore_regions` — CSS selectors whose subtrees are excluded from BOTH the masked-text and
 *    the structural hashing (a page-specific escalation of the default volatile-region masking).
 *  - `signature` — `"full"` (default) compares the full composite signature; `"struct-only"`
 *    trusts a cached recipe when the role-tree skeleton is unchanged even if the (masked) text
 *    drifts. A per-step `cache = "full" | "struct-only"` on a targeting step overrides this.
 */
export const CacheConfigSchema = z
  .object({
    ignore_regions: z.array(z.string().min(1)).optional(),
    signature: z.enum(["full", "struct-only"]).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// [resolve] — deterministic-resolution tuning (author-declared selector hooks)
// ---------------------------------------------------------------------------

/**
 * The `[resolve]` block — knobs for the deterministic (L1/L0) resolver. All optional + additive;
 * an absent block keeps the built-in behaviour unchanged.
 *
 *  - `attributes` — EXTRA DOM attribute names the resolver may use as deterministic selector hooks,
 *    in addition to the built-in `data-testid`/`data-test`/`data-qa` set. Threaded into the driver's
 *    `snapshot({ attributeNames })` + `resolveAll({ testIdAttributes })`, so a site-specific hook
 *    like `data-cmd` is surfaced on the snapshot and — when its value is UNIQUE on the page — becomes
 *    a high-confidence `[data-cmd="c2"]` candidate. This lets an icon-only toolbar (no testid / aria /
 *    text) resolve + PERSIST a discriminating durable selector so warm runs replay it at L0 with zero
 *    model calls (Fix 2 BONUS). Default: none (behaviour identical to before).
 */
export const ResolveConfigSchema = z
  .object({
    attributes: z.array(z.string().min(1)).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// [plan] — the L5 cheap-first path-repair planner (PLAN_v003 §4 Phase C / v003-6)
// ---------------------------------------------------------------------------

/**
 * The `[plan]` block — the cheap-first path-repair planner (PLAN_v003 v003-6). DISABLED BY DEFAULT
 * (`enabled` defaults to `false` in the resolved config): the planner is strictly opt-in, so an AI
 * runtime being present never injects replans into a deterministic flow. When enabled it is still
 * INERT unless a divergence has a recorded expectation to compare against.
 *
 *  - `enabled`             — master switch (default FALSE). Set `true` to opt into the planner.
 *  - `escalate_confidence` — planner confidence at/below which the CHEAP arm's repair escalates to
 *    the capable arm (default {@link 0.5}; the escalation signal is UNPROVEN — tune in the field).
 *  - `escalate_attempts`   — how many cheap attempts for ONE divergence before escalating.
 *  - `max_replans`         — run-level hard stop on total replans (also settable on `[run]`);
 *    `0` = no replans permitted, unset = unlimited.
 *
 * The cheap/capable MODELS are overridden via `[ai.models.planner]` / `[ai.models.planner_capable]`
 * (the model registry), NOT here — this block carries only the planner POLICY.
 */
export const PlanConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    escalate_confidence: z.number().min(0).max(1).optional(),
    escalate_attempts: z.number().int().positive().optional(),
    max_replans: z.number().int().nonnegative().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// [timeouts] — action / navigation wall-clock ceilings (fixes the 30s hangs)
// ---------------------------------------------------------------------------

/**
 * The `[timeouts]` block — top-level, per-scenario wall-clock ceilings for browser ACTIONS. All
 * fields optional + defaulted (`DEFAULT_TIMEOUTS` in `./resolve.ts` → `action_ms:5000`,
 * `nav_ms:2000`) and mergeable key-by-key, so it is fully backward compatible.
 *
 *  - `action_ms` — the default actionability/click ceiling (ms) the driver hands browser-pilot for
 *    EVERY batch (L0 replay / L1 race) + single action when the step/caller sets none. It BOUNDS
 *    browser-pilot's own ~30s actionability default, so a disabled/wrong LEADING selector fails fast
 *    (≈`action_ms`) and escalates instead of dead-hanging ~30s (the measured admin-crud L0 stall:
 *    `outcome=escalated durationMs≈30500` then L1 resolved ~90ms). Default `5000`. Tune DOWN
 *    (`2000`–`3000`) for a snappy app, UP for a genuinely slow one. A per-step `timeout_ms`
 *    (flow `stepCommon`) STILL overrides this per action — browser-pilot honors a step's own
 *    `Step.timeout` over the batch-level default.
 *  - `nav_ms` — the client-side navigation-SETTLE ceiling (ms) applied to the driver's post-`goto`/
 *    `press` `waitForNavigation({ optional:true })` wait. Bounds the SPA "navigation that never
 *    happens" settle. Default `2000`.
 *  - `settle_ms` — the flat post-action AX-tree settle (ms) the runner sleeps after EVERY successful
 *    ladder action, before the next step's single L1 snapshot, so Chrome's asynchronously-updated
 *    accessibility tree catches up (the documented stale-AX-tree guarantee). Default `150`; `0`
 *    disables it. Driven by the run clock, so a `FakeClock` incurs zero real delay.
 *  - `ai_call_ms` — the per-model-attempt wall-clock ceiling (ms) for EVERY AI tier call (L2 resolver
 *    / L3 vision / L4 advisor / L5 planner / `ai_judge`), a FLAT override applied to ALL roles.
 *    Threaded by the runner into the AI runtime (`AiCallRuntime.timeoutMsByRole`) so `defaultGenerate`
 *    bounds each `generateText` attempt with `AbortSignal.timeout(ms)`. This is what stops a step's
 *    L1→L2→L3→L4 escalation from hanging tens of seconds (the measured 31s `:repair:` hang; L4 p95
 *    ~22s). UNSET → the role-aware DEFAULT_TIMEOUT_MS_BY_ROLE (a few seconds each, vision gets the most
 *    headroom) apply. Tune DOWN for a snappy provider, UP for a slow one; keep it comfortably above a
 *    real vision round-trip so a genuinely-needed call is never starved.
 */
export const TimeoutsConfigSchema = z
  .object({
    action_ms: z.number().int().positive().optional(),
    nav_ms: z.number().int().positive().optional(),
    settle_ms: z.number().int().nonnegative().optional(),
    ai_call_ms: z.number().int().positive().optional(),
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
    cache: CacheConfigSchema.optional(),
    plan: PlanConfigSchema.optional(),
    timeouts: TimeoutsConfigSchema.optional(),
    resolve: ResolveConfigSchema.optional(),
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
