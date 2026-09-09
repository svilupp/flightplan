// Flightplan — `runFlow` with an injected in-memory `FileSystemPort` + `flowSource` (no disk I/O).
//
// Proves the Workers-friendly seam: `runFlow` can execute a flow whose source text is supplied
// in-memory (`flowSource`) and whose every filesystem operation (run dir, artifact writers, lock,
// summary) goes through an injected `FileSystemPort` instead of `node:fs` — no real files are
// created anywhere, and the artifacts land in the in-memory map instead.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { FakeClock } from "../assert/clock.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import { MockDriver } from "../driver/index.ts";
import type { FileSystemPort } from "../runtime.ts";
import { runFlow } from "./runner.ts";

/** A trivial Map-backed in-memory {@link FileSystemPort}. No `node:fs` touched. */
function makeMemoryFs(): { fs: FileSystemPort; files: Map<string, string> } {
  const files = new Map<string, string>();
  const fs: FileSystemPort = {
    async readTextFile(path: string): Promise<string> {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    async writeTextFile(path: string, text: string): Promise<void> {
      files.set(path, text);
    },
    async appendTextFile(path: string, text: string): Promise<void> {
      files.set(path, (files.get(path) ?? "") + text);
    },
    async fileExists(path: string): Promise<boolean> {
      return files.has(path);
    },
    async mkdir(): Promise<void> {
      // No directories in a flat Map — a no-op is a faithful in-memory analogue.
    },
  };
  return { fs, files };
}

const FLOW_SOURCE = `
version = 1
kind = "flow"
id = "test.fs-port"
description = "a minimal flow for the FileSystemPort seam"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/"
`;

describe("runFlow with an injected FileSystemPort + flowSource", () => {
  test("runs from in-memory flow source, writes artifacts only into the injected fs", async () => {
    const { fs, files } = makeMemoryFs();
    const driver = new MockDriver();
    const config = resolveConfigWithDefaults([{}]);
    const clock = new FakeClock();

    const result = await runFlow({
      flowPath: "/virtual/flow.toml",
      flowSource: FLOW_SOURCE,
      config,
      out: "/virtual/.flightplan-runs",
      fs,
      driverFactory: () => driver,
      clock,
      runId: "testrun-fsport-0001",
      env: {},
    });

    expect(result.summary.verdict).toBe("passed");
    expect(result.exitCode).toBe(0);

    // Artifacts landed in the in-memory map, keyed under the injected run dir.
    expect(files.has(`${result.runDir}/summary.json`)).toBe(true);
    expect(files.has(`${result.runDir}/run.jsonl`)).toBe(true);
    const runJsonl = files.get(`${result.runDir}/run.jsonl`) ?? "";
    expect(runJsonl).toContain('"run_start"');
    expect(runJsonl).toContain('"run_end"');

    const summaryJson = files.get(`${result.runDir}/summary.json`) ?? "";
    expect(JSON.parse(summaryJson).verdict).toBe("passed");

    // Nothing leaked to the REAL filesystem: neither the virtual root nor the run dir exists
    // on disk — every write went through the injected port into the map.
    expect(existsSync("/virtual")).toBe(false);
    expect(existsSync(result.runDir)).toBe(false);
    expect(files.size).toBeGreaterThan(0);
  });
});
