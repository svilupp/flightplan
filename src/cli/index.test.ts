import { afterEach, describe, expect, test } from "bun:test";
import { memoryFileSystem } from "../adapters/memory.ts";
import { MockDriver } from "../driver/mock-driver.ts";
import type { CommandIO } from "./commands.ts";
import { main, printUsage } from "./index.ts";

const originalError = console.error;

afterEach(() => {
  console.error = originalError;
});

function captureErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  return { lines, restore: () => (console.error = originalError) };
}

describe("command validation", () => {
  test("help exposes launcher choices and browser prerequisite", () => {
    let usage = "";
    printUsage((text) => {
      usage = text;
    });

    expect(usage).toContain("flightplan <command> ...");
    expect(usage).toContain("npx flightplan <command> ...");
    expect(usage).toContain("bunx flightplan <command> ...");
    expect(usage).toContain("flightplan run path/to/flow.toml");
    expect(usage).toContain("bp webmcp status");
  });

  test("rejects flags that belong to a different command", async () => {
    const captured = captureErrors();
    try {
      expect(await main(["lint", "flow.toml", "--trials", "2"])).toBe(2);
      expect(captured.lines.join("\n")).toContain("lint: flag --trials is not supported");
    } finally {
      captured.restore();
    }
  });

  test("rejects extra operands for single-flow commands before dispatch", async () => {
    const captured = captureErrors();
    try {
      expect(await main(["run", "flow.toml", "another.toml"])).toBe(2);
      expect(captured.lines.join("\n")).toContain("run: expected exactly one path argument");
    } finally {
      captured.restore();
    }
  });
});

function signalFixture(driver: MockDriver): { io: CommandIO; output: string[] } {
  const output: string[] = [];
  return {
    output,
    io: {
      fs: memoryFileSystem(),
      cwd: "/virtual",
      env: {},
      driverFactory: () => driver,
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
    },
  };
}

const signalFlow =
  'version=1\nkind="flow"\nid="signal"\ndescription="signal fixture"\n[[steps]]\nid="open"\ndo="goto"\nurl="https://example.test"';

test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)("main forwards %s once and disposes its listeners", async (signal, expectedCode) => {
  const beforeInterrupt = process.listeners("SIGINT");
  const beforeTerminate = process.listeners("SIGTERM");
  class InterruptingDriver extends MockDriver {
    override async goto(url: string): Promise<void> {
      await super.goto(url);
      expect(process.listenerCount("SIGINT")).toBe(beforeInterrupt.length + 1);
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerminate.length + 1);
      process.emit(signal);
      process.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
    }
  }
  const driver = new InterruptingDriver();
  const { io, output } = signalFixture(driver);
  await io.fs.writeTextFile("/virtual/flow.toml", signalFlow);
  expect(await main(["run", "flow.toml", "--json", "--no-lock-write"], io)).toBe(expectedCode);
  expect(process.listeners("SIGINT")).toEqual(beforeInterrupt);
  expect(process.listeners("SIGTERM")).toEqual(beforeTerminate);
  expect(driver.callsTo("teardown")).toHaveLength(1);
  expect(JSON.parse(output.join("\n"))).toMatchObject({
    ok: false,
    diagnostics: [
      { code: "RUN_CANCELLED", message: expect.stringContaining("cleanup: completed") },
    ],
  });
  const files = await io.fs.readDir("/virtual/.flightplan-runs");
  for (const entry of files)
    if (entry.isDirectory)
      expect(await io.fs.fileExists(`/virtual/.flightplan-runs/${entry.name}/summary.json`)).toBe(
        false,
      );
});

test("main disposes signal listeners after success and an output failure", async () => {
  const beforeInterrupt = process.listeners("SIGINT");
  const beforeTerminate = process.listeners("SIGTERM");
  const { io } = signalFixture(new MockDriver());
  await io.fs.writeTextFile("/virtual/flow.toml", signalFlow);
  expect(await main(["run", "flow.toml", "--no-lock-write"], io)).toBe(0);
  expect(process.listeners("SIGINT")).toEqual(beforeInterrupt);
  expect(process.listeners("SIGTERM")).toEqual(beforeTerminate);
  io.stdout = () => {
    throw new Error("output unavailable");
  };
  await expect(main(["run", "flow.toml", "--no-lock-write"], io)).rejects.toThrow(
    "output unavailable",
  );
  expect(process.listeners("SIGINT")).toEqual(beforeInterrupt);
  expect(process.listeners("SIGTERM")).toEqual(beforeTerminate);
});

test("main forwards SIGTERM to check and disposes listeners after cancelled acquisition", async () => {
  const beforeInterrupt = process.listeners("SIGINT");
  const beforeTerminate = process.listeners("SIGTERM");
  const { io, output } = signalFixture(new MockDriver());
  await io.fs.writeTextFile("/virtual/flow.toml", signalFlow);
  io.namedSessionBorrower = async (request) => {
    expect(request.signal?.aborted).toBe(false);
    process.emit("SIGTERM");
    expect(request.signal?.aborted).toBe(true);
    throw new Error("acquisition cancelled");
  };
  expect(await main(["check", "flow.toml", "--session", "work", "--json"], io)).toBe(143);
  expect(JSON.parse(output.join("\n"))).toMatchObject({
    ok: false,
    diagnostics: [
      { code: "RUN_CANCELLED", message: expect.stringContaining("cleanup: completed") },
    ],
  });
  expect(process.listeners("SIGINT")).toEqual(beforeInterrupt);
  expect(process.listeners("SIGTERM")).toEqual(beforeTerminate);
});

test("main forwards SIGINT through sweep and stops subsequent trials", async () => {
  const beforeInterrupt = process.listeners("SIGINT");
  const beforeTerminate = process.listeners("SIGTERM");
  class InterruptingDriver extends MockDriver {
    override async goto(url: string): Promise<void> {
      await super.goto(url);
      process.emit("SIGINT");
    }
  }
  const driver = new InterruptingDriver();
  const { io, output } = signalFixture(driver);
  await io.fs.writeTextFile("/virtual/flow.toml", signalFlow);
  expect(
    await main(["sweep", "flow.toml", "--trials", "2", "--no-lock-write", "-o", "/campaign"], io),
  ).toBe(130);
  expect(driver.callsTo("goto")).toHaveLength(1);
  expect(driver.callsTo("teardown")).toHaveLength(1);
  expect(output.join("\n")).toContain("cleanup: completed");
  expect(output.join("\n")).not.toContain("Sweep complete");
  expect(process.listeners("SIGINT")).toEqual(beforeInterrupt);
  expect(process.listeners("SIGTERM")).toEqual(beforeTerminate);
});
