// Tests for MockDriver — the contract the ladder/lock/assert agents depend on.

import { describe, expect, test } from "bun:test";
import type { ConnectConfig } from "../config/types.ts";
import { MOCK_PAGE_HANDLE, MockDriver } from "./mock-driver.ts";
import {
  makeFailureBatch,
  makeInteractiveElement,
  makeSnapshot,
  makeStepResult,
  makeSuccessBatch,
} from "./mock-fixtures.ts";
import { selectorUsedToStrategy } from "./selector-strategy.ts";
import type { BatchResult, BatchStep } from "./types.ts";

describe("MockDriver — lifecycle + call recording", () => {
  test("connect records the config and sets connected", async () => {
    const d = new MockDriver();
    const cfg: ConnectConfig = { mode: "attach", wsUrl: "ws://x" };
    await d.connect(cfg);
    expect(d.connected).toBe(true);
    expect(d.lastConnectConfig).toEqual(cfg);
    expect(d.callsTo("connect")).toHaveLength(1);
    expect(d.callsTo("connect")[0]?.args[0]).toEqual(cfg);
  });

  test("page() returns the sentinel handle", async () => {
    const d = new MockDriver();
    expect(await d.page()).toBe(MOCK_PAGE_HANDLE);
  });

  test("teardown clears connected", async () => {
    const d = new MockDriver();
    await d.connect({ mode: "launch" });
    await d.teardown();
    expect(d.connected).toBe(false);
    expect(d.lastCall?.method).toBe("teardown");
  });

  test("goto records the navigation and advances the current url", async () => {
    const d = new MockDriver();
    await d.goto("http://localhost:3000/wizard");
    expect(d.callsTo("goto")).toHaveLength(1);
    expect(d.callsTo("goto")[0]?.args[0]).toBe("http://localhost:3000/wizard");
    // currentUrl() returns the URL goto navigated to (default behaviour).
    expect(await d.currentUrl()).toBe("http://localhost:3000/wizard");
  });

  test("currentUrl honours setCurrentUrl + a one-shot queue, then falls back to default", async () => {
    const d = new MockDriver();
    d.setCurrentUrl("http://localhost:3000/start");
    d.enqueueCurrentUrl("http://localhost:3000/after-redirect");
    // queued one-shot first...
    expect(await d.currentUrl()).toBe("http://localhost:3000/after-redirect");
    // ...then the default.
    expect(await d.currentUrl()).toBe("http://localhost:3000/start");
    expect(d.callsTo("currentUrl")).toHaveLength(2);
  });

  test("calls are recorded in order with monotonic indices", async () => {
    const d = new MockDriver();
    await d.connect({ mode: "launch" });
    await d.snapshot();
    await d.click("#x");
    expect(d.calls.map((c) => c.method)).toEqual(["connect", "snapshot", "click"]);
    expect(d.calls.map((c) => c.index)).toEqual([0, 1, 2]);
  });
});

describe("MockDriver — scripted snapshots", () => {
  test("default snapshot is returned when nothing queued", async () => {
    const snap = makeSnapshot({ url: "http://localhost:3000/wizard" });
    const d = new MockDriver().setSnapshot(snap);
    expect(await d.snapshot()).toBe(snap);
    expect(await d.snapshot()).toBe(snap); // default persists
  });

  test("queued snapshots are consumed FIFO, then fall back to default", async () => {
    const a = makeSnapshot({ url: "a" });
    const b = makeSnapshot({ url: "b" });
    const def = makeSnapshot({ url: "def" });
    const d = new MockDriver().setSnapshot(def).enqueueSnapshot(a, b);
    expect((await d.snapshot()).url).toBe("a");
    expect((await d.snapshot()).url).toBe("b");
    expect((await d.snapshot()).url).toBe("def");
  });

  test("interactiveElements carry role + accessible name (+ attributes) for L1", async () => {
    const snap = makeSnapshot({
      interactiveElements: [
        makeInteractiveElement({ ref: "e1", role: "button", name: "Create order" }),
        makeInteractiveElement({ ref: "e2", role: "textbox", name: "Email", value: "" }),
      ],
    });
    const d = new MockDriver().setSnapshot(snap);
    const got = await d.snapshot();
    expect(got.interactiveElements[0]).toMatchObject({
      ref: "e1",
      role: "button",
      name: "Create order",
    });
    expect(got.interactiveElements[1]?.role).toBe("textbox");
  });

  test("onSnapshot provider takes precedence and sees the roles opt", async () => {
    const d = new MockDriver();
    d.onSnapshot((opts) => makeSnapshot({ url: `roles:${opts?.roles?.join(",") ?? "none"}` }));
    expect((await d.snapshot({ roles: ["button", "link"] })).url).toBe("roles:button,link");
  });
});

describe("MockDriver — scripted batch results (the escalation signals)", () => {
  test("default batch result returned when nothing queued", async () => {
    const r = makeSuccessBatch("[data-testid='go']");
    const d = new MockDriver().setBatchResult(r);
    expect(await d.batch([{ action: "click", selector: "x" }])).toBe(r);
  });

  test("simulate 'L1 strategy testid wins' via selectorUsed", async () => {
    const r = makeSuccessBatch("[data-testid='create-order']");
    const d = new MockDriver().enqueueBatchResult(r);
    const got = await d.batch([{ action: "click", selector: ["[data-testid='create-order']"] }]);
    const used = got.steps[0]?.selectorUsed;
    expect(used).toBe("[data-testid='create-order']");
    expect(selectorUsedToStrategy(used ?? "")).toBe("testid");
  });

  test("simulate 'all strategies fail with failureReason=covered' + coveringElement", async () => {
    const r = makeFailureBatch("covered", {
      coveringElement: { tag: "div", className: "fixture-cookie-banner" },
    });
    const d = new MockDriver().enqueueBatchResult(r);
    const got = await d.batch([{ action: "click", selector: "#blocked" }]);
    expect(got.success).toBe(false);
    expect(got.steps[0]?.failureReason).toBe("covered");
    expect(got.steps[0]?.coveringElement).toEqual({
      tag: "div",
      className: "fixture-cookie-banner",
    });
  });

  test("simulate a 'disabled' decoy failure", async () => {
    const d = new MockDriver().enqueueBatchResult(makeFailureBatch("disabled"));
    const got = await d.batch([{ action: "click", selector: "#decoy" }]);
    expect(got.steps[0]?.failureReason).toBe("disabled");
  });

  test("onBatch provider sees the steps and call index", async () => {
    const d = new MockDriver();
    const seen: BatchStep[][] = [];
    d.onBatch((steps, _opts, _i): BatchResult => {
      seen.push(steps);
      return makeSuccessBatch("text:Go");
    });
    await d.batch([{ action: "click", selector: "a" }]);
    expect(seen[0]?.[0]?.selector).toBe("a");
  });
});

describe("MockDriver — single-action outcomes", () => {
  test("default outcome is true", async () => {
    const d = new MockDriver();
    expect(await d.click("#x")).toBe(true);
    expect(await d.fill("#x", "v")).toBe(true);
  });

  test("global default outcome can be flipped to false", async () => {
    const d = new MockDriver().setActionOutcome(false);
    expect(await d.click("#x")).toBe(false);
    expect(await d.hover("#y")).toBe(false);
  });

  test("verb-scoped default outcome", async () => {
    const d = new MockDriver().setActionOutcome(false, "click");
    expect(await d.click("#x")).toBe(false);
    expect(await d.fill("#x", "v")).toBe(true); // other verbs unaffected
  });

  test("by-selector outcome is most specific (beats default + queue)", async () => {
    const d = new MockDriver()
      .setActionOutcome(true)
      .enqueueActionOutcome(true)
      .setOutcomeForSelector("#special", false);
    expect(await d.click("#special")).toBe(false);
    // array selector: any matching member triggers it
    expect(await d.click(["#a", "#special", "#b"])).toBe(false);
  });

  test("verb-scoped queue entry only matches its verb; unscoped matches any", async () => {
    // A click-scoped `false` must NOT be consumed by a non-click verb; an unscoped entry can.
    const d = new MockDriver()
      .setActionOutcome(true)
      .enqueueActionOutcome(false, "click") // only a click consumes this
      .enqueueActionOutcome(true); // unscoped: any verb consumes this
    expect(await d.fill("#x", "v")).toBe(true); // skips click-scoped, takes unscoped (true)
    expect(await d.click("#x")).toBe(false); // consumes the click-scoped entry
    expect(await d.hover("#y")).toBe(true); // queue empty → back to default (true)
  });

  test("queued outcomes consumed FIFO across matching verbs", async () => {
    const d = new MockDriver()
      .setActionOutcome(true)
      .enqueueActionOutcome(false)
      .enqueueActionOutcome(false);
    expect(await d.click("#a")).toBe(false); // first unscoped
    expect(await d.fill("#b", "v")).toBe(false); // second unscoped
    expect(await d.hover("#c")).toBe(true); // default
  });

  test("all eight action verbs are recorded with their args", async () => {
    const d = new MockDriver();
    await d.click("#c");
    await d.fill("#f", "val");
    await d.type("#t", "txt");
    await d.select("#s", "opt");
    await d.check("#ch");
    await d.hover("#h");
    await d.press("Enter");
    await d.submit("#form");
    expect(d.calls.map((c) => c.method)).toEqual([
      "click",
      "fill",
      "type",
      "select",
      "check",
      "hover",
      "press",
      "submit",
    ]);
    expect(d.callsTo("fill")[0]?.args).toEqual(["#f", "val", undefined]);
    expect(d.callsTo("press")[0]?.args[0]).toBe("Enter");
  });
});

describe("MockDriver — signatures + screenshots", () => {
  test("default signature; queued one-shots first", async () => {
    const d = new MockDriver().setSignature("u|def").enqueueSignature("u|a", "u|b");
    expect(await d.captureStateSignature()).toBe("u|a");
    expect(await d.captureStateSignature()).toBe("u|b");
    expect(await d.captureStateSignature()).toBe("u|def");
  });

  test("signature mismatch scenario (for L0 cache gate tests)", async () => {
    const d = new MockDriver()
      .enqueueSignature("http://x/page|locked-hash") // matches lock
      .enqueueSignature("http://x/page|DIFFERENT"); // mismatch → forces L1
    expect(await d.captureStateSignature()).toBe("http://x/page|locked-hash");
    expect(await d.captureStateSignature()).toBe("http://x/page|DIFFERENT");
  });

  test("screenshot default + queue", async () => {
    const d = new MockDriver().setScreenshot("DEFAULTB64").enqueueScreenshot("ONESHOT");
    expect(await d.screenshot()).toBe("ONESHOT");
    expect(await d.screenshot({ format: "jpeg" })).toBe("DEFAULTB64");
    expect(d.callsTo("screenshot")[1]?.args[0]).toEqual({ format: "jpeg" });
  });
});

describe("MockDriver — ref map round-trip", () => {
  test("importRefMap then exportRefMap returns a copy", () => {
    const d = new MockDriver();
    d.importRefMap({ e1: 100, e2: 200 });
    const out = d.exportRefMap();
    expect(out).toEqual({ e1: 100, e2: 200 });
    out.e1 = 999; // mutating the export must not affect internal state
    expect(d.exportRefMap().e1).toBe(100);
  });
});

describe("MockDriver — reset", () => {
  test("reset clears log/queues/providers but keeps defaults", async () => {
    const d = new MockDriver().setActionOutcome(false).enqueueSnapshot(makeSnapshot());
    await d.click("#x");
    d.reset();
    expect(d.calls).toHaveLength(0);
    // default kept:
    expect(await d.click("#y")).toBe(false);
    // queue cleared → falls straight to default snapshot:
    expect((await d.snapshot()).url).toBe("about:blank");
  });
});

describe("mock-fixtures — makeStepResult success inference", () => {
  test("success defaults to true when no failureReason", () => {
    expect(makeStepResult().success).toBe(true);
    expect(makeStepResult({ selectorUsed: "text:Go" }).success).toBe(true);
  });
  test("success inferred false when a failureReason is set", () => {
    expect(makeStepResult({ failureReason: "missing" }).success).toBe(false);
  });
});
