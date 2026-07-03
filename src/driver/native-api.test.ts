// Tests for the Phase 7 native-backed driver capabilities on the MockDriver seam:
//  - snapshot `attributes` policy (Change 3a),
//  - `resolveAll` ranked candidates (Change 3),
//  - `captureStateSignature({ mode: 'structure' })` (Change 4).
// These lock in the MockDriver parity that lets ladder/lock tests exercise the new APIs
// without a real browser. The real `BrowserPilotDriver` delegates the same shapes to
// browser-pilot 0.1.0's native APIs (covered by the boundary types + compile-time guards).

import { describe, expect, test } from "bun:test";
import { MockDriver } from "./mock-driver.ts";
import { makeInteractiveElement, makeRankedCandidate, makeSnapshot } from "./mock-fixtures.ts";

describe("MockDriver — snapshot attributes policy (Change 3a)", () => {
  const withAttrs = makeSnapshot({
    interactiveElements: [
      makeInteractiveElement({
        ref: "e1",
        role: "button",
        name: "Save",
        attributes: { "data-testid": "save-btn", id: "save" },
      }),
    ],
  });

  test("returns attributes only when snapshot({ attributes: true }) is requested", async () => {
    const d = new MockDriver().setSnapshot(withAttrs);
    const enriched = await d.snapshot({ attributes: true });
    expect(enriched.interactiveElements[0]?.attributes).toEqual({
      "data-testid": "save-btn",
      id: "save",
    });
  });

  test("strips attributes when not requested (mirrors the lean real-driver default)", async () => {
    const d = new MockDriver().setSnapshot(withAttrs);
    const lean = await d.snapshot();
    expect(lean.interactiveElements[0]?.attributes).toBeUndefined();
    // role/name/selector still present — only the opt-in attributes are dropped.
    expect(lean.interactiveElements[0]?.role).toBe("button");
    expect(lean.interactiveElements[0]?.name).toBe("Save");
  });

  test("preserves object identity when no element carries attributes", async () => {
    const plain = makeSnapshot({
      interactiveElements: [makeInteractiveElement({ ref: "e1", role: "link", name: "Home" })],
    });
    const d = new MockDriver().setSnapshot(plain);
    expect(await d.snapshot()).toBe(plain);
  });

  test("records the snapshot call with its opts", async () => {
    const d = new MockDriver().setSnapshot(withAttrs);
    await d.snapshot({ attributes: true });
    expect(d.callsTo("snapshot")).toHaveLength(1);
    expect(d.callsTo("snapshot")[0]?.args[0]).toEqual({ attributes: true });
  });
});

describe("MockDriver — resolveAll (Change 3)", () => {
  const c1 = makeRankedCandidate({ role: "button", name: "Save", score: 0.9 });
  const c2 = makeRankedCandidate({ role: "button", name: "Submit", score: 0.7 });

  test("returns the default list and records intent + opts", async () => {
    const d = new MockDriver().setResolveAll([c1, c2]);
    const out = await d.resolveAll("save the form", { action: "click", limit: 5 });
    expect(out).toEqual([c1, c2]);
    expect(d.callsTo("resolveAll")).toHaveLength(1);
    expect(d.lastCall?.args).toEqual(["save the form", { action: "click", limit: 5 }]);
  });

  test("defaults to an empty list when nothing is configured", async () => {
    const d = new MockDriver();
    expect(await d.resolveAll("anything")).toEqual([]);
  });

  test("consumes queued results FIFO before the default", async () => {
    const d = new MockDriver().setResolveAll([c2]).enqueueResolveAll([c1]);
    expect(await d.resolveAll("x")).toEqual([c1]); // queued
    expect(await d.resolveAll("x")).toEqual([c2]); // default
  });

  test("onResolveAll provider takes precedence and sees intent/opts", async () => {
    const d = new MockDriver().setResolveAll([c1]).enqueueResolveAll([c2]);
    d.onResolveAll((intent) => (intent === "pick save" ? [c1] : []));
    expect(await d.resolveAll("pick save")).toEqual([c1]);
    expect(await d.resolveAll("other")).toEqual([]);
  });
});

describe("MockDriver — structure-signature mode (Change 4)", () => {
  test("mode:'structure' draws from the structure default; text is unaffected", async () => {
    const d = new MockDriver().setSignature("http://x|text").setStructureSignature("x|struct");
    expect(await d.captureStateSignature()).toBe("http://x|text");
    expect(await d.captureStateSignature({ mode: "text" })).toBe("http://x|text");
    expect(await d.captureStateSignature({ mode: "structure" })).toBe("x|struct");
  });

  test("structure and text queues are independent FIFO channels", async () => {
    const d = new MockDriver().enqueueSignature("t1", "t2").enqueueStructureSignature("s1", "s2");
    expect(await d.captureStateSignature({ mode: "structure" })).toBe("s1");
    expect(await d.captureStateSignature()).toBe("t1");
    expect(await d.captureStateSignature({ mode: "structure" })).toBe("s2");
    expect(await d.captureStateSignature()).toBe("t2");
  });

  test("records the mode in the call log", async () => {
    const d = new MockDriver();
    await d.captureStateSignature({ mode: "structure" });
    expect(d.callsTo("captureStateSignature")[0]?.args[0]).toEqual({ mode: "structure" });
  });
});

describe("MockDriver — clearBrowserState (cross-agent isolation seam)", () => {
  test("is a recorded no-op (never throws)", async () => {
    const d = new MockDriver();
    await d.clearBrowserState();
    expect(d.callsTo("clearBrowserState")).toHaveLength(1);
  });
});
