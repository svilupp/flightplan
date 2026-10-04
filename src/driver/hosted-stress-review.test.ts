import { expect, test } from "bun:test";
import type { Page } from "browser-pilot/core";
import { memoryFileSystem } from "../adapters/memory.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import { runFlow } from "../runner/runner.ts";
import { BrowserPilotDriver, type DriverAcquisition } from "./browser-pilot-driver.ts";
import { MockDriver } from "./mock-driver.ts";

const config = { mode: "session", session_ref: "stress", target_policy: "selected" } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function acquisition(detach: () => Promise<void>): DriverAcquisition {
  const page = { onDialog: async () => {} } as unknown as Page;
  return { browser: { page: async () => page, listTargets: async () => [] }, page, detach };
}

test("stress review: 100 borrowed driver cycles detach exactly once and preserve host", async () => {
  let acquires = 0,
    detaches = 0;
  for (let i = 0; i < 100; i++) {
    const driver = new BrowserPilotDriver({
      acquire: async () => {
        acquires++;
        return acquisition(async () => {
          detaches++;
        });
      },
    });
    await driver.connect(config);
    await driver.page();
    await driver.teardown();
    await driver.teardown();
  }
  expect(acquires).toBe(100);
  expect(detaches).toBe(100);
});

test("stress review: already cancelled acquisition never calls host", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const driver = new BrowserPilotDriver({
    acquisitionContext: { signal: controller.signal },
    acquire: async () => {
      calls++;
      return acquisition(async () => {});
    },
  });
  await expect(driver.connect(config)).rejects.toThrow(/cancelled/);
  expect(calls).toBe(0);
});

test("stress review: cancellation bounds noncooperative acquisition and detaches late lease", async () => {
  const controller = new AbortController();
  const held = deferred<DriverAcquisition>();
  let detaches = 0,
    calls = 0;
  const reason = new Error("host cancellation");
  const driver = new BrowserPilotDriver({
    acquisitionContext: { signal: controller.signal },
    acquire: async () => {
      calls++;
      return held.promise;
    },
  });
  const pending = driver.connect(config);
  const outcome = pending.then(
    () => "accepted",
    (error) => error,
  );
  controller.abort(reason);
  const observed = await Promise.race([
    outcome,
    new Promise((resolve) => setTimeout(() => resolve("hung"), 20)),
  ]);
  held.resolve(
    acquisition(async () => {
      detaches++;
    }),
  );
  await outcome;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await driver.teardown();
  expect(observed).toBe(reason);
  expect(detaches).toBe(1);
  expect(calls).toBe(1);
});

test("stress review: deadline bounds acquisition and detaches late lease without retry", async () => {
  const held = deferred<DriverAcquisition>();
  let detaches = 0,
    calls = 0;
  const driver = new BrowserPilotDriver({
    acquisitionContext: { signal: new AbortController().signal, deadline: Date.now() + 5 },
    acquire: async () => {
      calls++;
      return held.promise;
    },
  });
  const outcome = driver.connect(config).then(
    () => "accepted",
    (error) => error,
  );
  const observed = await Promise.race([
    outcome,
    new Promise((resolve) => setTimeout(() => resolve("hung"), 20)),
  ]);
  held.resolve(
    acquisition(async () => {
      detaches++;
    }),
  );
  await outcome;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await driver.teardown();
  expect(observed).toMatchObject({ code: "RUN_TIMEOUT" });
  expect(detaches).toBe(1);
  expect(calls).toBe(1);
});

for (const bodyFails of [false, true])
  test(`stress review: runner preserves cleanup identity and ${bodyFails ? "earlier workflow failure" : "successful body evidence"}`, async () => {
    const driver = new MockDriver();
    if (bodyFails)
      driver.goto = async () => {
        throw new Error("earlier body failure");
      };
    const cleanup = {
      status: "cleanup_pending",
      sessionId: "exact-allocation",
      providerStatus: "closing",
    };
    driver.teardown = async () => {
      throw Object.assign(new Error("pending owned cleanup"), { providerCleanup: cleanup });
    };
    await expect(
      runFlow({
        flowPath: "/virtual/stress.toml",
        flowSource:
          'version=1\nkind="flow"\nid="stress"\ndescription="stress"\n[[steps]]\nid="open"\ndo="goto"\nurl="https://fixture.test/"',
        config: resolveConfigWithDefaults([{}]),
        fs: memoryFileSystem(),
        env: {},
        out: "/virtual/runs",
        runId: `cleanup-${bodyFails}`,
        driverFactory: () => driver,
      }),
    ).rejects.toMatchObject({
      providerCleanup: cleanup,
      runResult: { summary: { verdict: bodyFails ? "error" : "passed" } },
    });
  });

test("stress review: late cleanup failure retains exact allocation on original cancellation", async () => {
  const controller = new AbortController();
  const held = deferred<DriverAcquisition>();
  const reason = new Error("cancelled by host");
  const cleanup = { status: "cleanup_pending", sessionId: "late-exact-allocation" };
  const driver = new BrowserPilotDriver({
    acquisitionContext: { signal: controller.signal },
    acquire: async () => held.promise,
  });
  const outcome = driver.connect(config).catch((error) => error);
  controller.abort(reason);
  expect(await outcome).toBe(reason);
  held.resolve(
    acquisition(async () => {
      throw Object.assign(new Error("late cleanup failed"), { providerCleanup: cleanup });
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reason).toMatchObject({
    providerCleanup: cleanup,
    acquisitionCleanupError: { message: "late cleanup failed" },
  });
  await driver.teardown();
});

test("runner preserves provider cleanup identity when connection setup fails", async () => {
  const driver = new MockDriver();
  const cleanup = { status: "cleanup_pending", sessionId: "failed-setup-allocation" };
  driver.connect = async () => {
    throw Object.assign(new Error("page setup cleanup failed"), { providerCleanup: cleanup });
  };
  await expect(
    runFlow({
      flowPath: "/virtual/setup.toml",
      flowSource:
        'version=1\nkind="flow"\nid="setup"\ndescription="setup"\n[[steps]]\nid="open"\ndo="goto"\nurl="https://fixture.test/"',
      config: resolveConfigWithDefaults([{}]),
      fs: memoryFileSystem(),
      env: {},
      out: "/virtual/runs",
      driverFactory: () => driver,
    }),
  ).rejects.toMatchObject({
    providerCleanup: cleanup,
    runResult: { summary: { verdict: "error" } },
  });
});
