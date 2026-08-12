// Config tests: parse valid/invalid flightplan.toml, resolution-order precedence,
// mergeable-vs-replaceable behavior.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./index.ts";
import {
  BUILTIN_DEFAULTS,
  ConfigValidationError,
  loadConfigFile,
  mergeConfigLayer,
  parseToml,
  resolveConfig,
  resolveConfigWithDefaults,
  TomlParseError,
} from "./index.ts";

const tmp = mkdtempSync(join(tmpdir(), "fp-config-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeTmp(name: string, text: string): string {
  const p = join(tmp, name);
  writeFileSync(p, text);
  return p;
}

const VALID_CONFIG = `
version = 1
kind = "config"
id = "project"
description = "Shared defaults"

[browser]
provider = "browser-pilot"
version = "0.1.0"
reuse_window = true
record = true

[ai]
provider = "openrouter"
api_key_env = "OPENROUTER_API_KEY"
max_model_calls = 4

[ai.models.resolver]
model = "deepseek/deepseek-v4-flash"
pricing = { in = 0.09, out = 0.18 }

[ai.models.vision]
model = "google/gemini-3-flash-preview"

[telemetry.logfire]
enabled = "auto"
token_env = "LOGFIRE_TOKEN"
service_name = "flightplan"

[assertions]
mode = "eager"
fail_on_failure = true

[redaction]
mask_text = true
redact_media = true

[artifacts]
collocate = true
`;

describe("parseToml", () => {
  test("parses valid TOML", () => {
    const v = parseToml(`a = 1`) as Record<string, unknown>;
    expect(v.a).toBe(1);
  });

  test("throws TomlParseError on malformed TOML", () => {
    expect(() => parseToml(`a = = 1`, "x.toml")).toThrow(TomlParseError);
  });
});

describe("loadConfigFile", () => {
  test("loads + validates a valid config file", async () => {
    const p = writeTmp("flightplan.toml", VALID_CONFIG);
    const { config } = await loadConfigFile(p);
    expect(config.kind).toBe("config");
    expect(config.id).toBe("project");
    expect(config.ai?.models?.resolver?.model).toBe("deepseek/deepseek-v4-flash");
    expect(config.ai?.models?.resolver?.pricing?.in).toBe(0.09);
  });

  test("rejects a config with the wrong kind", async () => {
    const p = writeTmp(
      "wrongkind.toml",
      `version = 1\nkind = "flow"\nid = "x"\ndescription = "d"\n`,
    );
    await expect(loadConfigFile(p)).rejects.toThrow(ConfigValidationError);
  });

  test("rejects a config missing required header fields", async () => {
    const p = writeTmp("noheader.toml", `[browser]\nreuse_window = true\n`);
    await expect(loadConfigFile(p)).rejects.toThrow(ConfigValidationError);
  });

  test("rejects unknown top-level keys (strict)", async () => {
    const p = writeTmp(
      "unknown.toml",
      `version = 1\nkind = "config"\nid = "x"\ndescription = "d"\nbogus = 1\n`,
    );
    await expect(loadConfigFile(p)).rejects.toThrow(ConfigValidationError);
  });

  test("accepts a [cache] block (L0 cache-hit quality — Layer 2)", async () => {
    const p = writeTmp(
      "cache.toml",
      `version = 1
kind = "config"
id = "x"
description = "d"

[cache]
ignore_regions = ["#live-feed", ".ticker", "[data-live]"]
signature = "struct-only"
`,
    );
    const { config } = await loadConfigFile(p);
    expect(config.cache?.signature).toBe("struct-only");
    expect(config.cache?.ignore_regions).toEqual(["#live-feed", ".ticker", "[data-live]"]);
  });

  test("rejects an unknown key inside [cache] (strict)", async () => {
    const p = writeTmp(
      "cache-bad.toml",
      `version = 1\nkind = "config"\nid = "x"\ndescription = "d"\n[cache]\nbogus = 1\n`,
    );
    await expect(loadConfigFile(p)).rejects.toThrow(ConfigValidationError);
  });

  test("rejects an invalid [cache] signature value (strict enum)", async () => {
    const p = writeTmp(
      "cache-bad2.toml",
      `version = 1\nkind = "config"\nid = "x"\ndescription = "d"\n[cache]\nsignature = "loose"\n`,
    );
    await expect(loadConfigFile(p)).rejects.toThrow(ConfigValidationError);
  });
});

describe("resolution-order precedence", () => {
  // built-in -> global -> imported -> flow -> CLI; each later layer wins.
  test("CLI beats flow beats imported beats global beats built-in", () => {
    const global: Config = { ai: { api_key_env: "global" } };
    const imported: Config = { ai: { api_key_env: "imported" } };
    const flow: Config = { ai: { api_key_env: "flow" } };
    const cli: Config = { ai: { api_key_env: "cli" } };

    const resolved = resolveConfig([BUILTIN_DEFAULTS, global, imported, flow, cli]);
    expect(resolved.ai?.api_key_env).toBe("cli");

    // Drop CLI → flow wins.
    expect(resolveConfig([BUILTIN_DEFAULTS, global, imported, flow]).ai?.api_key_env).toBe("flow");
    // Drop flow → imported wins.
    expect(resolveConfig([BUILTIN_DEFAULTS, global, imported]).ai?.api_key_env).toBe("imported");
    // Drop imported → global wins.
    expect(resolveConfig([BUILTIN_DEFAULTS, global]).ai?.api_key_env).toBe("global");
    // Drop global → built-in default (provider-dependent, unset until resolveConfigWithDefaults).
    expect(resolveConfig([BUILTIN_DEFAULTS]).ai?.provider).toBe("openrouter");
  });

  test("built-in defaults supply run/redaction when no layer sets them", () => {
    const resolved = resolveConfigWithDefaults([]);
    expect(resolved.run.assertions).toBe("eager");
    expect(resolved.run.fail_on_assertion).toBe(true);
    expect(resolved.run.assert_timeout_ms).toBe(5000);
    expect(resolved.redaction.mask_text).toBe(true);
    expect(resolved.redaction.redact_media).toBe(true);
  });

  test("the L5 path-repair planner is DISABLED by default (opt-in)", () => {
    expect(resolveConfigWithDefaults([]).plan.enabled).toBe(false);
    // Opt in explicitly.
    expect(resolveConfigWithDefaults([{ plan: { enabled: true } }]).plan.enabled).toBe(true);
  });
});

describe("[timeouts] — action/nav ceilings (fixes 30s hangs)", () => {
  test("built-in defaults supply action_ms=5000 and nav_ms=2000", () => {
    const resolved = resolveConfigWithDefaults([]);
    expect(resolved.timeouts.action_ms).toBe(5000);
    expect(resolved.timeouts.nav_ms).toBe(2000);
  });

  test("an author can tune action_ms down to 2500ms; the unset nav_ms keeps its default", () => {
    const resolved = resolveConfigWithDefaults([{ timeouts: { action_ms: 2500 } }]);
    expect(resolved.timeouts.action_ms).toBe(2500);
    // mergeable key-by-key: nav_ms was not set by the layer → still the built-in default.
    expect(resolved.timeouts.nav_ms).toBe(2000);
  });

  test("a later layer wins per key (CLI/flow override)", () => {
    const resolved = resolveConfigWithDefaults([
      { timeouts: { action_ms: 3000, nav_ms: 1500 } },
      { timeouts: { action_ms: 8000 } },
    ]);
    expect(resolved.timeouts.action_ms).toBe(8000);
    expect(resolved.timeouts.nav_ms).toBe(1500);
  });

  test("loadConfigFile accepts a [timeouts] block", async () => {
    const p = writeTmp(
      "timeouts.toml",
      `version = 1
kind = "config"
id = "x"
description = "d"

[timeouts]
action_ms = 3000
nav_ms = 1500
`,
    );
    const { config } = await loadConfigFile(p);
    expect(config.timeouts?.action_ms).toBe(3000);
    expect(config.timeouts?.nav_ms).toBe(1500);
  });

  test("settle_ms defaults to 150 and is tunable (0 disables the post-action settle)", () => {
    expect(resolveConfigWithDefaults([]).timeouts.settle_ms).toBe(150);
    expect(resolveConfigWithDefaults([{ timeouts: { settle_ms: 0 } }]).timeouts.settle_ms).toBe(0);
    expect(resolveConfigWithDefaults([{ timeouts: { settle_ms: 400 } }]).timeouts.settle_ms).toBe(
      400,
    );
  });

  test("loadConfigFile accepts [timeouts] settle_ms", async () => {
    const p = writeTmp(
      "timeouts-settle.toml",
      `version = 1\nkind = "config"\nid = "x"\ndescription = "d"\n[timeouts]\nsettle_ms = 250\n`,
    );
    const { config } = await loadConfigFile(p);
    expect(config.timeouts?.settle_ms).toBe(250);
  });

  test("rejects a non-positive action_ms (strict)", async () => {
    const p = writeTmp(
      "timeouts-bad.toml",
      `version = 1\nkind = "config"\nid = "x"\ndescription = "d"\n[timeouts]\naction_ms = 0\n`,
    );
    await expect(loadConfigFile(p)).rejects.toThrow(ConfigValidationError);
  });

  test("rejects an unknown key inside [timeouts] (strict)", async () => {
    const p = writeTmp(
      "timeouts-bad2.toml",
      `version = 1\nkind = "config"\nid = "x"\ndescription = "d"\n[timeouts]\nbogus = 1\n`,
    );
    await expect(loadConfigFile(p)).rejects.toThrow(ConfigValidationError);
  });
});

describe("[resolve] — author-declared attribute hooks (Fix 2 BONUS)", () => {
  test("defaults: no [resolve] block → resolve is absent (unchanged behaviour)", () => {
    const resolved = resolveConfigWithDefaults([]);
    expect(resolved.resolve).toBeUndefined();
  });

  test("loadConfigFile accepts a [resolve] attributes array", async () => {
    const p = writeTmp(
      "resolve.toml",
      `version = 1
kind = "config"
id = "x"
description = "d"

[resolve]
attributes = ["data-cmd", "data-role"]
`,
    );
    const { config } = await loadConfigFile(p);
    expect(config.resolve?.attributes).toEqual(["data-cmd", "data-role"]);
  });

  test("a later layer replaces the attributes array wholesale", () => {
    const resolved = resolveConfigWithDefaults([
      { resolve: { attributes: ["data-cmd"] } },
      { resolve: { attributes: ["data-hook"] } },
    ]);
    expect(resolved.resolve?.attributes).toEqual(["data-hook"]);
  });

  test("rejects an unknown key inside [resolve] (strict)", async () => {
    const p = writeTmp(
      "resolve-bad.toml",
      `version = 1\nkind = "config"\nid = "x"\ndescription = "d"\n[resolve]\nbogus = 1\n`,
    );
    await expect(loadConfigFile(p)).rejects.toThrow(ConfigValidationError);
  });
});

describe("mergeable vs replaceable", () => {
  test("model registry is MERGEABLE key-by-key (sibling roles survive)", () => {
    const base: Config = {
      ai: {
        models: {
          resolver: { model: "deepseek/deepseek-v4-flash" },
          advisor: { model: "z-ai/glm-5.2" },
        },
      },
    };
    const over: Config = {
      ai: { models: { vision: { model: "google/gemini-3-flash-preview" } } },
    };
    const merged = mergeConfigLayer(base, over);
    // The over-layer only set `vision`; `resolver` and `advisor` must survive.
    expect(merged.ai?.models?.resolver?.model).toBe("deepseek/deepseek-v4-flash");
    expect(merged.ai?.models?.advisor?.model).toBe("z-ai/glm-5.2");
    expect(merged.ai?.models?.vision?.model).toBe("google/gemini-3-flash-preview");
  });

  test("a later layer overrides one role's model but not its siblings", () => {
    const base: Config = {
      ai: { models: { resolver: { model: "old", fallbacks: ["a", "b"] } } },
    };
    const over: Config = { ai: { models: { resolver: { model: "new" } } } };
    const merged = mergeConfigLayer(base, over);
    expect(merged.ai?.models?.resolver?.model).toBe("new");
    // fallbacks not provided by over → preserved from base.
    expect(merged.ai?.models?.resolver?.fallbacks).toEqual(["a", "b"]);
  });

  test("fallbacks array is REPLACED wholesale, never concatenated", () => {
    const base: Config = {
      ai: { models: { resolver: { model: "m", fallbacks: ["a", "b"] } } },
    };
    const over: Config = {
      ai: { models: { resolver: { model: "m", fallbacks: ["c"] } } },
    };
    const merged = mergeConfigLayer(base, over);
    expect(merged.ai?.models?.resolver?.fallbacks).toEqual(["c"]);
  });

  test("run (RunLimits) is REPLACED wholesale when a layer sets it", () => {
    const base: Config = {
      run: { max_steps: 40, max_cost_usd: 0.05, assertions: "eager" },
    };
    const over: Config = { run: { max_steps: 10 } };
    const merged = mergeConfigLayer(base, over);
    // Wholesale replace: base's max_cost_usd and assertions are gone.
    expect(merged.run?.max_steps).toBe(10);
    expect(merged.run?.max_cost_usd).toBeUndefined();
    expect(merged.run?.assertions).toBeUndefined();
  });

  test("browser config is MERGEABLE key-by-key", () => {
    const base: Config = { browser: { provider: "browser-pilot", reuse_window: true } };
    const over: Config = { browser: { record: true } };
    const merged = mergeConfigLayer(base, over);
    expect(merged.browser?.provider).toBe("browser-pilot");
    expect(merged.browser?.reuse_window).toBe(true);
    expect(merged.browser?.record).toBe(true);
  });

  test("[browser] dialog defaults to dismiss and accepts accept (strict)", async () => {
    // Built-in default.
    expect(resolveConfigWithDefaults([]).browser?.dialog).toBe("dismiss");
    // An author can opt into accepting native dialogs.
    const p = writeTmp(
      "browser-dialog.toml",
      `version = 1\nkind = "config"\nid = "x"\ndescription = "d"\n[browser]\ndialog = "accept"\n`,
    );
    const { config } = await loadConfigFile(p);
    expect(config.browser?.dialog).toBe("accept");
    // Out-of-vocab value is rejected.
    const bad = writeTmp(
      "browser-dialog-bad.toml",
      `version = 1\nkind = "config"\nid = "x"\ndescription = "d"\n[browser]\ndialog = "ignore"\n`,
    );
    await expect(loadConfigFile(bad)).rejects.toThrow(ConfigValidationError);
  });

  test("connect (discriminated union) is REPLACED wholesale across differing modes", () => {
    const base: Config = {
      connect: { mode: "attach", wsUrl: "ws://localhost:9222" },
    };
    const over: Config = { connect: { mode: "launch", headless: true } };
    const merged = mergeConfigLayer(base, over);
    expect(merged.connect?.mode).toBe("launch");
    // No leakage of the attach-only field.
    expect(merged.connect && "wsUrl" in merged.connect).toBe(false);
  });
});

describe("[ai].provider enum + provider-dependent api_key_env default", () => {
  test("provider accepts openrouter | google | openai (strict enum)", async () => {
    for (const provider of ["openrouter", "google", "openai"] as const) {
      const p = writeTmp(
        `ai-provider-${provider}.toml`,
        `version = 1\nkind = "config"\nid = "x"\ndescription = "d"\n[ai]\nprovider = "${provider}"\n`,
      );
      const loaded = await loadConfigFile(p);
      expect(loaded.config.ai?.provider).toBe(provider);
    }
  });

  test("an unknown provider value is rejected (strict enum)", async () => {
    const p = writeTmp(
      "ai-provider-bad.toml",
      `version = 1\nkind = "config"\nid = "x"\ndescription = "d"\n[ai]\nprovider = "anthropic"\n`,
    );
    await expect(loadConfigFile(p)).rejects.toThrow(ConfigValidationError);
  });

  test("no [ai] block → default provider openrouter + OPENROUTER_API_KEY", () => {
    const resolved = resolveConfigWithDefaults([]);
    expect(resolved.ai?.provider).toBe("openrouter");
    expect(resolved.ai?.api_key_env).toBe("OPENROUTER_API_KEY");
  });

  test("provider = google → default api_key_env is GOOGLE_GENERATIVE_AI_API_KEY", () => {
    const resolved = resolveConfigWithDefaults([{ ai: { provider: "google" } }]);
    expect(resolved.ai?.provider).toBe("google");
    expect(resolved.ai?.api_key_env).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
  });

  test("provider = openai → default api_key_env is OPENAI_API_KEY", () => {
    const resolved = resolveConfigWithDefaults([{ ai: { provider: "openai" } }]);
    expect(resolved.ai?.provider).toBe("openai");
    expect(resolved.ai?.api_key_env).toBe("OPENAI_API_KEY");
  });

  test("an explicit api_key_env is NEVER overridden by the provider-dependent default", () => {
    const resolved = resolveConfigWithDefaults([
      { ai: { provider: "google", api_key_env: "MY_CUSTOM_KEY" } },
    ]);
    expect(resolved.ai?.api_key_env).toBe("MY_CUSTOM_KEY");
  });
});
