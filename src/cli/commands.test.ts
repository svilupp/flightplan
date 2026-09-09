// Flightplan — `executeLint`/`executeRun` (workers-slice-2 §5/U4).
//
// Proves the process-free command core works with an injected `FileSystemPort` + `MockDriver`
// (no real filesystem, no real browser) and that the exit-code contract (0/1/2/3 + 124/130)
// holds independent of the native Node CLI shell.

import { describe, expect, test } from "bun:test";
import { memoryFileSystem } from "../adapters/memory.ts";
import { MockDriver } from "../driver/index.ts";
import { type CommandIO, executeLint, executeRun } from "./commands.ts";

const FLOW_SOURCE = `
version = 1
kind = "flow"
id = "cli.commands.smoke"
description = "a minimal flow for executeLint/executeRun"

[[steps]]
id = "open"
do = "goto"
url = "https://example.test/"
`;

function makeIo(overrides?: Partial<CommandIO>): { io: CommandIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: CommandIO = {
    fs: memoryFileSystem(),
    cwd: "/virtual",
    env: {},
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...overrides,
  };
  return { io, out, err };
}

describe("executeLint", () => {
  test("lints a flow written into the memory fs and returns exit 0", async () => {
    const { io, out } = makeIo();
    await io.fs.writeTextFile("/virtual/flow.toml", FLOW_SOURCE);
    const { exitCode } = await executeLint(["lint", "/virtual/flow.toml"], io);
    expect(exitCode).toBe(0);
    expect(out.join("\n")).toContain("0 errors");
  });

  test("a bad flag is a usage error (exit 2)", async () => {
    const { io, err } = makeIo();
    const { exitCode } = await executeLint(["lint", "flow.toml", "--trials", "2"], io);
    expect(exitCode).toBe(2);
    expect(err.join("\n")).toContain("flag --trials is not supported");
  });

  test("no positional path is a usage error (exit 2)", async () => {
    const { io, err } = makeIo();
    const { exitCode } = await executeLint(["lint"], io);
    expect(exitCode).toBe(2);
    expect(err.join("\n")).toContain("expected at least one path argument");
  });
});

describe("executeRun", () => {
  test.each([
    ["scenarios/checkout/root.toml", null, "/virtual/.flightplan-runs/"],
    ["./scenarios/checkout/../checkout/root.toml", "./runs", "/virtual/runs/"],
    ["/virtual/scenarios/checkout/root.toml", "/evidence", "/evidence/"],
  ] as const)(
    "resolves %s and its dependencies against the command cwd",
    async (path, outDir, expectedOut) => {
      const driver = new MockDriver();
      const { io, out, err } = makeIo({ driverFactory: () => driver });
      const header = (id: string) => `version=1\nkind="flow"\nid="${id}"\ndescription="test"\n`;
      const step = (id: string) =>
        `[[steps]]\nid="${id}"\ndo="goto"\nurl="https://example.test/${id}"\n`;
      await io.fs.writeTextFile(
        "/virtual/scenarios/checkout/root.toml",
        header("root") +
          'imports="./child.toml"\nsetup="../shared/setup.toml"\nteardown="../shared/teardown.toml"\n' +
          step("root") +
          '[[steps]]\nid="child"\ndo="run"\nflow="child"\n',
      );
      await io.fs.writeTextFile(
        "/virtual/scenarios/checkout/child.toml",
        header("child") + step("child"),
      );
      for (const id of ["setup", "teardown"])
        await io.fs.writeTextFile(`/virtual/scenarios/shared/${id}.toml`, header(id) + step(id));
      expect((await executeLint(["lint", path], io)).exitCode).toBe(0);
      out.length = 0;
      const checkedPaths: string[] = [];
      const exists = io.fs.fileExists.bind(io.fs);
      io.fs.fileExists = async (file) => {
        checkedPaths.push(file);
        return exists(file);
      };
      const args = [
        "run",
        path,
        "--json",
        "--frozen",
        "--no-lock-write",
        "--lock",
        "./locks/root.lock.toml",
      ];
      if (outDir !== null) args.push("-o", outDir);
      expect((await executeRun(args, io)).exitCode).toBe(0);
      expect(err).toEqual([]);
      const summary = JSON.parse(out.join("")) as { verdict: string; run_dir: string };
      expect(summary.verdict).toBe("passed");
      expect(driver.callsTo("goto")).toHaveLength(4);
      expect(summary.run_dir.startsWith(expectedOut)).toBe(true);
      expect(await io.fs.fileExists(`${summary.run_dir}/summary.json`)).toBe(true);
      expect(checkedPaths).toContain("/virtual/locks/root.lock.toml");
    },
  );

  test("runs a flow with a MockDriver against the memory fs; --json includes summary_version", async () => {
    const { io, out } = makeIo({ driverFactory: () => new MockDriver() });
    await io.fs.writeTextFile("/virtual/flow.toml", FLOW_SOURCE);
    const { exitCode } = await executeRun(
      ["run", "/virtual/flow.toml", "--json", "--no-lock-write"],
      io,
    );
    expect(exitCode).toBe(0);
    const summary = JSON.parse(out.join("")) as { summary_version: number; verdict: string };
    expect(summary.summary_version).toBe(1);
    expect(summary.verdict).toBe("passed");
  });

  test("a pre-aborted signal rejects the run and maps to exit 130 (cancelled)", async () => {
    const { io, err } = makeIo({ driverFactory: () => new MockDriver() });
    await io.fs.writeTextFile("/virtual/flow.toml", FLOW_SOURCE);
    const controller = new AbortController();
    controller.abort();
    const { exitCode } = await executeRun(["run", "/virtual/flow.toml", "--no-lock-write"], {
      ...io,
      signal: controller.signal,
    });
    expect(exitCode).toBe(130);
    expect(err.join("\n")).toContain("cancelled");
  });

  test("a tiny timeoutMs rejects the run and maps to exit 124 (deadline)", async () => {
    // Deterministic deadline: `executeRun` reads the flow once (unguarded) to resolve config,
    // then `runFlow` re-reads it under `RunControl`'s deadline. Let the FIRST read through and
    // hang forever on every subsequent read, so the run is always still blocked on loading when
    // the (short) timer fires — mirrors `runner.cancellation.test.ts`'s "deadline covers loading
    // before any browser exists".
    const fs = memoryFileSystem();
    await fs.writeTextFile("/virtual/flow.toml", FLOW_SOURCE);
    const hang = new Promise<string>(() => {});
    const originalRead = fs.readTextFile.bind(fs);
    let reads = 0;
    fs.readTextFile = async (path: string) => {
      reads += 1;
      if (reads > 1) return hang;
      return originalRead(path);
    };
    const { io, err } = makeIo({ fs, driverFactory: () => new MockDriver() });
    const { exitCode } = await executeRun(["run", "/virtual/flow.toml", "--no-lock-write"], {
      ...io,
      timeoutMs: 5,
    });
    expect(exitCode).toBe(124);
    expect(err.join("\n")).toContain("deadline");
  });

  test("no positional path is a usage error (exit 2)", async () => {
    const { io, err } = makeIo();
    const { exitCode } = await executeRun(["run"], io);
    expect(exitCode).toBe(2);
    expect(err.join("\n")).toContain("expected one path argument");
  });
});
