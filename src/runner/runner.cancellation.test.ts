import { describe, expect, test } from "bun:test";
import { FakeClock } from "../assert/clock.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import { MockDriver } from "../driver/index.ts";
import type { FileSystemPort } from "../runtime.ts";
import { RunInterruptedError } from "./control.ts";
import { runFlow } from "./runner.ts";
import type { RunOptions } from "./types.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const files = new Map<string, string>();
  const fs: FileSystemPort = {
    async readTextFile(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
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
    async readDir() {
      // No directory hierarchy in a flat Map; nothing in these tests walks directories.
      return [];
    },
    async stat(path) {
      return files.has(path) ? { isFile: true, isDirectory: false } : null;
    },
  };
  const driver = new MockDriver();
  const options: RunOptions = {
    flowPath: "/virtual/flow.toml",
    flowSource:
      'version=1\nkind="flow"\nid="cancel"\ndescription="cancel"\n[[steps]]\nid="open"\ndo="goto"\nurl="https://example.test/"',
    fs,
    config: resolveConfigWithDefaults([{}]),
    env: {},
    out: "/virtual/runs",
    runId: "cancel",
    driverFactory: () => driver,
    clock: new FakeClock(),
    cleanupTimeoutMs: 30,
  };
  return { files, fs, driver, options };
}

async function interruption(work: Promise<unknown>): Promise<RunInterruptedError> {
  try {
    await work;
    throw new Error("run unexpectedly resolved");
  } catch (error) {
    expect(error).toBeInstanceOf(RunInterruptedError);
    if (!(error instanceof RunInterruptedError)) throw error;
    return error;
  }
}

describe("run cancellation and deadlines", () => {
  test("accepts frozen ports without losing private method receivers", async () => {
    const { fs, options } = fixture();
    class DriverWithPrivateState extends MockDriver {
      #ready = false;
      override async connect(): Promise<void> {
        this.#ready = true;
      }
      override async goto(): Promise<void> {
        if (!this.#ready) throw new Error("not ready");
      }
    }
    const result = await runFlow({
      ...options,
      fs: Object.freeze(fs),
      driverFactory: () => new DriverWithPrivateState(),
      timeoutMs: 1000,
    });
    expect(result.summary.verdict).toBe("passed");
  });

  test("reports cleanup failures after interruption", async () => {
    const { fs, driver, options } = fixture();
    const entered = deferred(),
      held = deferred();
    const append = fs.appendTextFile.bind(fs);
    fs.appendTextFile = async (path, text) => {
      if (text.includes('"step_start"')) {
        entered.resolve();
        await held.promise;
      }
      await append(path, text);
    };
    driver.teardown = async () => {
      throw new Error("release failed");
    };
    const controller = new AbortController();
    const done = interruption(runFlow({ ...options, signal: controller.signal }));
    await entered.promise;
    controller.abort();
    expect((await done).cleanup).toBe("failed");
    held.resolve();
  });

  test("pre-cancelled runs perform no I/O", async () => {
    const { files, driver, options } = fixture();
    const controller = new AbortController();
    controller.abort();
    const error = await interruption(runFlow({ ...options, signal: controller.signal }));
    expect(error.code).toBe("RUN_CANCELLED");
    expect(error.cleanup).toBe("completed");
    expect(files.size).toBe(0);
    expect(driver.calls).toHaveLength(0);
  });

  test("deadline covers loading before any browser exists", async () => {
    const { fs, driver, options } = fixture();
    const gate = deferred<string>();
    fs.readTextFile = () => gate.promise;
    const error = await interruption(runFlow({ ...options, flowSource: undefined, timeoutMs: 20 }));
    expect(error.code).toBe("RUN_TIMEOUT");
    expect(error.pendingWrites).toEqual([]);
    expect(driver.calls).toHaveLength(0);
    gate.resolve(options.flowSource!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(driver.calls).toHaveLength(0);
  });

  test("checks elapsed time even when immediate promises prevent the timeout timer from running", async () => {
    const { fs, driver, options } = fixture();
    fs.readTextFile = async () => {
      const until = Date.now() + 20;
      while (Date.now() < until) {
        /* Simulate synchronous parsing/storage work. */
      }
      return options.flowSource!;
    };
    const error = await interruption(runFlow({ ...options, flowSource: undefined, timeoutMs: 5 }));
    expect(error.code).toBe("RUN_TIMEOUT");
    expect(driver.calls).toHaveLength(0);
  });

  test("cancelled artifact append tears down and cannot resume browser work on late commit", async () => {
    const { fs, files, driver, options } = fixture();
    const gate = deferred(),
      entered = deferred();
    const append = fs.appendTextFile.bind(fs);
    fs.appendTextFile = async (path, text) => {
      if (text.includes('"step_start"')) {
        entered.resolve();
        await gate.promise;
      }
      await append(path, text);
    };
    const controller = new AbortController();
    const done = interruption(runFlow({ ...options, signal: controller.signal }));
    await entered.promise;
    controller.abort();
    const error = await done;
    expect(error.pendingWrites).toEqual(["/virtual/runs/cancel/run.jsonl"]);
    expect(error.cleanup).toBe("completed");
    expect(driver.callsTo("teardown")).toHaveLength(1);
    expect(driver.callsTo("goto")).toHaveLength(0);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(driver.callsTo("goto")).toHaveLength(0);
    expect(driver.callsTo("teardown")).toHaveLength(1);
    expect(files.has("/virtual/runs/cancel/summary.json")).toBe(false);
    expect(files.get("/virtual/runs/cancel/run.jsonl")).not.toContain('"run_end"');
  });

  test("reports an in-flight browser operation and never dispatches the next step", async () => {
    const { driver, options } = fixture();
    const gate = deferred(),
      entered = deferred();
    let calls = 0;
    driver.goto = async () => {
      calls++;
      entered.resolve();
      await gate.promise;
    };
    const controller = new AbortController();
    const done = interruption(
      runFlow({
        ...options,
        signal: controller.signal,
        flowSource: `${options.flowSource}\n[[steps]]\nid="next"\ndo="goto"\nurl="https://example.test/next"`,
      }),
    );
    await entered.promise;
    controller.abort();
    const error = await done;
    expect(error.pendingBrowserOperations).toContain("goto");
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    expect(driver.callsTo("teardown")).toHaveLength(1);
  });

  test("late browser connection is cleaned up and bounded cleanup reports pending", async () => {
    const { driver, options } = fixture();
    const gate = deferred(),
      entered = deferred();
    driver.connect = async () => {
      entered.resolve();
      await gate.promise;
    };
    const controller = new AbortController();
    const done = interruption(runFlow({ ...options, signal: controller.signal }));
    await entered.promise;
    controller.abort();
    const error = await done;
    expect(error.cleanup).toBe("pending");
    expect(error.pendingBrowserOperations).toContain("connect");
    expect(driver.callsTo("teardown")).toHaveLength(0);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(driver.callsTo("teardown")).toHaveLength(1);
    expect(driver.callsTo("goto")).toHaveLength(0);
    expect(error.cleanup).toBe("pending"); // The returned report is a snapshot, never rewritten.
  });

  test("deadline covers binary storage and retains possible late writes", async () => {
    const { fs, driver, options } = fixture();
    const gate = deferred(),
      entered = deferred();
    let committed = false;
    fs.writeBinaryFile = async () => {
      entered.resolve();
      await gate.promise;
      committed = true;
    };
    driver.setScreenshot("AP8=");
    const done = interruption(
      runFlow({
        ...options,
        timeoutMs: 30,
        config: resolveConfigWithDefaults([{ browser: { record: true } }]),
      }),
    );
    await entered.promise;
    const error = await done;
    expect(error.code).toBe("RUN_TIMEOUT");
    expect(error.pendingWrites).toEqual(["/virtual/runs/cancel/screenshots/000-open.png"]);
    expect(error.cleanup).toBe("completed");
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(committed).toBe(true);
    expect(driver.callsTo("saveScreenshot")).toHaveLength(0);
  });

  test("stalled cleanup cannot keep an interrupted run pending", async () => {
    const { driver, options } = fixture();
    const gate = deferred(),
      entered = deferred();
    driver.teardown = async () => {
      entered.resolve();
      await gate.promise;
    };
    const controller = new AbortController();
    const done = interruption(runFlow({ ...options, signal: controller.signal }));
    await entered.promise;
    controller.abort();
    expect((await done).cleanup).toBe("pending");
    gate.resolve();
  });

  test("completed runs detach cancellation and preserve a successful result", async () => {
    const { driver, options } = fixture();
    const controller = new AbortController();
    const result = await runFlow({ ...options, signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    expect(result.summary.verdict).toBe("passed");
    expect(driver.callsTo("teardown")).toHaveLength(1);
  });
});
