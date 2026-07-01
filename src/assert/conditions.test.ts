// Flightplan — tests for the six deterministic assertion evaluators + the polling loop.
//
// All tests run against `MockDriver` with an injected `FakeClock`, so NOTHING sleeps in real
// time — the loop's own `clock.sleep()` advances virtual time to the deadline instantly. Each
// of the six conditions has a passing case and a failing/timeout case; plus polling-becomes-true
// and never-becomes-true (timeout) cases.

import { describe, expect, test } from "bun:test";
import { MockDriver } from "../driver/mock-driver.ts";
import { makeInteractiveElement, makeSnapshot } from "../driver/mock-fixtures.ts";
import type { PageSnapshot } from "../driver/types.ts";
import { FakeClock } from "./clock.ts";
import { count, hidden, text, urlMatchesPattern, value, visible } from "./conditions.ts";
import type { ConditionOpts } from "./types.ts";

/** Build ConditionOpts wired to a driver + a fresh FakeClock (returned for inspection). */
function opts(driver: MockDriver, timeoutMs = 1000, pollIntervalMs = 50): {
  opts: ConditionOpts;
  clock: FakeClock;
} {
  const clock = new FakeClock();
  return { opts: { driver, timeoutMs, pollIntervalMs, clock }, clock };
}

const SNAP_WITH_BUTTON: PageSnapshot = makeSnapshot({
  url: "http://localhost:3000/wizard/step-2",
  text: "Welcome to the wizard. Order summary: 3 items.",
  interactiveElements: [
    makeInteractiveElement({ ref: "e1", role: "button", name: "Continue" }),
    makeInteractiveElement({ ref: "e2", role: "textbox", name: "First Name", value: "Ada" }),
  ],
});

describe("visible", () => {
  test("passes when a matching interactive element is present", async () => {
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    const { opts: o } = opts(d);
    const r = await visible("role:button:Continue", o);
    expect(r.pass).toBe(true);
    expect(r.type).toBe("visible");
  });

  test("times out (fails) when no element matches", async () => {
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    const { opts: o, clock } = opts(d, 200, 50);
    const r = await visible("role:button:Submit", o);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("timed out after 200ms");
    // It actually polled (didn't hang) and advanced to the deadline.
    expect(clock.sleeps).toBeGreaterThan(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(200);
  });
});

describe("hidden", () => {
  test("passes when the target is absent", async () => {
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    const { opts: o } = opts(d);
    const r = await hidden("role:button:Submit", o);
    expect(r.pass).toBe(true);
  });

  test("times out (fails) when the target stays present", async () => {
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    const { opts: o } = opts(d, 150);
    const r = await hidden("role:button:Continue", o);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("still visible");
  });
});

describe("text (contains, case-insensitive)", () => {
  test("passes on a whole-page substring (no selector)", async () => {
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    const { opts: o } = opts(d);
    const r = await text(undefined, "order summary", o); // case-insensitive
    expect(r.pass).toBe(true);
  });

  test("passes on a scoped element's accessible name", async () => {
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    const { opts: o } = opts(d);
    const r = await text("role:button", "Contin", o); // substring of "Continue"
    expect(r.pass).toBe(true);
  });

  test("times out (fails) when the text is absent", async () => {
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    const { opts: o } = opts(d, 100);
    const r = await text(undefined, "checkout complete", o);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("does not contain");
  });
});

describe("url (glob or substring)", () => {
  test("urlMatchesPattern: substring match ignores query string", () => {
    expect(urlMatchesPattern("https://x/checkout?ok=1", "/checkout")).toBe(true);
    expect(urlMatchesPattern("https://x/cart", "/checkout")).toBe(false);
  });

  test("urlMatchesPattern: glob match with *", () => {
    expect(urlMatchesPattern("http://localhost:3000/wizard/step-2", "*/wizard/*")).toBe(true);
    expect(urlMatchesPattern("http://localhost:3000/home", "*/wizard/*")).toBe(false);
  });

  test("passes when the current url matches", async () => {
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    const { opts: o } = opts(d);
    const r = await urlEvalPass(d, o);
    expect(r.pass).toBe(true);
  });

  test("times out (fails) when the url does not match", async () => {
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    const { opts: o } = opts(d, 100);
    const { url } = await import("./conditions.ts");
    const r = await url("/done", o);
    expect(r.pass).toBe(false);
  });
});

// helper to avoid shadowing `url` import name in the passing test
async function urlEvalPass(d: MockDriver, o: ConditionOpts) {
  const { url } = await import("./conditions.ts");
  return url("/wizard/step-2", o);
}

describe("value (exact equality)", () => {
  test("passes when the input value equals expected", async () => {
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    const { opts: o } = opts(d);
    const r = await value("role:textbox:First Name", "Ada", o);
    expect(r.pass).toBe(true);
  });

  test("times out (fails) on a value mismatch", async () => {
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    const { opts: o } = opts(d, 100);
    const r = await value("role:textbox:First Name", "Grace", o);
    expect(r.pass).toBe(false);
    expect(r.message).toContain('expected "Grace"');
  });

  test("fails when no element matches the target", async () => {
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    const { opts: o } = opts(d, 100);
    const r = await value("role:textbox:Nope", "x", o);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("no element matched");
  });
});

describe("count (exact)", () => {
  const SNAP_THREE = makeSnapshot({
    interactiveElements: [
      makeInteractiveElement({ ref: "e1", role: "listitem", name: "Item A" }),
      makeInteractiveElement({ ref: "e2", role: "listitem", name: "Item B" }),
      makeInteractiveElement({ ref: "e3", role: "listitem", name: "Item C" }),
      makeInteractiveElement({ ref: "e4", role: "button", name: "Add" }),
    ],
  });

  test("passes when the matching-element count equals n", async () => {
    const d = new MockDriver().setSnapshot(SNAP_THREE);
    const { opts: o } = opts(d);
    const r = await count("role:listitem", 3, o);
    expect(r.pass).toBe(true);
  });

  test("times out (fails) on a count mismatch", async () => {
    const d = new MockDriver().setSnapshot(SNAP_THREE);
    const { opts: o } = opts(d, 100);
    const r = await count("role:listitem", 5, o);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("count is 3, expected 5");
  });
});

describe("polling across changing snapshots", () => {
  test("passes when the condition becomes true on the 3rd poll", async () => {
    const d = new MockDriver();
    // snapshot()-per-call: the first 2 snapshots have no button, the 3rd+ does. (The mock
    // records the call BEFORE invoking the provider, so the Nth snapshot sees count === N.)
    d.onSnapshot(() => {
      const snapshotCalls = d.calls.filter((c) => c.method === "snapshot").length;
      return snapshotCalls >= 3
        ? SNAP_WITH_BUTTON
        : makeSnapshot({ url: "http://localhost:3000/loading", text: "loading..." });
    });
    const { opts: o, clock } = opts(d, 1000, 50);
    const r = await visible("role:button:Continue", o);
    expect(r.pass).toBe(true);
    // First probe (no sleep) fails, then it sleeps before probe 2 and probe 3 → 2 sleeps.
    expect(clock.sleeps).toBe(2);
    expect(d.callsTo("snapshot").length).toBe(3);
  });

  test("never becomes true → times out at the deadline, having polled", async () => {
    const d = new MockDriver().setSnapshot(
      makeSnapshot({ url: "http://localhost:3000/loading", text: "loading..." }),
    );
    const { opts: o, clock } = opts(d, 500, 50);
    const r = await visible("role:button:Continue", o);
    expect(r.pass).toBe(false);
    // deadline 500 / interval 50 → ~10 sleeps; assert it polled and stopped at the deadline.
    expect(clock.sleeps).toBeGreaterThanOrEqual(9);
    expect(clock.now()).toBeGreaterThanOrEqual(500);
    // and the snapshot was actually polled repeatedly (didn't hang on one read)
    expect(d.callsTo("snapshot").length).toBeGreaterThanOrEqual(10);
  });

  test("timeoutMs=0 still evaluates exactly once (immediate)", async () => {
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    const { opts: o, clock } = opts(d, 0, 50);
    const r = await visible("role:button:Continue", o);
    expect(r.pass).toBe(true);
    expect(clock.sleeps).toBe(0); // no polling needed; passed on the first probe
    expect(d.callsTo("snapshot").length).toBe(1);
  });
});
