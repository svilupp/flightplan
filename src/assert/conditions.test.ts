// Flightplan — tests for the six deterministic assertion evaluators + the polling loop.
//
// All tests run against `MockDriver` with an injected `FakeClock`, so NOTHING sleeps in real
// time — the loop's own `clock.sleep()` advances virtual time to the deadline instantly. Each
// of the six conditions has a passing case and a failing/timeout case; plus polling-becomes-true
// and never-becomes-true (timeout) cases.

import { describe, expect, test } from "bun:test";
import { MockDriver } from "../driver/mock-driver.ts";
import { makeInteractiveElement, makeSnapshot } from "../driver/mock-fixtures.ts";
import type { ElementState, PageSnapshot } from "../driver/types.ts";
import type { Assertion } from "../flow/types.ts";
import { FakeClock } from "./clock.ts";
import {
  count,
  evaluateDeterministic,
  hidden,
  pageState,
  result,
  state,
  text,
  transition,
  urlMatchesPattern,
  value,
  visible,
} from "./conditions.ts";
import type { ConditionOpts } from "./types.ts";

/** Build an `ElementState` with sensible "absent" defaults; override what a test cares about. */
function es(partial: Partial<ElementState> = {}): ElementState {
  return {
    exists: false,
    visible: false,
    count: 0,
    text: "",
    value: null,
    boundingBox: null,
    ...partial,
  };
}

/** Build ConditionOpts wired to a driver + a fresh FakeClock (returned for inspection). */
function opts(
  driver: MockDriver,
  timeoutMs = 1000,
  pollIntervalMs = 50,
): {
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

  test("urlMatchesPattern supports exact and normalized origin/path modes", () => {
    expect(
      urlMatchesPattern(
        "https://x.example/orders/7?tab=paid",
        "https://x.example/orders/7",
        "exact",
      ),
    ).toBe(false);
    expect(
      urlMatchesPattern(
        "https://x.example/orders/7?tab=paid",
        "https://x.example/orders/7",
        "origin_path",
      ),
    ).toBe(true);
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

describe("effect-aware state and transitions", () => {
  test("text regex, element state, page state, and captured transitions are deterministic", async () => {
    const d = new MockDriver()
      .setSnapshot(
        makeSnapshot({
          url: "http://localhost:3000/after",
          text: "Order #42 committed",
          interactiveElements: [
            makeInteractiveElement({
              ref: "e1",
              role: "checkbox",
              name: "Gift card",
              checked: true,
              disabled: false,
            }),
          ],
        }),
      )
      .setElementState(
        es({
          exists: true,
          visible: true,
          count: 1,
          value: "11",
          checked: true,
          disabled: false,
          selected: true,
        }),
      )
      .setPageState({ popupCount: 1, menuOpen: true });
    const { opts: o } = opts(d);

    expect((await text(undefined, "^Order #[0-9]+ committed$", o, "regex")).pass).toBe(true);
    expect((await state("#gift-card", "checked", o)).pass).toBe(true);
    expect((await pageState("new_page", o)).pass).toBe(true);
    expect(
      (
        await transition("url_changed", undefined, {
          ...o,
          beforeState: { url: "http://localhost:3000/before" },
        })
      ).pass,
    ).toBe(true);
  });
});

// helper to avoid shadowing `url` import name in the passing test
async function urlEvalPass(_d: MockDriver, o: ConditionOpts) {
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

describe("synthetic/CSS targets resolve via driver.elementState", () => {
  test("visible passes when elementState reports the synthetic selector visible", async () => {
    const d = new MockDriver().setElementState(es({ exists: true, visible: true, count: 1 }));
    const { opts: o } = opts(d);
    const r = await visible("[data-testid='toolbar']", o);
    expect(r.pass).toBe(true);
    // delegated to the live-DOM primitive with the RAW selector (not the AX snapshot path)
    const calls = d.callsTo("elementState");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.args[0]).toBe("[data-testid='toolbar']");
  });

  test("visible fails (times out) when elementState reports not visible", async () => {
    const d = new MockDriver().setElementState(es({ exists: true, visible: false, count: 1 }));
    const { opts: o } = opts(d, 100);
    const r = await visible("[data-testid='toolbar']", o);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("not visible");
  });

  test("a synthetic target resolving via elementState NEVER fetches a snapshot (Item 5 perf)", async () => {
    // A pure synthetic/CSS target answered entirely by elementState must skip driver.snapshot()
    // across every poll — even a timing-out (multi-poll) assertion.
    const d = new MockDriver().setElementState(es({ exists: true, visible: false, count: 1 }));
    const { opts: o } = opts(d, 200);
    await visible("[data-testid='toolbar']", o); // times out → several polls
    expect(d.callsTo("elementState").length).toBeGreaterThan(1);
    expect(d.callsTo("snapshot").length).toBe(0);
  });

  test("onElementState provider keys on the queried selector", async () => {
    const d = new MockDriver().onElementState((sel) =>
      sel === "[data-testid='toolbar']" ? es({ exists: true, visible: true, count: 1 }) : es(),
    );
    const { opts: o } = opts(d);
    expect((await visible("[data-testid='toolbar']", o)).pass).toBe(true);
  });

  test("hidden passes when the synthetic selector is not visible", async () => {
    const d = new MockDriver().setElementState(es({ exists: true, visible: false, count: 1 }));
    const { opts: o } = opts(d);
    const r = await hidden("[data-testid='toolbar']", o);
    expect(r.pass).toBe(true);
  });

  test("count uses elementState.count for a synthetic selector (non-interactive rows)", async () => {
    const d = new MockDriver().setElementState(es({ exists: true, visible: true, count: 3 }));
    const { opts: o } = opts(d);
    const r = await count("[data-testid='row']", 3, o);
    expect(r.pass).toBe(true);
  });

  test("count fails (times out) when the synthetic count differs", async () => {
    const d = new MockDriver().setElementState(es({ exists: true, visible: true, count: 3 }));
    const { opts: o } = opts(d, 100);
    const r = await count("[data-testid='row']", 5, o);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("count is 3, expected 5");
  });

  test("text matches against elementState.text for a synthetic selector", async () => {
    const d = new MockDriver().setElementState(
      es({ exists: true, visible: true, text: "Total: 12 users" }),
    );
    const { opts: o } = opts(d);
    expect((await text("[data-testid='total']", "Total: 12", o)).pass).toBe(true);
    const { opts: o2 } = opts(d, 100);
    expect((await text("[data-testid='total']", "not there", o2)).pass).toBe(false);
  });

  test("value matches elementState.value for a synthetic form-control selector", async () => {
    const d = new MockDriver().setElementState(
      es({ exists: true, visible: true, count: 1, value: "GB" }),
    );
    const { opts: o } = opts(d);
    const r = await value("[data-testid='ship-country']", "GB", o);
    expect(r.pass).toBe(true);
    expect(r.message).toContain('value === "GB"');
    // read via the live-DOM primitive with the raw selector, not the AX snapshot
    expect(d.callsTo("elementState")[0]?.args[0]).toBe("[data-testid='ship-country']");
  });

  test("value fails (times out) when the synthetic value differs", async () => {
    const d = new MockDriver().setElementState(
      es({ exists: true, visible: true, count: 1, value: "US" }),
    );
    const { opts: o } = opts(d, 100);
    const r = await value("[data-testid='ship-country']", "GB", o);
    expect(r.pass).toBe(false);
    expect(r.message).toContain('value is "US", expected "GB"');
  });

  test("value fails with a clear message when the synthetic element is absent", async () => {
    const d = new MockDriver().setElementState(es({ exists: false, count: 0, value: null }));
    const { opts: o } = opts(d, 100);
    const r = await value("[data-testid='ship-country']", "GB", o);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("no element matched");
  });

  test("count with a css:-prefixed selector uses elementState.count (prefix stripped)", async () => {
    const d = new MockDriver().setElementState(es({ exists: true, visible: true, count: 5 }));
    const { opts: o } = opts(d);
    const r = await count("css:tr", 5, o);
    expect(r.pass).toBe(true);
    // routed through the live-DOM primitive with the `css:` prefix STRIPPED
    expect(d.callsTo("elementState")[0]?.args[0]).toBe("tr");
  });

  test("count with a css:-prefixed selector fails (times out) on a mismatch", async () => {
    const d = new MockDriver().setElementState(es({ exists: true, visible: true, count: 5 }));
    const { opts: o } = opts(d, 100);
    const r = await count("css:tr", 3, o);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("count is 5, expected 3");
  });

  test("visible with a css:-prefixed compound selector routes to elementState (prefix stripped)", async () => {
    const d = new MockDriver().setElementState(es({ exists: true, visible: true, count: 1 }));
    const { opts: o } = opts(d);
    const r = await visible("css:div.card", o);
    expect(r.pass).toBe(true);
    const calls = d.callsTo("elementState");
    expect(calls.length).toBeGreaterThan(0);
    // the raw selector reaching elementState has the `css:` prefix stripped
    expect(calls[0]?.args[0]).toBe("div.card");
  });

  test("feature-detect: a driver without elementState falls back to the snapshot path", async () => {
    // Strip elementState off a MockDriver so the code takes the (unchanged) snapshot fallback for
    // a synthetic target — no matching interactive element → visible fails, exactly as pre-change.
    const d = new MockDriver().setSnapshot(SNAP_WITH_BUTTON);
    (d as { elementState?: unknown }).elementState = undefined;
    const { opts: o } = opts(d, 80);
    const r = await visible("[data-testid='missing']", o);
    expect(r.pass).toBe(false);
    expect(d.callsTo("elementState").length).toBe(0);
  });
});

describe("silent-ignore bug: visible/hidden honor BOTH selector and text (regression)", () => {
  test("visible passes when the element is visible AND its text contains the expected", async () => {
    const d = new MockDriver().setElementState(
      es({ exists: true, visible: true, text: "Total: 12 users" }),
    );
    const { opts: o } = opts(d);
    const assertion: Assertion = {
      type: "visible",
      selector: "[data-testid='x']",
      text: "Total: 12 users",
    };
    const r = await evaluateDeterministic(assertion, o);
    expect(r.pass).toBe(true);
  });

  test("visible FAILS when the element is visible but its text does NOT contain the expected", async () => {
    // The bug: supplying BOTH selector and text dropped the text check → this used to PASS.
    const d = new MockDriver().setElementState(
      es({ exists: true, visible: true, text: "Total: 3 users" }),
    );
    const { opts: o } = opts(d, 100);
    const assertion: Assertion = {
      type: "visible",
      selector: "[data-testid='x']",
      text: "Total: 12 users",
    };
    const r = await evaluateDeterministic(assertion, o);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("does not contain");
  });

  test("hidden passes when the element is visible but its text mismatches (negation)", async () => {
    const d = new MockDriver().setElementState(
      es({ exists: true, visible: true, text: "Total: 3 users" }),
    );
    const { opts: o } = opts(d);
    const assertion: Assertion = {
      type: "hidden",
      selector: "[data-testid='x']",
      text: "Total: 12 users",
    };
    const r = await evaluateDeterministic(assertion, o);
    expect(r.pass).toBe(true);
  });
});

describe("result", () => {
  test("matches a typed nested value", async () => {
    const { opts: o } = opts(new MockDriver());
    const r = await result("order.id", 42, undefined, {
      ...o,
      actionResult: { order: { id: 42 } },
    });
    expect(r.pass).toBe(true);
    expect(r.type).toBe("result");
  });

  test("supports root and existence predicates", async () => {
    const { opts: o } = opts(new MockDriver());
    expect((await result(".", undefined, true, { ...o, actionResult: { ok: true } })).pass).toBe(
      true,
    );
    expect(
      (await result("missing", undefined, false, { ...o, actionResult: { ok: true } })).pass,
    ).toBe(true);
  });

  test("does not expose observed values in failure messages", async () => {
    const { opts: o } = opts(new MockDriver());
    const r = await result("token", "expected", undefined, {
      ...o,
      actionResult: { token: "super-secret" },
    });
    expect(r.pass).toBe(false);
    expect(r.message).not.toContain("super-secret");
  });
});
