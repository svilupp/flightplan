import { expect, test } from "bun:test";
import {
  memoryCheckpointStore,
  resumeYield,
  runYield,
  type YieldCheckpoint,
  type YieldHost,
} from "./checkpoints.ts";

function fixture(overrides: Partial<YieldHost> = {}) {
  const calls: string[] = [];
  const host: YieldHost = {
    store: memoryCheckpointStore(),
    binding: "caller-and-input-references",
    timeoutMs: 1000,
    currentIdentity: async () => ({
      ownerEpoch: "epoch1",
      grantToken: "fp1",
      pageIdentity: "page1",
    }),
    releaseFlightplan: async () => {
      calls.push("release_fp");
    },
    acquireHost: async () => {
      calls.push("acquire_host");
    },
    perform: async () => {
      calls.push("perform");
      return { pageIdentity: "page2" };
    },
    releaseHost: async () => {
      calls.push("release_host");
    },
    acquireFlightplan: async () => {
      calls.push("acquire_fp");
      return { ownerEpoch: "epoch1", grantToken: "fp2", pageIdentity: "page2" };
    },
    refresh: async () => {
      calls.push("refresh");
    },
    verifyReturn: async () => {
      calls.push("verify");
      return true;
    },
    ...overrides,
  };
  return { host, calls };
}
const record = (): YieldCheckpoint => ({
  id: "opaque",
  version: 1,
  binding: "trusted",
  stepId: "yield",
  receipts: [{ stepId: "pay", dispatchState: "uncertain" }],
  identity: { ownerEpoch: "epoch1", grantToken: "fp1", pageIdentity: "page1" },
  expiresAt: Date.now() + 10000,
  state: "yielded",
});

test("yield transfers control, acquires a fresh grant and verifies before returning", async () => {
  const { host, calls } = fixture();
  const id = await runYield(host, {
    task: "Open order",
    stepId: "lookup",
    recipeBinding: "recipe1",
    receipts: [],
  });
  expect(id.length).toBeGreaterThan(10);
  expect(calls).toEqual([
    "release_fp",
    "acquire_host",
    "perform",
    "release_host",
    "acquire_fp",
    "refresh",
    "verify",
  ]);
  expect(
    await host.store.claim(id, JSON.stringify(["recipe1", host.binding, "lookup"]), Date.now()),
  ).toBeUndefined();
});
test("checkpoint store isolates receipts and atomically grants one resume", async () => {
  const store = memoryCheckpointStore();
  const checkpoint = record();
  await store.create(checkpoint);
  checkpoint.receipts.length = 0;
  const claimed = await Promise.all([
    store.claim("opaque", "trusted", Date.now()),
    store.claim("opaque", "trusted", Date.now()),
  ]);
  expect(claimed.filter(Boolean)).toHaveLength(1);
  expect(claimed.find(Boolean)?.receipts).toEqual([{ stepId: "pay", dispatchState: "uncertain" }]);
});
test("wrong binding, forged ID and expiry cannot acquire control", async () => {
  const { host, calls } = fixture();
  const checkpoint = record();
  await host.store.create(checkpoint);
  await expect(resumeYield(host, "opaque", "forged", "page2")).rejects.toThrow(
    "checkpoint_unavailable",
  );
  await expect(resumeYield(host, "forged", "trusted", "page2")).rejects.toThrow(
    "checkpoint_unavailable",
  );
  checkpoint.id = "expired";
  checkpoint.expiresAt = Date.now() - 1;
  await host.store.create(checkpoint);
  await expect(resumeYield(host, "expired", "trusted", "page2")).rejects.toThrow(
    "checkpoint_unavailable",
  );
  expect(calls).toEqual([]);
});
for (const [label, override] of [
  [
    "wrong page",
    {
      acquireFlightplan: async () => ({
        ownerEpoch: "epoch1",
        grantToken: "fp2",
        pageIdentity: "wrong",
      }),
    },
  ],
  [
    "stale grant",
    {
      acquireFlightplan: async () => ({
        ownerEpoch: "epoch1",
        grantToken: "fp1",
        pageIdentity: "page2",
      }),
    },
  ],
  [
    "new owner",
    {
      acquireFlightplan: async () => ({
        ownerEpoch: "epoch2",
        grantToken: "fp2",
        pageIdentity: "page2",
      }),
    },
  ],
  ["failed return condition", { verifyReturn: async () => false }],
] as Array<[string, Partial<YieldHost>]>) {
  test(`${label} is terminal and cannot replay prior mutation receipts`, async () => {
    const { host } = fixture(override);
    await host.store.create(record());
    await expect(resumeYield(host, "opaque", "trusted", "page2")).rejects.toThrow();
    await expect(resumeYield(host, "opaque", "trusted", "page2")).rejects.toThrow(
      "checkpoint_unavailable",
    );
  });
}
test("uncooperative host timeout revokes its lease and never reacquires Flightplan", async () => {
  const { host, calls } = fixture({ timeoutMs: 5, perform: () => new Promise(() => {}) });
  await expect(
    runYield(host, { task: "bounded", stepId: "yield", recipeBinding: "recipe", receipts: [] }),
  ).rejects.toThrow("yield_failed");
  expect(calls).toEqual(["release_fp", "acquire_host", "release_host"]);
});
test("concurrent resume only reacquires once", async () => {
  const { host, calls } = fixture();
  await host.store.create(record());
  const results = await Promise.allSettled([
    resumeYield(host, "opaque", "trusted", "page2"),
    resumeYield(host, "opaque", "trusted", "page2"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(calls.filter((c) => c === "acquire_fp")).toHaveLength(1);
});

test("checkpoint terminal-store failure is bounded and cannot reopen the claim", async () => {
  const store = memoryCheckpointStore();
  const { host } = fixture({
    timeoutMs: 5,
    cleanupTimeoutMs: 5,
    store: { ...store, finish: () => new Promise(() => {}) },
  });
  await store.create(record());
  await expect(resumeYield(host, "opaque", "trusted", "page2")).rejects.toThrow();
  expect(await store.claim("opaque", "trusted", Date.now())).toBeUndefined();
});
test("late host completion after cancellation never resumes Flightplan", async () => {
  let finish!: (value: { pageIdentity: string }) => void;
  const { host, calls } = fixture({
    timeoutMs: 5,
    perform: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await expect(
    runYield(host, { task: "bounded", stepId: "yield", recipeBinding: "recipe", receipts: [] }),
  ).rejects.toThrow("yield_failed");
  finish({ pageIdentity: "page2" });
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(calls).not.toContain("acquire_fp");
});

test("synchronous abort during host operation cannot lose the abort notification", async () => {
  const controller = new AbortController();
  const { host } = fixture({
    signal: controller.signal,
    currentIdentity: () => {
      controller.abort();
      return new Promise(() => {});
    },
  });
  await expect(
    runYield(host, { task: "bounded", stepId: "yield", recipeBinding: "recipe", receipts: [] }),
  ).rejects.toThrow("yield_failed");
});
