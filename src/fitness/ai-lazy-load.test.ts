// AI lazy-load failure resilience test (workers-slice-2 §U6 task 5 / §2.8).
//
// `runFlow` never statically imports the AI SDK: the default-generate branch reaches
// `ai/provider.ts` only through a cached computed-specifier dynamic import of
// `ai/default-generate.ts` (see `src/runner/runner.ts`'s `loadDefaultGenerateModule`). On a host
// that cannot resolve that module (e.g. a bundled Worker without the SDKs), the import rejects
// and the run must still complete AI-less rather than crash, with `onWarn` naming the cause.
//
// This test does NOT delete/rename the real module (that would be a filesystem mutation outside
// this gate's remit, and would race the parallel `src/shell/**` work). Instead it uses the
// tiny test-only seam `__setDefaultGenerateLoaderForTests` (added to `src/runner/runner.ts` for
// exactly this purpose) to force the lazy loader to reject, then restores the real loader
// afterwards so this file leaves no cross-test residue.

import { afterEach, describe, expect, test } from "bun:test";
import { memoryFileSystem } from "../adapters/memory.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import { MockDriver } from "../driver/index.ts";
import { __setDefaultGenerateLoaderForTests, runFlow } from "../runner/runner.ts";

const FLOW_SOURCE = `
version = 1
kind = "flow"
id = "ai-lazy-load.fixture"
description = "a minimal flow used to exercise buildAiRuntime's lazy-import failure path"

[[steps]]
id = "open"
do = "goto"
url = "https://example.test/"
`;

describe("AI lazy-load failure resilience", () => {
  afterEach(() => {
    // Always restore the real loader, even if an assertion above throws mid-test.
    __setDefaultGenerateLoaderForTests(undefined);
  });

  test("runFlow completes AI-less when the lazy default-generate import rejects, and onWarn names the cause", async () => {
    const cause = new Error("simulated: module not found in this bundle");
    __setDefaultGenerateLoaderForTests(() => Promise.reject(cause));

    const warnings: string[] = [];
    const fs = memoryFileSystem();
    const driver = new MockDriver();

    const result = await runFlow({
      flowPath: "/virtual/flow.toml",
      flowSource: FLOW_SOURCE,
      fs,
      // No aiRuntimeFactory injected, so buildAiRuntime takes the default-generate branch —
      // but an OPENROUTER_API_KEY must be present in `env` for it to even attempt the lazy
      // import (no key => buildAiRuntime returns undefined before ever touching the loader,
      // which would defeat the point of this test).
      env: { OPENROUTER_API_KEY: "fixture-key-not-used" },
      out: "/virtual/runs",
      runId: "ai-lazy-load",
      config: resolveConfigWithDefaults([{}]),
      driverFactory: () => driver,
      noLockWrite: true,
      onWarn: (message) => warnings.push(message),
    });

    // The run completes (AI-less) rather than rejecting/crashing.
    expect(result.summary.verdict).toBe("passed");
    expect(driver.callsTo("goto")).toHaveLength(1);

    // onWarn received exactly one AI-unavailable warning, and it includes the cause's message.
    const aiWarnings = warnings.filter((w) => w.includes("AI SDK unavailable"));
    expect(aiWarnings).toHaveLength(1);
    expect(aiWarnings[0]).toContain(cause.message);
  });
});
