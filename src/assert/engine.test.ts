// Flightplan — tests for the assertion engine (dispatch + phase/eager/deferred + ai_judge stub).
//
// All tests use `MockDriver` + an injected `FakeClock` (fast, no real sleeping).

import { describe, expect, test } from "bun:test";
import { MockDriver } from "../driver/mock-driver.ts";
import { makeInteractiveElement, makeSnapshot } from "../driver/mock-fixtures.ts";
import type { PageSnapshot } from "../driver/types.ts";
import type { Assertion } from "../flow/types.ts";
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
    const r = await runAssertion({ type: "url", url: "/checkout", when: "before" }, ctx(d));
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

describe("assertion selector regressions", () => {
  for (const selector of [
    "h1",
    "nav[aria-label='Main navigation']",
    "div.card",
    "input:checked",
    "span::after",
    "form input",
    "input + button",
    "img.hero",
    "button, input",
    "button:first-of-type",
    "iframe",
    "*",
    "center",
    "svg path",
    ":checked",
    "input:checked:enabled",
    ":disabled",
    "button:disabled:first-of-type",
    "input:checked + label",
    "button:disabled.primary",
  ]) {
    for (const assertion of [
      { type: "hidden", selector },
      { type: "count", selector, count: 0 },
    ] as const) {
      test(`rejects ambiguous CSS syntax in ${assertion.type}: ${selector}`, async () => {
        const result = await runAssertion(assertion, ctx(new MockDriver()));
        expect(result.pass).toBe(false);
        expect(result.message).toContain("prefix it with css:");
      });
    }
  }

  test("counts non-interactive AX nodes without double-counting interactive refs", async () => {
    const driver = new MockDriver().setSnapshot(
      makeSnapshot({
        accessibilityTree: [
          { ref: "e1", role: "heading", name: "Tasks" },
          {
            ref: "e2",
            role: "button",
            name: "Tasks",
            children: [
              {
                ref: "e3",
                role: "StaticText",
                name: "Tasks",
                children: [{ ref: "e4", role: "InlineTextBox", name: "Tasks" }],
              },
            ],
          },
        ],
        interactiveElements: [{ ref: "e2", selector: "#tasks", role: "button", name: "Tasks" }],
      }),
    );
    expect(
      (
        await runAssertion(
          { type: "count", selector: "role:heading:Tasks", count: 0, timeout_ms: 1 },
          ctx(driver),
        )
      ).pass,
    ).toBe(false);
    expect(
      (await runAssertion({ type: "count", selector: "role:heading:Tasks", count: 1 }, ctx(driver)))
        .pass,
    ).toBe(true);
    expect(
      (await runAssertion({ type: "count", selector: "text:Tasks", count: 2 }, ctx(driver))).pass,
    ).toBe(true);
  });

  test("colon-separated accessible names remain usable", async () => {
    const driver = new MockDriver().setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "textbox", name: "label: Email" }),
        ],
      }),
    );
    expect(
      (await runAssertion({ type: "visible", selector: "label: Email" }, ctx(driver))).pass,
    ).toBe(true);
  });
});

describe("semantic selector identity", () => {
  test("an explicit empty role name does not match a named control", async () => {
    const driver = new MockDriver().setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "empty", role: "button", name: "" }),
          makeInteractiveElement({ ref: "named", role: "button", name: "Continue" }),
        ],
      }),
    );
    expect(
      (
        await runAssertion(
          { type: "count", selector: 'role:button[name=""]', count: 1 },
          ctx(driver),
        )
      ).pass,
    ).toBe(true);
    expect(
      (await runAssertion({ type: "count", selector: "role:button", count: 2 }, ctx(driver))).pass,
    ).toBe(true);
  });

  test.each([
    "within(role:dialog:Summary) >> role:button:Paid",
    "role:dialog:Summary >> text:Paid",
    "text:Summary >> role:button:Paid",
  ])("preserves browser-pilot scope %s for live resolution", async (selector) => {
    const driver = new MockDriver().setElementState({
      exists: true,
      visible: true,
      count: 1,
      text: "Paid",
      value: null,
      boundingBox: null,
    });
    expect((await runAssertion({ type: "visible", selector }, ctx(driver))).pass).toBe(true);
    expect(driver.callsTo("elementState").map((call) => call.args)).toEqual([[selector]]);
    expect(driver.callsTo("snapshot")).toHaveLength(0);
  });

  for (const source of ["interactive", "accessibility"] as const) {
    test(`explicit role/text names match exactly in ${source} snapshots`, async () => {
      const driver = new MockDriver().setSnapshot(
        makeSnapshot({
          text: "Unpaid",
          ...(source === "interactive"
            ? {
                interactiveElements: [
                  makeInteractiveElement({ ref: "e1", role: "status", name: "Unpaid" }),
                ],
              }
            : { accessibilityTree: [{ ref: "e1", role: "status", name: "Unpaid" }] }),
        }),
      );
      for (const selector of [
        "role:status:Paid",
        'role:status[name="Paid"]',
        "text:Paid",
        "text:unpaid",
      ]) {
        expect((await runAssertion({ type: "visible", selector }, ctx(driver))).pass).toBe(false);
        expect((await runAssertion({ type: "count", selector, count: 0 }, ctx(driver))).pass).toBe(
          true,
        );
        expect((await runAssertion({ type: "hidden", selector }, ctx(driver))).pass).toBe(true);
      }
      for (const selector of ["role:status:Unpaid", "text:Unpaid"]) {
        expect((await runAssertion({ type: "visible", selector }, ctx(driver))).pass).toBe(true);
        expect((await runAssertion({ type: "count", selector, count: 1 }, ctx(driver))).pass).toBe(
          true,
        );
      }
      expect(
        (
          await runAssertion(
            { type: "text", selector: "role:status", text: "Paid", match: "contains" },
            ctx(driver),
          )
        ).pass,
      ).toBe(true);
      expect(
        (
          await runAssertion(
            { type: "text", selector: "role:status", text: "Paid", match: "exact" },
            ctx(driver),
          )
        ).pass,
      ).toBe(false);
    });
  }

  test.each([
    "Search results",
    "Summary",
    "Main navigation",
    "Sign-in",
    "I agree to the terms",
    "my-widget",
    "H1",
  ])("plain accessible name %s is accepted by assertions", async (selector) => {
    const driver = new MockDriver().setSnapshot(
      makeSnapshot({
        accessibilityTree: [{ ref: "e1", role: "heading", name: selector }],
      }),
    );
    expect((await runAssertion({ type: "visible", selector }, ctx(driver))).pass).toBe(true);
    expect((await runAssertion({ type: "count", selector, count: 1 }, ctx(driver))).pass).toBe(
      true,
    );
  });
});

test("negative CSS assertions fail clearly without a live DOM capability", async () => {
  const driver = new MockDriver().setSnapshot(SNAP);
  Object.assign(driver, { elementState: undefined });
  for (const assertion of [
    { type: "hidden", selector: "css:h1" },
    { type: "state", state: "hidden", selector: "css:h1" },
    { type: "count", selector: "css:h1", count: 0 },
  ] as const) {
    const result = await runAssertion(assertion, ctx(driver));
    expect(result.pass).toBe(false);
    expect(result.message).toContain("absence cannot be verified from a snapshot");
  }
  for (const selector of ["css:text:Nope", "css:css:h1"]) {
    const result = await runAssertion({ type: "count", selector, count: 0 }, ctx(driver));
    expect(result.pass).toBe(false);
    expect(result.message).toContain("css: requires a raw CSS selector");
  }
});

test("bare names cannot prove absence even when they look like natural language", async () => {
  const driver = new MockDriver().setSnapshot(SNAP);
  for (const assertion of [
    { type: "hidden", selector: "app-banner" },
    { type: "state", state: "hidden", selector: "Continue later" },
    { type: "count", selector: "H1", count: 0 },
  ] as const) {
    const result = await runAssertion(assertion, ctx(driver));
    expect(result.pass).toBe(false);
    expect(result.message).toContain("Absence requires an explicit selector");
  }
  expect(driver.callsTo("snapshot")).toHaveLength(0);
  const explicitName = await runAssertion(
    { type: "state", state: "hidden", selector: "text:Continue later" },
    ctx(driver),
  );
  expect(explicitName.pass).toBe(true);
});

test("an assertion probe cannot return a late pass after its deadline", async () => {
  const driver = new MockDriver();
  driver.elementState = async () => new Promise<never>(() => {});
  const start = performance.now();
  const result = await runAssertion(
    { type: "visible", selector: "css:h1", timeout_ms: 10 },
    {
      driver,
      defaultTimeoutMs: 1000,
      mode: "eager",
      failOnAssertion: true,
    },
  );
  expect(result.pass).toBe(false);
  expect(result.message).toContain("deadline");
  expect(performance.now() - start).toBeLessThan(250);
});

test("role name spellings preserve all matching elements for count assertions", async () => {
  const driver = new MockDriver().setSnapshot(
    makeSnapshot({
      interactiveElements: [
        makeInteractiveElement({ ref: "e1", role: "button", name: "Save" }),
        makeInteractiveElement({ ref: "e2", role: "button", name: "Save" }),
      ],
    }),
  );
  for (const selector of ["role:button:Save", 'role:button[name="Save"]', 'role:button:"Save"']) {
    expect((await runAssertion({ type: "count", selector, count: 2 }, ctx(driver))).pass).toBe(
      true,
    );
    expect((await runAssertion({ type: "count", selector, count: 1 }, ctx(driver))).pass).toBe(
      false,
    );
  }
});
