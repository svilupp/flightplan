// Flightplan — `./worker` entry contract (workers-slice-2 §7.4/U4).
//
// Proves: (1) the curated barrel actually runs a flow end-to-end with a MockDriver + the
// public memoryFileSystem + flowSource — no real filesystem, no real browser; (2) the barrel
// never exposes `nodeFileSystem` (the whole point of a curated, not `export *`, entry).

import { describe, expect, test } from "bun:test";
import { resolveConfigWithDefaults } from "./config/index.ts";
import { lintText, MockDriver, memoryFileSystem, RunInterruptedError, runFlow } from "./worker.ts";

const FLOW_SOURCE = `
version = 1
kind = "flow"
id = "worker.smoke"
description = "a minimal flow exercised through the ./worker barrel"

[[steps]]
id = "open"
do = "goto"
url = "https://example.test/"
`;

describe("./worker barrel", () => {
  test("runs a flow end-to-end with MockDriver + the public memoryFileSystem", async () => {
    const fs = memoryFileSystem();
    const driver = new MockDriver();
    const result = await runFlow({
      flowPath: "/virtual/flow.toml",
      flowSource: FLOW_SOURCE,
      fs,
      env: {},
      out: "/virtual/runs",
      runId: "worker-smoke",
      config: resolveConfigWithDefaults([{}]),
      driverFactory: () => driver,
      noLockWrite: true,
    });

    expect(result.summary.verdict).toBe("passed");
    expect(driver.callsTo("goto")).toHaveLength(1);
    expect(result.summary.summary_version).toBe(1);
  });

  test("lintText validates a flow with no disk access, using the injected memoryFileSystem", async () => {
    const fs = memoryFileSystem();
    const result = await lintText(FLOW_SOURCE, "/virtual/flow.toml", { fs, cwd: "/virtual" });
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("RunInterruptedError is exported for hosts to catch cancellation", async () => {
    const fs = memoryFileSystem();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runFlow({
        flowPath: "/virtual/flow.toml",
        flowSource: FLOW_SOURCE,
        fs,
        env: {},
        out: "/virtual/runs",
        config: resolveConfigWithDefaults([{}]),
        driverFactory: () => new MockDriver(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RunInterruptedError);
  });

  test("does not export nodeFileSystem (Node-only; adapters/node is a separate subpath)", async () => {
    const mod = await import("./worker.ts");
    expect(Object.keys(mod)).not.toContain("nodeFileSystem");
  });
});
