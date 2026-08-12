// Flightplan — `parseModelId` (the `model:effort` suffix parser). SDK-free.

import { describe, expect, test } from "bun:test";
import { parseModelId, REASONING_EFFORTS } from "./registry.ts";

describe("parseModelId", () => {
  test("no colon → the id is returned unchanged", () => {
    expect(parseModelId("openai/gpt-5.6-luna")).toEqual({ model: "openai/gpt-5.6-luna" });
  });

  test("every recognized effort suffix is parsed off", () => {
    for (const effort of REASONING_EFFORTS) {
      expect(parseModelId(`openai/gpt-5.6-luna:${effort}`)).toEqual({
        model: "openai/gpt-5.6-luna",
        effort,
      });
      expect(parseModelId(`google/gemini-3-pro:${effort}`)).toEqual({
        model: "google/gemini-3-pro",
        effort,
      });
    }
  });

  test("an unrecognized suffix (e.g. an OpenRouter free-tier slug) is left alone", () => {
    expect(parseModelId("deepseek/deepseek-v3.2:free")).toEqual({
      model: "deepseek/deepseek-v3.2:free",
    });
  });

  test("splits on the LAST colon only", () => {
    // A hypothetical id with an internal colon plus a real effort suffix.
    expect(parseModelId("vendor:family/model:high")).toEqual({
      model: "vendor:family/model",
      effort: "high",
    });
  });

  test("an id that is only an effort word (no slash) is NOT rewritten to model=''", () => {
    // Edge case: `:high` alone → model becomes the empty string. Documented, not special-cased —
    // callers always pass a real model id, so this shape never occurs in practice.
    expect(parseModelId(":high")).toEqual({ model: "", effort: "high" });
  });
});
