import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFileSystem } from "../adapters/memory.ts";
import { MockDriver } from "../driver/mock-driver.ts";
import { runFlow } from "../runner/runner.ts";
import type { RunOptions, RunResult } from "../runner/types.ts";
import { type CommandIO, parseArgs, validateCommandArgs } from "./commands.ts";
import { runSweep } from "./sweep.ts";

test("native sweep retains all denied units in a newly created campaign directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flightplan-sweep-denied-"));
  try {
    const path = join(dir, "flow.toml");
    await writeFile(
      path,
      'version=1\nkind="flow"\nid="denied"\ndescription="denied"\n[[steps]]\nid="judge"\ndo="assert"\n[[steps.assert]]\ntype="ai_judge"\nprompt="Ready?"',
    );
    const out = join(dir, "new-campaign");
    let calls = 0;
    expect(
      await runSweep(parseArgs(["sweep", path, "--compare-baseline", "-o", out]), async () => {
        calls++;
        return { exitCode: 0 };
      }),
    ).toBe(1);
    expect(calls).toBe(0);
    expect(JSON.parse(await readFile(join(out, "sweep.json"), "utf8"))).toMatchObject({
      passed: 0,
      notPassed: 2,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const flow = (id: string, input: string) => `version=1
kind="flow"
id="${id}"
description="sweep fixture"
[inputs.origin]
type="string"
required=true
${input}
[[steps]]
id="open"
do="goto"
url="\${inputs.origin}"
`;

function fixture(): { io: CommandIO; output: string[] } {
  const output: string[] = [];
  return {
    output,
    io: {
      fs: memoryFileSystem(),
      cwd: "/",
      env: {},
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
    },
  };
}

test("duplicate flow IDs fail preflight before their artifacts can collide", async () => {
  const { io, output } = fixture();
  await io.fs.writeTextFile("/flows/a.toml", flow("same-id", ""));
  await io.fs.writeTextFile("/flows/b.toml", flow("same-id", ""));
  let calls = 0;
  expect(
    await runSweep(
      parseArgs(["sweep", "/flows", "--input", "origin=https://example.test"]),
      async () => {
        calls++;
        return { exitCode: 0 };
      },
      io,
    ),
  ).toBe(2);
  expect(calls).toBe(0);
  expect(output.join("\n")).toContain('Duplicate flow id "same-id"');
});

test("sweep passes shared typed inputs to every trial", async () => {
  const { io } = fixture();
  await io.fs.writeTextFile("/flows/a.toml", flow("a", ""));
  await io.fs.writeTextFile("/flows/b.toml", flow("b", ""));
  const args = parseArgs([
    "sweep",
    "/flows",
    "--input",
    "origin=https://example.test",
    "--trials",
    "2",
  ]);
  validateCommandArgs(args);
  const runs: RunOptions[] = [];
  expect(
    await runSweep(
      args,
      async (options) => {
        runs.push(options);
        return { exitCode: 0 };
      },
      io,
    ),
  ).toBe(0);
  expect(runs).toHaveLength(4);
  expect(runs.every((run) => run.inputs?.origin === "https://example.test")).toBe(true);
});

test("bad inputs in the last flow stop sweep before any run", async () => {
  const { io, output } = fixture();
  await io.fs.writeTextFile("/flows/a.toml", flow("a", ""));
  await io.fs.writeTextFile(
    "/flows/b.toml",
    flow("b", '[inputs.token]\ntype="string"\nrequired=true\nsecret=true'),
  );
  let runs = 0;
  const args = parseArgs(["sweep", "/flows", "--input", "origin=https://example.test"]);
  expect(
    await runSweep(
      args,
      async () => {
        runs++;
        return { exitCode: 0 };
      },
      io,
    ),
  ).toBe(2);
  expect(runs).toBe(0);
  expect(output.join("\n")).toContain("token");
});

test("disabled AI baseline is reported without downgrading or dispatching it", async () => {
  const { io, output } = fixture();
  await io.fs.writeTextFile("/flows/a.toml", flow("a", ""));
  const args = parseArgs([
    "sweep",
    "/flows",
    "--input",
    "origin=https://example.test",
    "--compare-baseline",
  ]);
  const runs: RunOptions[] = [];
  expect(
    await runSweep(
      args,
      async (options) => {
        runs.push(options);
        return { exitCode: 0 };
      },
      io,
    ),
  ).toBe(1);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.startTier).toBeUndefined();
  expect(output.join("\n")).toContain("start tier L3");
});

test("sweep pins callable child sources for all trials", async () => {
  const { io } = fixture();
  const child =
    'version=1\nkind="flow"\nid="child"\ndescription="child"\n[[steps]]\nid="wait"\ndo="wait"\nms=0';
  await io.fs.writeTextFile("/child.toml", child);
  await io.fs.writeTextFile(
    "/flows/a.toml",
    flow("a", "") + '\n[[steps]]\nid="child"\ndo="run"\nflow="../child.toml"',
  );
  const args = parseArgs([
    "sweep",
    "/flows",
    "--input",
    "origin=https://example.test",
    "--trials",
    "2",
  ]);
  expect(
    await runSweep(
      args,
      async (options) => {
        await io.fs.writeTextFile("/child.toml", "invalid replacement");
        return runFlow({ ...options, driverFactory: () => new MockDriver(), noLockWrite: true });
      },
      io,
    ),
  ).toBe(0);
});

test.each(["sweep.json", "SWEEP.JSON", "../escape", "a/../b", "a\\b", ".", ".."])(
  "unsafe flow artifact ID %s fails before dispatch",
  async (id) => {
    const { io } = fixture();
    await io.fs.writeTextFile("/flows/a.toml", flow(id.replaceAll("\\", "\\\\"), ""));
    let calls = 0;
    expect(
      await runSweep(
        parseArgs(["sweep", "/flows", "--input", "origin=https://example.test"]),
        async () => {
          calls++;
          return { exitCode: 0 };
        },
        io,
      ),
    ).toBe(2);
    expect(calls).toBe(0);
  },
);

test("case-folded flow IDs cannot share campaign artifacts", async () => {
  const { io } = fixture();
  await io.fs.writeTextFile("/flows/a.toml", flow("Sample", ""));
  await io.fs.writeTextFile("/flows/b.toml", flow("sample", ""));
  let calls = 0;
  expect(
    await runSweep(
      parseArgs(["sweep", "/flows", "--input", "origin=https://example.test"]),
      async () => {
        calls++;
        return { exitCode: 0 };
      },
      io,
    ),
  ).toBe(2);
  expect(calls).toBe(0);
});

test("a nonempty campaign output is refused before any new trial", async () => {
  const { io } = fixture();
  await io.fs.writeTextFile("/flows/a.toml", flow("a", ""));
  await io.fs.writeTextFile("/campaign/a/baseline/1/summary.json", '{"verdict":"passed"}');
  let calls = 0;
  expect(
    await runSweep(
      parseArgs(["sweep", "/flows", "--input", "origin=https://example.test", "-o", "/campaign"]),
      async () => {
        calls++;
        return { exitCode: 0 };
      },
      io,
    ),
  ).toBe(2);
  expect(calls).toBe(0);
  expect(await io.fs.readTextFile("/campaign/a/baseline/1/summary.json")).toBe(
    '{"verdict":"passed"}',
  );
});

test("native sweeps preserve driver recording while pinning sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flightplan-sweep-recording-"));
  try {
    const path = join(dir, "flow.toml");
    await writeFile(
      path,
      'version=1\nkind="flow"\nid="recording"\ndescription="recording"\n[config.browser]\nrecord=true\n[[steps]]\nid="wait"\ndo="wait"\nms=0',
    );
    const driver = new MockDriver().setVideoPath(join(dir, "video.webm"));
    const results: RunResult[] = [];
    expect(
      await runSweep(
        parseArgs(["sweep", path, "--no-lock-write", "-o", join(dir, "campaign")]),
        async (opts) => {
          const result = await runFlow({ ...opts, driverFactory: () => driver, env: {} });
          results.push(result);
          return result;
        },
      ),
    ).toBe(0);
    expect(results[0]?.summary.video_path).toBe(join(dir, "video.webm"));
    expect(driver.callsTo("startRecording")).toHaveLength(1);
    expect(driver.callsTo("stopRecording")).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secret env bindings work in sweep and thrown details stay out of its manifest", async () => {
  const { io, output } = fixture();
  io.env.TOKEN = "secret-sweep-canary";
  await io.fs.writeTextFile(
    "/flows/a.toml",
    flow("a", '[inputs.token]\ntype="string"\nrequired=true\nsecret=true'),
  );
  const args = parseArgs([
    "sweep",
    "/flows",
    "--input",
    "origin=https://example.test",
    "--input-env",
    "token=TOKEN",
    "-o",
    "/campaign",
  ]);
  let called = false;
  expect(
    await runSweep(
      args,
      async () => {
        called = true;
        throw new Error(io.env.TOKEN);
      },
      io,
    ),
  ).toBe(1);
  expect(called).toBe(true);
  const manifest = await io.fs.readTextFile("/campaign/sweep.json");
  expect(manifest).toContain('"notPassed": 1');
  expect(manifest + output.join("\n")).not.toContain("secret-sweep-canary");
});
