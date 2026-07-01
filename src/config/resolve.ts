// Flightplan — config resolution / merge order.
//
// Resolution order (PROPOSAL "Resolution and overrides", PLAN.md §5 Phase 1):
//
//   built-in defaults
//     -> global flightplan.toml
//       -> imported flow/module defaults
//         -> top-level (invoked) flow config
//           -> CLI overrides
//
// Each later layer wins over earlier ones. `resolveConfig(layers)` folds the layers
// left-to-right in that precedence.
//
// MERGEABLE vs REPLACEABLE (open-question #7 — decided here; flagged in the report):
//
//   MERGEABLE (deep-merged key-by-key; a later layer adds/overrides individual keys but
//   does NOT wipe sibling keys a lower layer set):
//     - `ai.models` registry         — merged per role (resolver/advisor/vision), and
//                                       within a role each field (model/fallbacks/pricing)
//                                       is replaced wholesale if the later layer sets it.
//     - `ai` scalar fields           — provider, api_key_env, etc. merged key-by-key.
//     - `browser`, `telemetry.logfire`, `artifacts`, `redaction` — merged key-by-key.
//     - `connect`                    — see special-case note below.
//
//   REPLACEABLE (a later layer that sets the field replaces the whole object; chosen so a
//   flow can declare a self-contained budget without inheriting stray ceilings):
//     - `run` (RunLimits / budgets)  — replaced WHOLESALE when a layer provides `run`.
//     - `ai.models.<role>.fallbacks` — array; replaced wholesale, never concatenated.
//     - any other array              — replaced wholesale (arrays are never concatenated).
//
//   SPECIAL CASE — `connect`: it is a discriminated union (attach | launch). Merging two
//   layers with different `mode`s would produce an invalid mixed object, so `connect` is
//   replaced WHOLESALE whenever a later layer sets it (the later layer's `mode` and all of
//   its fields win); never partially merged across differing modes.

import { ConfigSchema } from "./schema.ts";
import type {
  Config,
  ConnectConfig,
  ModelRegistry,
  ModelRole,
  ResolvedConfig,
  RunLimits,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Built-in defaults — the lowest layer. Documented and intentionally minimal:
// only fields with a genuinely sensible universal default are set here.
// ---------------------------------------------------------------------------

/** Default run budgets / assertion behavior. Replaced wholesale by any layer's `run`. */
export const DEFAULT_RUN_LIMITS: Required<
  Pick<RunLimits, "assertions" | "fail_on_assertion" | "assert_timeout_ms">
> = {
  assertions: "eager",
  fail_on_assertion: true,
  assert_timeout_ms: 5000, // PROPOSAL "Implicit waiting": a few seconds
};

/** Default redaction: secrets/PII masked, media redacted (PROPOSAL "Secrets and redaction"). */
export const DEFAULT_REDACTION = {
  mask_text: true,
  redact_media: true,
} as const;

/** Default AI provider/key wiring (PROPOSAL "Hard decisions"). Models stay unset by default
 * (the registry is config-driven; PLAN.md §8 risk #4 — never hardcode model ids). */
export const DEFAULT_AI = {
  provider: "openrouter",
  api_key_env: "OPENROUTER_API_KEY",
} as const;

/** Default browser wiring: attach to an existing window (PROPOSAL "Global config example"). */
export const DEFAULT_BROWSER = {
  provider: "browser-pilot",
  reuse_window: true,
} as const;

/** The complete built-in defaults layer. */
export const BUILTIN_DEFAULTS: Config = {
  browser: { ...DEFAULT_BROWSER },
  ai: { ...DEFAULT_AI },
  run: { ...DEFAULT_RUN_LIMITS },
  redaction: { ...DEFAULT_REDACTION },
};

// ---------------------------------------------------------------------------
// Merge primitives
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `over` onto `base`. Plain objects merge key-by-key; arrays and scalars from
 * `over` REPLACE `base`. `undefined` values in `over` are ignored (they do not clear a base
 * value) — a layer "not setting" a field must leave it absent, not `undefined`.
 */
function deepMerge<T extends Record<string, unknown>>(base: T, over: Partial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, overVal] of Object.entries(over)) {
    if (overVal === undefined) continue;
    const baseVal = out[key];
    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      out[key] = deepMerge(baseVal, overVal);
    } else {
      // arrays + scalars + object-over-nonobject → replace wholesale
      out[key] = overVal;
    }
  }
  return out as T;
}

/** Merge two model registries role-by-role. Within a role, fields replace wholesale. */
function mergeModelRegistry(
  base: ModelRegistry | undefined,
  over: ModelRegistry | undefined,
): ModelRegistry | undefined {
  if (!base) return over;
  if (!over) return base;
  const out: ModelRegistry = { ...base };
  for (const role of ["resolver", "advisor", "vision"] as const) {
    const o = over[role];
    if (o === undefined) continue;
    const b = base[role];
    // Within a role: deep-merge the scalar fields, but a provided `fallbacks` array
    // replaces wholesale (arrays are never concatenated — see header).
    out[role] = b ? (deepMerge(b as Record<string, unknown>, o) as ModelRole) : o;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The single layer-merge step, honoring mergeable vs replaceable rules.
// ---------------------------------------------------------------------------

/**
 * Merge config layer `over` onto `base` per the documented precedence rules. `over` wins.
 */
export function mergeConfigLayer(base: Config, over: Config): Config {
  // Start with a plain deep-merge of everything...
  const merged = deepMerge(
    base as Record<string, unknown>,
    over as Record<string, unknown>,
  ) as Config;

  // ...then apply the explicit overrides for the special-cased fields.

  // REPLACEABLE: `run` is replaced wholesale when the over-layer provides it.
  if (over.run !== undefined) {
    merged.run = { ...over.run };
  }

  // SPECIAL CASE: `connect` (discriminated union) is replaced wholesale by a later layer.
  if (over.connect !== undefined) {
    merged.connect = over.connect as ConnectConfig;
  }

  // MERGEABLE (key-by-key): the model registry merges per role.
  if (base.ai?.models || over.ai?.models) {
    const mergedModels = mergeModelRegistry(base.ai?.models, over.ai?.models);
    if (mergedModels) {
      merged.ai = { ...merged.ai, models: mergedModels };
    }
  }

  return merged;
}

/**
 * Fold an ordered list of config layers into a single resolved config. Layers are given in
 * ASCENDING precedence (earliest = lowest priority). Pass them in resolution order:
 *
 *   resolveConfig([BUILTIN_DEFAULTS, global, ...importedDefaults, flowConfig, cliOverrides])
 *
 * Built-in defaults are NOT auto-prepended — pass `BUILTIN_DEFAULTS` explicitly (or use
 * {@link resolveConfigWithDefaults}) so callers stay in control of the base layer.
 */
export function resolveConfig(layers: ReadonlyArray<Config>): Config {
  return layers.reduce<Config>((acc, layer) => mergeConfigLayer(acc, layer), {});
}

/**
 * Convenience wrapper that prepends {@link BUILTIN_DEFAULTS} and asserts the merged result
 * is a valid Config (it always should be, since every layer was already validated). Returns
 * a {@link ResolvedConfig} with the always-present sections (`run`, `redaction`) guaranteed.
 */
export function resolveConfigWithDefaults(
  layers: ReadonlyArray<Config>,
): ResolvedConfig {
  const merged = resolveConfig([BUILTIN_DEFAULTS, ...layers]);
  // Re-validate the merged shape (defense-in-depth; cheap, and catches a bad CLI override).
  const parsed = ConfigSchema.parse(merged);
  return {
    ...parsed,
    run: parsed.run ?? { ...DEFAULT_RUN_LIMITS },
    redaction: parsed.redaction ?? { ...DEFAULT_REDACTION },
  };
}
