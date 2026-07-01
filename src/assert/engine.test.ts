// Flightplan — tests for the assertion engine (dispatch + phase/eager/deferred + ai_judge stub).
//
// All tests use `MockDriver` + an injected `FakeClock` (fast, no real sleeping).

import { describe, expect, test } from "bun:test";
import { MockDriver } from "../driver/mock-driver.ts";
import { makeInteractiveElement, makeSnapshot } from "../driver/mock-fixtures.ts";
import type { Assertion } from "../flow/types.ts";
import type { PageSnapshot } from "../driver/types.ts";
import { FakeClock } from "./clock.ts";
import {
  isPhase4NotImplemented,
  Phase4NotImplementedError,
  runAssertion,
  runAssertions,
} from "./engine.ts";
import type { AssertContext } from "./types.ts";

const SNAP: PageSnapshot = makeSnapshot({
  url: "http://localhost:3000/checkout",
  text: "Order placed. Thank you!",
  interactiveElements: [
    makeInteractiveElement({ ref: "e1", role: "button", name: "Continue" }),
    makeInteractiveElement({ ref: "e2", role: "textbox", name: "Email", value: "a@b.com" }),
  ],
});

/** A context backed by `d` + a fresh FakeClock. */
function ctx(d: MockDriver, over: Partial<AssertContext> = {}): AssertContext {
  return {
    driver: d,
    defaultTimeoutMs: 1000,
    mode: "deferred",
    failOnAssertion: true,
    clock: new FakeClock(),
    pollIntervalMs: 50,
    ...over,
  };
}

describe("runAssertion — dispatch + phase stamping", () => {
  test("dispatches a visible assertion and stamps default phase 'after'", async () => {
    const d = new MockDriver().setSnapshot(SNAP);
    const r = await runAssertion({ type: "visible", selector: "role:button:Continue" }, ctx(d));
    expect(r.pass).toBe(true);
    expect(r.when).toBe("after");
  });

  test("stamps phase 'before' when when='before'", async () => {
    const d = new MockDriver().setSnapshot(SNAP);
    const r = await runAssertion(
      { type: "url", url: "/checkout", when: "before" },
      ctx(d),
    );
    expect(r.pass).toBe(true);
    expect(r.when).toBe("before");
  });

  test("a text assertion uses contains semantics", async () => {
    const d = new MockDriver().setSnapshot(SNAP);
    const r = await runAssertion({ type: "text", text: "thank you" }, ctx(d));
    expect(r.pass).toBe(true);
  });
});

describe("per-assertion timeout_ms overrides the RunLimits default", () => {
  test("a failing assertion uses assertion.timeout_ms, not defaultTimeoutMs", async () => {
    const d = new MockDriver().setSnapshot(SNAP);
    const clock = new FakeClock();
    // default is huge (would dominate if used); the assertion overrides to a tiny 80ms.
    const r = await runAssertion(
      { type: "visible", selector: "role:button:Nope", timeout_ms: 80 },
      ctx(d, { defaultTimeoutMs: 100_000, clock }),
    );
    expect(r.pass).toBe(false);
    // Proven by the elapsed virtual time tracking the override (≈80ms), not 100_000.
    expect(r.durationMs).toBeGreaterThanOrEqual(80);
    expect(r.durationMs).toBeLessThan(1000);
  });
});

describe("ai_judge routes to the clearly-marked Phase-4 stub", () => {
  test("runAssertion throws Phase4NotImplementedError (never silently passes)", async () => {
    const d = new MockDriver().setSnapshot(SNAP);
    const judge: Assertion = { type: "ai_judge", prompt: "Does it look right?" };
    let thrown: unknown;
    try {
      await runAssertion(judge, ctx(d));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Phase4NotImplementedError);
    expect(isPhase4NotImplemented(thrown)).toBe(true);
  });

  test("runAssertions surfaces ai_judge as a failing, clearly-marked result (not a pass)", async () => {
    const d = new MockDriver().setSnapshot(SNAP);
    const judge: Assertion = { type: "ai_judge", prompt: "ok?" };
    const results = await runAssertions([judge], ctx(d, { mode: "deferred" }), "after");
    expect(results).toHaveLength(1);
    expect(results[0]?.pass).toBe(false);
    expect(results[0]?.type).toBe("ai_judge");
    expect(results[0]?.message).toContain("Phase 4");
  });
});

describe("when filtering", () => {
  const before: Assertion = { type: "url", url: "/checkout", when: "before" };
  const after1: Assertion = { type: "visible", selector: "role:button:Continue", when: "after" };
  const afterDefault: Assertion = { type: "text", text: "thank you" }; // default after

  test("before-phase runs only when='before' assertions", async () => {
    const d = new MockDriver().setSnapshot(SNAP);
    const results = await runAssertions([before, after1, afterDefault], ctx(d), "before");
    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe("url");
    expect(results[0]?.when).toBe("before");
  });

  test("after-phase runs when='after' AND default (no when) assertions", async () => {
    const d = new MockDriver().setSnapshot(SNAP);
    const results = await runAssertions([before, after1, afterDefault], ctx(d), "after");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.type).sort()).toEqual(["text", "visible"]);
  });
});

describe("eager vs deferred", () => {
  // 3 after-phase assertions: pass, FAIL, pass. The 2nd fails (no such button, short timeout).
  const a1: Assertion = { type: "visible", selector: "role:button:Continue" }; // pass
  const a2: Assertion = { type: "visible", selector: "role:button:Nope", timeout_ms: 60 }; // FAIL
  const a3: Assertion = { type: "text", text: "thank you" }; // pass

  test("eager stops at the first failure (later assertions NOT evaluated)", async () => {
    const d = new MockDriver().setSnapshot(SNAP);
    const results = await runAssertions([a1, a2, a3], ctx(d, { mode: "eager" }), "after");
    expect(results).toHaveLength(2); // a1 (pass), a2 (fail) — a3 never ran
    expect(results[0]?.pass).toBe(true);
    expect(results[1]?.pass).toBe(false);
  });

  test("deferred runs all and reports every failure", async () => {
    const d = new MockDriver().setSnapshot(SNAP);
    const results = await runAssertions([a1, a2, a3], ctx(d, { mode: "deferred" }), "after");
    expect(results).toHaveLength(3); // all evaluated
    expect(results.map((r) => r.pass)).toEqual([true, false, true]);
    // every failure is collected (here exactly one)
    expect(results.filter((r) => !r.pass)).toHaveLength(1);
  });

  test("deferred with multiple failures collects all of them", async () => {
    const d = new MockDriver().setSnapshot(SNAP);
    const f1: Assertion = { type: "visible", selector: "role:button:NopeA", timeout_ms: 40 };
    const f2: Assertion = { type: "visible", selector: "role:button:NopeB", timeout_ms: 40 };
    const results = await runAssertions([f1, a1, f2], ctx(d, { mode: "deferred" }), "after");
    expect(results).toHaveLength(3);
    expect(results.filter((r) => !r.pass)).toHaveLength(2);
  });
});

describe("eager short-circuit is fast (no real sleeping; deadlines are virtual)", () => {
  test("a never-true eager assertion with a large timeout still returns instantly", async () => {
    const d = new MockDriver().setSnapshot(makeSnapshot({ text: "loading" }));
    const clock = new FakeClock();
    const slow: Assertion = { type: "visible", selector: "role:button:X", timeout_ms: 30_000 };
    const wall = Date.now();
    const results = await runAssertions([slow], ctx(d, { mode: "eager", clock }), "after");
    const realElapsed = Date.now() - wall;
    expect(results[0]?.pass).toBe(false);
    // Virtual time crossed the 30s deadline...
    expect(clock.now()).toBeGreaterThanOrEqual(30_000);
    // ...but no real time was spent (well under a second).
    expect(realElapsed).toBeLessThan(2000);
  });
});
