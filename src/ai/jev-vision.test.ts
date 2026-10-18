import { expect, test } from "bun:test";
import {
  MockDriver,
  makeRankedCandidate,
  makeSnapshot,
  makeSuccessBatch,
} from "../driver/index.ts";
import type { Driver } from "../driver/types.ts";
import type { Step } from "../flow/types.ts";
import { createAiRuntime } from "./runtime.ts";
import type { JevVisualEvidence } from "./vision-evidence.ts";

const step = { id: "visual", do: "click", target: "Save", effect: "at_most_once" } as Step;
const prior = { ok: false, tier: "L2" as const, candidates: [], escalate: true };
function fixture(presence = 1, options: { unsafe?: boolean; max?: number; abort?: boolean } = {}) {
  const driver = new MockDriver();
  const abort = new AbortController();
  let dispatches = 0,
    captures = 0,
    calls = 0;
  driver.setSnapshot(makeSnapshot({ url: "https://example.test", interactiveElements: [] }));
  driver.setResolveAll([
    makeRankedCandidate({ role: "button", ref: "e1", name: "Save" }),
    makeRankedCandidate({ role: "button", ref: "e2", name: "Save" }),
  ]);
  driver.setBatchResult(makeSuccessBatch("ref:e2"));
  const original = driver.batch.bind(driver);
  driver.batch = async (...args) => {
    dispatches++;
    return original(...args);
  };
  const captureDriver: Driver = driver;
  captureDriver.validateJevEvidence = async () => true;
  captureDriver.captureJevEvidence = async () => {
    captures++;
    return {
      captureId: "capture",
      url: "https://example.test",
      frameId: "main",
      signature: "fixed",
      observedAtMs: Date.now(),
      pixelsSafe: !options.unsafe,
      image: {
        format: "png",
        width: 400,
        height: 300,
        data_base64:
          "iVBORw0KGgoAAAANSUhEUgAAAZAAAAEsCAIAAABi1XKVAAAD60lEQVR4nO3UMQ0AMAzAsPIn3VLYN0WyEeTKLEDE/A4AeGVYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGYYFZBgWkGFYQIZhARmGBWQYFpBhWECGYQEZhgVkGBaQYVhAhmEBGQc11BPYcmFangAAAABJRU5ErkJggg==",
      },
      viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0, dpr: 1 },
      geometry: {
        e1: { x: 10, y: 10, width: 30, height: 30 },
        e2: { x: 60, y: 10, width: 30, height: 30 },
      },
    } satisfies JevVisualEvidence;
  };
  const rt = createAiRuntime({
    config: {
      ai: {
        classifier: "jev",
        jev: { profile: "visual", images: "allow", max_calls_per_step: options.max ?? 2 },
      },
    },
    jevApiKey: "test",
    signal: abort.signal,
    aiWriter: { emitAiCall() {} },
    fetchFn: (async (_url: unknown, init: RequestInit) => {
      calls++;
      const request = JSON.parse(init.body as string);
      expect(Object.keys(request.questions.pick.criteria)).toEqual([
        "c0",
        "c1",
        "none_of_the_above",
      ]);
      if (options.abort) abort.abort();
      return Response.json({
        model: "jev-1.14.0",
        answers: {
          pick: {
            type: "choice",
            choice: "c1",
            confidence: 0.99,
            probabilities: { c0: 0.01, c1: 0.98, none_of_the_above: 0.01 },
          },
          present: { type: "noul", noul: presence },
        },
        usage: { input_tokens: 100, output_tokens: 0 },
      });
    }) as unknown as typeof fetch,
  });
  return { rt, driver, counts: () => ({ dispatches, captures, calls }) };
}
test("JEV-only visual retains duplicate labels and dispatches supplied physical index", async () => {
  const f = fixture();
  const result = await f.rt.hooks.resolveL3!(step, prior, { driver: f.driver, now: Date.now });
  expect(result.ok).toBe(true);
  expect(f.counts()).toEqual({ dispatches: 1, captures: 1, calls: 1 });
});
test("presence uncertainty cannot dispatch", async () => {
  const f = fixture(0.5);
  const result = await f.rt.hooks.resolveL3!(step, prior, { driver: f.driver, now: Date.now });
  expect(result.ok).toBe(false);
  expect(f.counts().dispatches).toBe(0);
});
test("absent target vetoes a confident candidate through the production visual hook", async () => {
  const f = fixture(0);
  const result = await f.rt.hooks.resolveL3!(step, prior, { driver: f.driver, now: Date.now });
  expect(result.ok).toBe(false);
  expect(result.error).toBe("jev_presence_low");
  expect(f.counts()).toEqual({ dispatches: 0, captures: 1, calls: 1 });
});
test("unsafe pixels never transmitted", async () => {
  const f = fixture(1, { unsafe: true });
  await f.rt.hooks.resolveL3!(step, prior, { driver: f.driver, now: Date.now });
  expect(f.counts()).toEqual({ dispatches: 0, captures: 1, calls: 0 });
});
test("cancellation during image response blocks dispatch", async () => {
  const f = fixture(1, { abort: true });
  await f.rt.hooks.resolveL3!(step, prior, { driver: f.driver, now: Date.now });
  expect(f.counts().dispatches).toBe(0);
});
test("batch maps each step independently and keeps run budgets", async () => {
  const f = fixture();
  const results = await f.rt.hooks.resolveBatchL3!([step, { ...step, id: "visual2" }], {
    driver: f.driver,
    now: Date.now,
  });
  expect(results.map((r) => r.ok)).toEqual([true, true]);
  expect(f.counts()).toEqual({ dispatches: 2, captures: 1, calls: 2 });
});

test("hung visual capture expires and late evidence cannot upload or dispatch", async () => {
  const f = fixture();
  const driver: Driver = f.driver;
  const capture = driver.captureJevEvidence!.bind(driver);
  let release!: (evidence: JevVisualEvidence) => void;
  let started!: () => void;
  const startedCapture = new Promise<void>((resolve) => {
    started = resolve;
  });
  driver.captureJevEvidence = () => {
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const originalTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const { spyOn } = await import("bun:test");
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: Parameters<typeof setTimeout>[0],
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms && ms > 7000) expire = () => callback(...args);
    return originalTimeout(callback, ms, ...args);
  }) as typeof setTimeout);
  try {
    const pending = f.rt.hooks.resolveL3!(step, prior, { driver: f.driver, now: Date.now });
    await startedCapture;
    expect(expire).toBeDefined();
    expire!();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("jev_timeout");
    release(await capture({ refs: ["e1", "e2"] }));
    await Promise.resolve();
    expect(f.counts().calls).toBe(0);
    expect(f.counts().dispatches).toBe(0);
  } finally {
    timer.mockRestore();
  }
});
