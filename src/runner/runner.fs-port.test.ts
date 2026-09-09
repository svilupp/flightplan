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
import type { FileSystemPort } from "../index.ts";
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
    async readDir(): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>> {
      // No directory hierarchy in a flat Map; nothing in these tests walks directories.
      return [];
    },
    async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean } | null> {
      return files.has(path) ? { isFile: true, isDirectory: false } : null;
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
  test.each(["/virtual/", "virtual/", ""])(
    "resolves imports, child flows, and hooks from %sroot.toml",
    async (prefix) => {
      const { fs, files } = makeMemoryFs();
      const driver = new MockDriver();
      const header = (id: string) => `version=1\nkind="flow"\nid="${id}"\ndescription="test"\n`;
      const step = (id: string) =>
        `[[steps]]\nid="${id}"\ndo="goto"\nurl="https://example.test/${id}"\n`;
      files.set(
        `${prefix}root.toml`,
        header("root") +
          'imports="./child.toml"\nsetup="./setup.toml"\nteardown="./teardown.toml"\n' +
          step("root") +
          '[[steps]]\nid="child"\ndo="run"\nflow="./nested/../child.toml"\n',
      );
      for (const id of ["setup", "teardown", "child"])
        files.set(`${prefix}${id}.toml`, header(id) + step(id));
      const result = await runFlow({
        flowPath: `${prefix}root.toml`,
        fs,
        env: {},
        out: "/virtual/runs",
        runId: "hooks",
        config: resolveConfigWithDefaults([{}]),
        driverFactory: () => driver,
        clock: new FakeClock(),
        frozen: true,
        noLockWrite: true,
      });
      expect(result.summary.verdict).toBe("passed");
      expect(driver.callsTo("goto")).toHaveLength(4);
      expect([...files.keys()].some((path) => path.endsWith(".lock.toml"))).toBe(false);
    },
  );

  test("stores binary frames through fs and never invokes native media writers", async () => {
    const { fs, files } = makeMemoryFs();
    const binary = new Map<string, Uint8Array>();
    fs.writeBinaryFile = async (path, bytes) => {
      binary.set(path, bytes);
    };
    const driver = new MockDriver();
    driver.setScreenshot("AP+A/w==");
    const result = await runFlow({
      flowPath: "/virtual/media.toml",
      flowSource: FLOW_SOURCE,
      fs,
      env: {},
      out: "/virtual/runs",
      runId: "media",
      config: resolveConfigWithDefaults([{ browser: { record: true } }]),
      driverFactory: () => driver,
      clock: new FakeClock(),
    });
    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.screenshot_paths).toEqual([
      "/virtual/runs/media/screenshots/000-open.png",
    ]);
    expect(binary.get(result.summary.screenshot_paths[0]!)).toEqual(
      new Uint8Array([0, 255, 128, 255]),
    );
    expect(driver.callsTo("saveScreenshot")).toHaveLength(0);
    expect(driver.callsTo("startRecording")).toHaveLength(0);
    expect(driver.callsTo("stopRecording")).toHaveLength(0);
    expect(files.has("/virtual/runs/media/summary.json")).toBe(true);
    expect(existsSync("/virtual/runs/media")).toBe(false);
  });

  test("rejects unsupported recording before opening a browser or writing artifacts", async () => {
    const { fs, files } = makeMemoryFs();
    const driver = new MockDriver();
    await expect(
      runFlow({
        flowPath: "/virtual/media.toml",
        flowSource: FLOW_SOURCE,
        fs,
        env: {},
        config: resolveConfigWithDefaults([{ browser: { record: true } }]),
        driverFactory: () => driver,
      }),
    ).rejects.toThrow("fs.writeBinaryFile");
    expect(driver.calls).toHaveLength(0);
    expect(files.size).toBe(0);
  });

  test("binary storage failures fail the run without claiming a saved screenshot", async () => {
    const { fs } = makeMemoryFs();
    fs.writeBinaryFile = async () => {
      throw new Error("artifact storage unavailable");
    };
    const driver = new MockDriver();
    driver.setScreenshot("AP8=");
    const result = await runFlow({
      flowPath: "/virtual/media.toml",
      flowSource: FLOW_SOURCE,
      fs,
      env: {},
      out: "/virtual/runs",
      runId: "failed-media",
      config: resolveConfigWithDefaults([{ browser: { record: true } }]),
      driverFactory: () => driver,
      clock: new FakeClock(),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary.screenshot_paths).toEqual([]);
    expect(driver.callsTo("teardown")).toHaveLength(1);
  });

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

describe("env hygiene — secret env values never leak into artifacts", () => {
  test("a sentinel API-key env value never appears in any artifact file or the summary JSON", async () => {
    const { fs, files } = makeMemoryFs();
    const driver = new MockDriver();
    const flowSource = `
version = 1
kind = "flow"
id = "test.env-hygiene"
description = "interpolates \${env.SITE} but must never leak \${env.OPENROUTER_API_KEY}"

[[steps]]
id = "open"
do = "goto"
url = "\${env.SITE}/login"
`;

    const result = await runFlow({
      flowPath: "/virtual/flow.toml",
      flowSource,
      fs,
      env: { OPENROUTER_API_KEY: "sk-SENTINEL-abc123", SITE: "https://example.test" },
      out: "/virtual/runs",
      runId: "env-hygiene",
      config: resolveConfigWithDefaults([{}]),
      driverFactory: () => driver,
      clock: new FakeClock(),
      noLockWrite: true,
    });

    expect(result.summary.verdict).toBe("passed");
    // SITE was actually interpolated and used for the goto — proves this isn't a vacuous pass.
    expect(driver.callsTo("goto")[0]?.args[0]).toBe("https://example.test/login");

    const SENTINEL = "sk-SENTINEL-abc123";
    for (const [path, content] of files) {
      expect(content).not.toContain(SENTINEL);
      void path;
    }
    expect(JSON.stringify(result.summary)).not.toContain(SENTINEL);
  });
});
