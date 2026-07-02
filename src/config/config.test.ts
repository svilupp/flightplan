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
    const global: Config = { ai: { provider: "global" } };
    const imported: Config = { ai: { provider: "imported" } };
    const flow: Config = { ai: { provider: "flow" } };
    const cli: Config = { ai: { provider: "cli" } };

    const resolved = resolveConfig([BUILTIN_DEFAULTS, global, imported, flow, cli]);
    expect(resolved.ai?.provider).toBe("cli");

    // Drop CLI → flow wins.
    expect(resolveConfig([BUILTIN_DEFAULTS, global, imported, flow]).ai?.provider).toBe("flow");
    // Drop flow → imported wins.
    expect(resolveConfig([BUILTIN_DEFAULTS, global, imported]).ai?.provider).toBe("imported");
    // Drop imported → global wins.
    expect(resolveConfig([BUILTIN_DEFAULTS, global]).ai?.provider).toBe("global");
    // Drop global → built-in default wins.
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
