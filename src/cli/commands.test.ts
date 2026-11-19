// Flightplan — `executeLint`/`executeRun` (workers-slice-2 §5/U4).
//
// Proves the process-free command core works with an injected `FileSystemPort` + `MockDriver`
// (no real filesystem, no real browser) and that the exit-code contract (0/1/2/3 + 124/130)
// holds independent of the native Node CLI shell.

import { describe, expect, test } from "bun:test";
import { memoryFileSystem } from "../adapters/memory.ts";
import { AuthStateUnavailableError } from "../driver/connect-resolution.ts";
import { MockDriver } from "../driver/index.ts";
import { type CommandIO, executeCheck, executeLint, executeRun } from "./commands.ts";

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
  test("--deny-warnings changes the gate without losing warning diagnostics", async () => {
    const { io, out } = makeIo();
    await io.fs.writeTextFile("/virtual/flow.toml", FLOW_SOURCE);
    expect((await executeLint(["lint", "flow.toml", "--json"], io)).exitCode).toBe(0);
    out.length = 0;
    expect(
      (await executeLint(["lint", "flow.toml", "--deny-warnings", "--json"], io)).exitCode,
    ).toBe(1);
    const report = JSON.parse(out[0]!);
    expect(report.warningCount).toBeGreaterThan(0);
    expect(report.errorCount).toBe(0);
    expect(report.ok).toBe(false);
  });
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
    // The entry source is pinned after configuration. A hanging import must still be
    // covered by the run deadline before any browser is acquired.
    const fs = memoryFileSystem();
    await fs.writeTextFile(
      "/virtual/flow.toml",
      FLOW_SOURCE.replace("[[steps]]", 'imports=["./child.toml"]\n[[steps]]'),
    );
    const hang = new Promise<string>(() => {});
    const originalRead = fs.readTextFile.bind(fs);
    fs.readTextFile = async (path: string) => {
      if (path === "/virtual/child.toml") return hang;
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

  test("run executes the same entry source used to resolve configuration", async () => {
    const fs = memoryFileSystem();
    const original = FLOW_SOURCE.replace("https://example.test/", "https://example.test/original");
    const replacement = FLOW_SOURCE.replace(
      "https://example.test/",
      "https://example.test/replacement",
    );
    await fs.writeTextFile("/virtual/flow.toml", original);
    const read = fs.readTextFile.bind(fs);
    let reads = 0;
    fs.readTextFile = async (path) => {
      const text = await read(path);
      if (path === "/virtual/flow.toml") {
        reads++;
        await fs.writeTextFile(path, replacement);
      }
      return text;
    };
    const driver = new MockDriver();
    const { io } = makeIo({ fs, driverFactory: () => driver });
    expect((await executeRun(["run", "/virtual/flow.toml", "--no-lock-write"], io)).exitCode).toBe(
      0,
    );
    expect(reads).toBe(1);
    expect(driver.callsTo("goto")[0]?.args[0]).toBe("https://example.test/original");
  });

  test("no positional path is a usage error (exit 2)", async () => {
    const { io, err } = makeIo();
    const { exitCode } = await executeRun(["run"], io);
    expect(exitCode).toBe(2);
    expect(err.join("\n")).toContain("expected one path argument");
  });

  test("a harness/connect error (verdict error) surfaces the reason: human stderr + --json error field", async () => {
    const flowWithAuth = `${FLOW_SOURCE}
[config.auth]
cookie_file = "cookies.json"
cookie_save = false
`;
    const driver = new MockDriver();
    driver.setAuthStateUnavailable(
      new AuthStateUnavailableError("expired", "/virtual/cookies.json"),
    );

    const { io: humanIo, out: humanOut, err: humanErr } = makeIo({ driverFactory: () => driver });
    await humanIo.fs.writeTextFile("/virtual/flow.toml", flowWithAuth);
    const humanResult = await executeRun(["run", "/virtual/flow.toml", "--no-lock-write"], humanIo);
    expect(humanResult.exitCode).toBe(2);
    expect(humanOut.join("\n")).toContain("Verdict: ERROR");
    expect(humanErr.some((l) => l.startsWith("Error: ") && l.includes("expired"))).toBe(true);

    const jsonDriver = new MockDriver();
    jsonDriver.setAuthStateUnavailable(
      new AuthStateUnavailableError("expired", "/virtual/cookies.json"),
    );
    const { io: jsonIo, out: jsonOut } = makeIo({ driverFactory: () => jsonDriver });
    await jsonIo.fs.writeTextFile("/virtual/flow.toml", flowWithAuth);
    const jsonResult = await executeRun(
      ["run", "/virtual/flow.toml", "--json", "--no-lock-write"],
      jsonIo,
    );
    expect(jsonResult.exitCode).toBe(2);
    const summary = JSON.parse(jsonOut.join("")) as { verdict: string; error?: string };
    expect(summary.verdict).toBe("error");
    expect(summary.error).toBeDefined();
    expect(summary.error).toContain("expired");
  });
});

test.each(["--input", "--input-env"])(
  "unsupported input binding uses the authored %s flag name",
  async (flag) => {
    const { io, err } = makeIo();
    expect((await executeLint(["lint", "flow.toml", flag, "value=SOURCE"], io)).exitCode).toBe(2);
    expect(err).toEqual([`lint: flag ${flag} is not supported`]);
  },
);

test.each(["completed", "failed", "pending"] as const)(
  "cancellation reports cleanup as %s without a run verdict",
  async (cleanup) => {
    const controller = new AbortController();
    class CancelledDriver extends MockDriver {
      override async goto(url: string): Promise<void> {
        await super.goto(url);
        controller.abort();
      }
      override async teardown(): Promise<void> {
        await super.teardown();
        if (cleanup === "failed") throw new Error("cleanup unavailable");
        if (cleanup === "pending") await new Promise<void>(() => {});
      }
    }
    const driver = new CancelledDriver();
    const { io, out } = makeIo({ driverFactory: () => driver, signal: controller.signal });
    await io.fs.writeTextFile("/virtual/flow.toml", FLOW_SOURCE);
    expect((await executeRun(["run", "flow.toml", "--json", "--no-lock-write"], io)).exitCode).toBe(
      130,
    );
    const result = JSON.parse(out.join("\n"));
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        { code: "RUN_CANCELLED", message: expect.stringContaining(`cleanup: ${cleanup}`) },
      ],
    });
    expect(result.verdict).toBeUndefined();
    expect(driver.callsTo("teardown")).toHaveLength(1);
  },
);

test("pre-aborted check returns cancellation before borrowing a session", async () => {
  const controller = new AbortController();
  controller.abort();
  let borrows = 0;
  const { io, out } = makeIo({
    signal: controller.signal,
    namedSessionBorrower: async () => {
      borrows++;
      throw new Error("unexpected borrow");
    },
  });
  await io.fs.writeTextFile("/virtual/flow.toml", FLOW_SOURCE);
  expect(
    (await executeCheck(["check", "flow.toml", "--session", "work", "--json"], io)).exitCode,
  ).toBe(130);
  expect(borrows).toBe(0);
  expect(JSON.parse(out.join("\n"))).toMatchObject({
    ok: false,
    diagnostics: [
      { code: "RUN_CANCELLED", message: expect.stringContaining("cleanup: completed") },
    ],
  });
});

test("check cancellation during inspection cleans up its acquired session once", async () => {
  const controller = new AbortController();
  let acquired = false;
  let detaches = 0;
  let handbacks = 0;
  const { io, out } = makeIo({
    signal: controller.signal,
    namedSessionBorrower: async (request) => {
      expect(request.signal?.aborted).toBe(false);
      acquired = true;
      return {
        protocolVersion: 1,
        ownerEpoch: "owner",
        fencingToken: "grant",
        exclusive: true,
        capabilities: { ownerProtocolVersion: 2, rawCompatibility: true, nativeAtomic: false },
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: this lease fixture supplies every Page operation used by connect and owner handback.
        page: { targetId: "page", onDialog: async () => {} } as never,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: only target enumeration is used before the filesystem triggers cancellation.
        browser: { listTargets: async () => [{ targetId: "page", type: "page" }] } as never,
        handback: async () => {
          handbacks++;
          return {
            confirmed: true,
            ownerEpoch: "owner",
            targetId: "page",
            refsInvalidated: true,
            pendingActions: "drained",
            bindingRevision: 1,
            observationEpoch: "observation",
          };
        },
        detach: async () => {
          detaches++;
        },
      };
    },
  });
  await io.fs.writeTextFile("/virtual/flow.toml", FLOW_SOURCE);
  const read = io.fs.readTextFile.bind(io.fs);
  io.fs.readTextFile = async (path) => {
    if (acquired) controller.abort();
    return read(path);
  };
  expect(
    (await executeCheck(["check", "flow.toml", "--session", "work", "--json"], io)).exitCode,
  ).toBe(130);
  expect(JSON.parse(out.join("\n"))).toMatchObject({
    ok: false,
    diagnostics: [
      { code: "RUN_CANCELLED", message: expect.stringContaining("cleanup: completed") },
    ],
  });
  expect(detaches).toBe(1);
  expect(handbacks).toBe(1);
});
