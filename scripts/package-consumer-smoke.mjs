import assert from "node:assert/strict";
import {
  createAiRuntime,
  getBrowserPilotProvenance,
  MockDriver,
  RunInterruptedError,
  resolveConfigWithDefaults,
  runFlow,
} from "@svilupp/flightplan";

assert.equal(getBrowserPilotProvenance().packageVersion, process.argv[2]);

// ---- Packed-exports gate (workers-slice-2 §7.4 / U6 task 4) --------------------------------
// Exercise every subpath export a worker host actually needs, from the PACKED tarball (this
// script runs with `flightplan` node_modules resolution pointed at the extracted tarball
// contents — see package-smoke.mjs), not the repo's `src/`. `.` above already proved the root
// export; below proves `./worker`, `./adapters/node`, `./adapters/memory`, and (once it ships)
// `./shell`.
const { nodeFileSystem } = await import("@svilupp/flightplan/adapters/node");
assert.equal(typeof nodeFileSystem.readTextFile, "function");
assert.equal(typeof nodeFileSystem.readDir, "function");

const { memoryFileSystem: memoryFileSystemFromAdapter } = await import(
  "@svilupp/flightplan/adapters/memory"
);
assert.equal(typeof memoryFileSystemFromAdapter, "function");

const {
  runFlow: workerRunFlow,
  MockDriver: WorkerMockDriver,
  memoryFileSystem,
  resolveConfigWithDefaults: workerResolveConfigWithDefaults,
} = await import("@svilupp/flightplan/worker");
assert.equal(typeof workerRunFlow, "function");
assert.equal(typeof memoryFileSystem, "function");

// A MockDriver flow run entirely through the `./worker` entry with the `./worker`-exported
// `memoryFileSystem` — no Node fs, proving the curated worker barrel is self-sufficient.
{
  const fs = memoryFileSystem();
  const driver = new WorkerMockDriver();
  const flowSource = [
    "version = 1",
    'kind = "flow"',
    'id = "packed.worker-entry"',
    'description = "packed-exports gate: ./worker + memoryFileSystem"',
    "",
    "[[steps]]",
    'id = "open"',
    'do = "goto"',
    'url = "https://example.test/"',
  ].join("\n");
  const result = await workerRunFlow({
    flowPath: "/virtual/flow.toml",
    flowSource,
    fs,
    env: {},
    out: "/virtual/runs",
    runId: "packed-worker",
    config: workerResolveConfigWithDefaults([{}]),
    driverFactory: () => driver,
    noLockWrite: true,
  });
  assert.equal(result.summary.verdict, "passed");
  assert.equal(driver.callsTo("goto").length, 1);
}

// The generic shell entry works without any shell consumer installed.
await assert.rejects(import("just-bash"), { code: "ERR_MODULE_NOT_FOUND" });
{
  const { runFlightplan } = await import("@svilupp/flightplan/shell");
  const fs = memoryFileSystem();
  await fs.writeTextFile(
    "/virtual/flow.toml",
    'version=1\nkind="flow"\nid="shell"\ndescription="shell"\n[[steps]]\nid="open"\ndo="goto"\nurl="https://example.test/"\n',
  );
  const driver = new WorkerMockDriver();
  const result = await runFlightplan(
    ["run", "flow.toml", "--json", "--no-lock-write"],
    { fs, cwd: "/virtual" },
    { driverFactory: () => driver },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).verdict, "passed");
  assert.equal(driver.callsTo("goto").length, 1);
  console.log("Packed consumer: ./shell runs without just-bash installed: OK");
}

// Provider helpers remain available outside the portable graph.
{
  const { createProvider, defaultGenerate, createOpenAiGenerate } = await import(
    "@svilupp/flightplan/ai-sdk"
  );
  assert.equal(typeof createProvider, "function");
  assert.equal(typeof defaultGenerate, "function");
  assert.equal(typeof createOpenAiGenerate, "function");
  console.log("Packed consumer: ./ai-sdk export present and callable: OK");
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const files = new Map(),
    binary = new Map(),
    driver = new MockDriver();
  const fs = {
    async readTextFile(path) {
      if (!files.has(path)) throw new Error(`missing ${path}`);
      return files.get(path);
    },
    async writeTextFile(path, text) {
      files.set(path, text);
    },
    async appendTextFile(path, text) {
      files.set(path, (files.get(path) ?? "") + text);
    },
    async fileExists(path) {
      return files.has(path);
    },
    async mkdir() {},
    async writeBinaryFile(path, bytes) {
      binary.set(path, bytes);
    },
  };
  const header = (id) => `version=1\nkind="flow"\nid="${id}"\ndescription="café 東京"\n`;
  const step = (id) => `[[steps]]\nid="${id}"\ndo="goto"\nurl="https://example.test/${id}"\n`;
  files.set(
    "/workspace/root.toml",
    header("root") +
      'imports="./child.toml"\nsetup="./setup.toml"\nteardown="./teardown.toml"\n' +
      step("open") +
      '[[steps]]\nid="child"\ndo="run"\nflow="./nested/../child.toml"\n',
  );
  for (const id of ["setup", "teardown", "child"])
    files.set(`/workspace/${id}.toml`, header(id) + step(id));
  const options = {
    flowPath: "/workspace/root.toml",
    fs,
    driverFactory: () => driver,
    config: resolveConfigWithDefaults([{}]),
    env: {},
    frozen: true,
    noLockWrite: true,
    out: "/workspace/runs",
    runId: "packed",
    timeoutMs: 1000,
    cleanupTimeoutMs: 50,
  };
  return { files, binary, driver, fs, options };
}
// Native relative paths must resolve in this consumer's cwd, including imports and hooks.
// package-smoke.mjs runs this process in its disposable directory.
{
  const { files, driver, options } = fixture();
  for (const [path, source] of files) {
    await nodeFileSystem.writeTextFile(path.replace("/workspace/", "relative-flows/"), source);
  }
  const result = await runFlow({
    ...options,
    fs: undefined,
    flowPath: "relative-flows/root.toml",
    out: "relative-runs",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(driver.callsTo("goto").length, 4);
  assert.equal(
    JSON.parse(await nodeFileSystem.readTextFile(`${result.runDir}/summary.json`)).verdict,
    "passed",
  );
  console.log("Packed consumer: native relative imports, child flows, and hooks: OK");
}
{
  const { files, binary, driver, options } = fixture();
  driver.setScreenshot("AP+A/w==");
  const result = await runFlow({
    ...options,
    config: resolveConfigWithDefaults([{ browser: { record: true } }]),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(driver.callsTo("goto").length, 4);
  assert.equal(binary.size, 4);
  assert.deepEqual([...binary.values()][0], new Uint8Array([0, 255, 128, 255]));
  assert.equal(driver.callsTo("startRecording").length, 0);
  assert.equal(driver.callsTo("saveScreenshot").length, 0);
  assert.equal(
    [...files.keys()].some((path) => path.endsWith(".lock.toml")),
    false,
  );
  assert.equal(JSON.parse(files.get(`${result.runDir}/summary.json`)).verdict, "passed");
}
{
  const { files, driver, fs, options } = fixture();
  const entered = deferred(),
    held = deferred(),
    controller = new AbortController();
  const append = fs.appendTextFile.bind(fs);
  fs.appendTextFile = async (path, text) => {
    if (text.includes('"step_start"')) {
      entered.resolve();
      await held.promise;
    }
    await append(path, text);
  };
  const outcome = runFlow({ ...options, signal: controller.signal }).catch((error) => error);
  await entered.promise;
  controller.abort();
  const error = await outcome;
  assert.ok(error instanceof RunInterruptedError);
  assert.equal(error.code, "RUN_CANCELLED");
  assert.equal(error.cleanup, "completed");
  assert.deepEqual(error.pendingWrites, ["/workspace/runs/packed/run.jsonl"]);
  held.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(driver.callsTo("goto").length, 0);
  assert.equal(driver.callsTo("teardown").length, 1);
  assert.equal(files.has("/workspace/runs/packed/summary.json"), false);
}
for (const modality of ["text", "screenshot"]) {
  const { driver, files, options } = fixture();
  driver.setScreenshot("AP8=");
  let calls = 0;
  const flowSource = `version=1\nkind="flow"\nid="judge"\ndescription="judge"\n[[steps]]\nid="open"\ndo="goto"\nurl="https://example.test/"\n[[steps.assert]]\ntype="ai_judge"\nprompt="The page is ready"\ninputs=["${modality}"]`;
  const result = await runFlow({
    ...options,
    flowSource,
    config: resolveConfigWithDefaults([{ run: { max_model_calls: 1, max_screenshots: 1 } }]),
    aiRuntimeFactory: (deps) =>
      createAiRuntime({
        ...deps,
        generate: async (request) => {
          calls++;
          assert.ok(request.signal instanceof AbortSignal);
          assert.equal(Boolean(request.messages), modality === "screenshot");
          return {
            output: { pass: true, reason: "fixture passed" },
            model: request.models[0],
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls, 1);
  assert.ok(files.get(`${result.runDir}/ai.jsonl`).includes('"ai_call"'));
}
console.log(
  "Packed consumer: public imports, dependency provenance, VFS, cancellation, injected text/vision AI: OK",
);
