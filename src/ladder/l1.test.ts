// Tests for L1 — the deterministic strategy ladder (PLAN.md §5 Phase 2 / §4 mapping).
//
// All against MockDriver — no Chrome, no network. Candidate RANKING is the driver's native
// `resolveAll` (driven via `setResolveAll`); we script `batch` to return a StepResult with a chosen
// `selectorUsed` (or a failure) and assert the learned `Strategy`, the durable selector, the
// single-snapshot discipline, the role-verification guard, and the L2 handoff.

import { describe, expect, test } from "bun:test";
import {
  MockDriver,
  makeBatchResult,
  makeFailureBatch,
  makeInteractiveElement,
  makeRankedCandidate,
  makeSnapshot,
  makeStepResult,
  makeSuccessBatch,
} from "../driver/index.ts";
import type { ClickStep, Step } from "../flow/types.ts";
import { actionVerbForStep, resolveL1 } from "./l1.ts";
import type { ResolveContext } from "./types.ts";

function ctxFor(driver: MockDriver): ResolveContext {
  return { driver, now: () => 0 };
}

const clickStep = (over: Partial<ClickStep> = {}): Step => ({
  id: "s1",
  do: "click",
  target: "Create order",
  ...over,
});

describe("actionVerbForStep", () => {
  test("maps targeting steps; non-targeting → undefined", () => {
    expect(actionVerbForStep({ id: "a", do: "click" })).toBe("click");
    expect(actionVerbForStep({ id: "a", do: "fill", value: "x" })).toBe("fill");
    expect(actionVerbForStep({ id: "a", do: "select", value: "x" })).toBe("select");
    expect(actionVerbForStep({ id: "a", do: "ai_pick" })).toBe("click");
    expect(actionVerbForStep({ id: "a", do: "goto", url: "/" })).toBeUndefined();
    expect(actionVerbForStep({ id: "a", do: "wait", ms: 1 })).toBeUndefined();
  });
});

describe("L1 — single snapshot discipline", () => {
  test("takes EXACTLY one snapshot per resolution attempt", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "button", name: "Create order" }),
        ],
      }),
    );
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Create order" })]);
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));

    await resolveL1(clickStep(), ctxFor(d));
    expect(d.callsTo("snapshot")).toHaveLength(1);
    expect(d.callsTo("batch")).toHaveLength(1);
  });

  test("REUSES a shared snapshot when one is threaded in (no snapshot of its own)", async () => {
    const d = new MockDriver();
    const shared = makeSnapshot({
      interactiveElements: [
        makeInteractiveElement({ ref: "e1", role: "button", name: "Create order" }),
      ],
    });
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Create order" })]);
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));

    const r = await resolveL1(clickStep(), ctxFor(d), {}, shared);
    expect(r.ok).toBe(true);
    expect(d.callsTo("snapshot")).toHaveLength(0); // reused the shared snapshot
    // resolveAll was asked to rank against that same snapshot.
    expect(d.callsTo("resolveAll")).toHaveLength(1);
  });
});

describe("L1 — §4 mapping: each winning selectorUsed → correct Strategy", () => {
  async function resolveWithWinner(selectorUsed: string) {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "button", name: "Create order" }),
        ],
      }),
    );
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Create order" })]);
    d.setBatchResult(makeSuccessBatch(selectorUsed));
    return resolveL1(clickStep({ target: ["[data-testid='create-order']"] }), ctxFor(d));
  }

  test("testid winner → strategy 'testid', durable = the testid selector", async () => {
    const r = await resolveWithWinner("[data-testid='create-order']");
    expect(r.ok).toBe(true);
    expect(r.tier).toBe("L1");
    expect(r.strategy).toBe("testid");
    expect(r.durableSelector).toBe("[data-testid='create-order']");
    expect(r.escalate).toBe(false);
  });

  test("role/name winner → strategy 'role_name'", async () => {
    const r = await resolveWithWinner("role:button:Create order");
    expect(r.strategy).toBe("role_name");
    expect(r.durableSelector).toBe("role:button:Create order");
  });

  test("label winner → strategy 'label'", async () => {
    const r = await resolveWithWinner("[aria-label='Create order']");
    expect(r.strategy).toBe("label");
    expect(r.durableSelector).toBe("[aria-label='Create order']");
  });

  test("scoped_text winner → strategy 'scoped_text'", async () => {
    const r = await resolveWithWinner("text:Create order");
    expect(r.strategy).toBe("scoped_text");
    expect(r.durableSelector).toBe("text:Create order");
  });

  test("structural_fingerprint winner → strategy 'structural_fingerprint'", async () => {
    const r = await resolveWithWinner("fingerprint:role=button;name=Create order");
    expect(r.strategy).toBe("structural_fingerprint");
  });
});

describe("L1 — durableSelector is NEVER ref:eN", () => {
  test("when bp returns only a ref, re-derive a stable selector from the matched element", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e7", role: "button", name: "Submit order" }),
        ],
      }),
    );
    d.setResolveAll([makeRankedCandidate({ ref: "e7", role: "button", name: "Submit order" })]);
    // bp resolved ref-first (refs preempt position — FINDINGS §4): selectorUsed is a bare ref.
    d.setBatchResult(makeSuccessBatch("ref:e7"));

    const r = await resolveL1(clickStep({ target: "Submit order" }), ctxFor(d));
    expect(r.ok).toBe(true);
    expect(r.selectorUsed).toBe("ref:e7");
    // strategy mapped from ref is null at the driver level, but we re-derive from the element:
    expect(r.strategy).toBe("role_name");
    expect(r.durableSelector).toBe("role:button:Submit order");
    expect(r.durableSelector?.startsWith("ref:")).toBe(false);
  });

  test("a data-testid on the matched element becomes the durable selector (re-derived from a ref)", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({
            ref: "e7",
            role: "button",
            name: "Submit order",
            attributes: { "data-testid": "submit-order" },
          }),
        ],
      }),
    );
    d.setResolveAll([makeRankedCandidate({ ref: "e7", role: "button", name: "Submit order" })]);
    d.setBatchResult(makeSuccessBatch("ref:e7"));

    const r = await resolveL1(clickStep({ target: "Submit order" }), ctxFor(d));
    expect(r.strategy).toBe("testid");
    expect(r.durableSelector).toBe("[data-testid='submit-order']");
    // the testid rung was offered ahead of role_name in the batch array.
    const sent =
      (d.callsTo("batch")[0]!.args[0] as Array<{ selector: string[] }>)[0]?.selector ?? [];
    expect(sent).toEqual([
      "ref:e7",
      "[data-testid='submit-order']",
      "role:button:Submit order",
      "text:Submit order",
    ]);
  });
});

describe("L1 — role verification for scoped_text (risk #8)", () => {
  test("scoped_text is NOT emitted for a non-interactive element (no <code> false positive)", async () => {
    const d = new MockDriver();
    // The name "Create order" belongs to a non-interactive `code` block — the documented false
    // positive. Native ranking returns only the interactive candidate ("New order" button), and the
    // ladder must NOT build a text: selector for the code element.
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "code", name: "Create order" }),
          makeInteractiveElement({ ref: "e2", role: "button", name: "New order" }),
        ],
      }),
    );
    d.setResolveAll([
      makeRankedCandidate({ ref: "e2", role: "button", name: "New order", score: 0.5 }),
    ]);
    d.setBatchResult(makeBatchResult([makeStepResult({ success: true })]));

    const r = await resolveL1(clickStep({ target: "Create order" }), ctxFor(d));
    // The selectors we send must NOT contain a text: selector for the code element.
    const batchCall = d.callsTo("batch")[0];
    const sentStep = (batchCall!.args[0] as Array<{ selector: string[] }>)[0];
    const sentSelectors = sentStep?.selector ?? [];
    expect(sentSelectors.some((s) => s === "text:Create order")).toBe(false);
    // And no candidate should be the code element.
    expect(r.candidates?.some((c) => c.role === "code")).toBe(false);
  });

  test("scoped_text IS available for an interactive element with a matching name", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "button", name: "Create order" }),
        ],
      }),
    );
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Create order" })]);
    // Force the text: rung to win to prove it was offered.
    d.setBatchResult(makeSuccessBatch("text:Create order"));
    const r = await resolveL1(clickStep({ target: "Create order" }), ctxFor(d));
    const sent =
      (d.callsTo("batch")[0]!.args[0] as Array<{ selector: string[] }>)[0]?.selector ?? [];
    expect(sent).toContain("text:Create order");
    expect(r.strategy).toBe("scoped_text");
  });
});

describe("L1 — escalation + L2 handoff", () => {
  test("batch fails with failureReason=covered → escalate:true with handoff carrying signals", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "button", name: "Accept cookies" }),
          makeInteractiveElement({ ref: "e2", role: "button", name: "Create order" }),
        ],
      }),
    );
    d.setResolveAll([
      makeRankedCandidate({ ref: "e2", role: "button", name: "Create order" }),
      makeRankedCandidate({ ref: "e1", role: "button", name: "Accept cookies", score: 0.5 }),
    ]);
    d.setBatchResult(
      makeFailureBatch("covered", {
        coveringElement: { tag: "div", className: "fixture-cookie-banner" },
      }),
    );

    const r = await resolveL1(clickStep({ target: "Create order" }), ctxFor(d));
    expect(r.ok).toBe(false);
    expect(r.escalate).toBe(true);
    expect(r.failureReason).toBe("covered");
    expect(r.coveringElement?.className).toBe("fixture-cookie-banner");
    expect(r.handoff).toBeDefined();
    expect(r.handoff?.action).toBe("click");
    expect(r.handoff?.failureReason).toBe("covered");
    expect(r.handoff?.coveringElement?.className).toBe("fixture-cookie-banner");
    expect(r.handoff?.intent).toBe("Create order");
    // top matches are ranked, best-first, and include the matching button.
    expect(r.handoff?.topMatches.length).toBeGreaterThan(0);
    expect(r.handoff?.topMatches[0]?.name).toBe("Create order");
  });

  test("ambiguous match (two close candidates) → escalate even when the action 'succeeded'", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "button", name: "Continue" }),
          makeInteractiveElement({ ref: "e2", role: "button", name: "Continue" }),
        ],
      }),
    );
    d.setResolveAll([
      makeRankedCandidate({ ref: "e1", role: "button", name: "Continue" }),
      makeRankedCandidate({ ref: "e2", role: "button", name: "Continue" }),
    ]);
    d.setBatchResult(makeSuccessBatch("role:button:Continue"));

    const r = await resolveL1(clickStep({ target: "Continue" }), ctxFor(d));
    expect(r.escalate).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.handoff?.topMatches.length).toBeGreaterThanOrEqual(2);
  });

  test("no interactive match at all → escalate with a ranked (possibly empty) handoff", async () => {
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    // resolveAll returns [] by default → no target, no hints → escalate before any batch.
    const r = await resolveL1(clickStep({ target: "Nonexistent" }), ctxFor(d));
    expect(r.ok).toBe(false);
    expect(r.escalate).toBe(true);
    expect(r.handoff).toBeDefined();
    // We never even called batch (no candidates to try).
    expect(d.callsTo("batch")).toHaveLength(0);
  });
});

describe("L1 — fill carries its value into the batch step", () => {
  test("fill step sends value alongside the selector array", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "textbox", name: "First name" }),
        ],
      }),
    );
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "textbox", name: "First name" })]);
    d.setBatchResult(makeSuccessBatch("role:textbox:First name", "fill"));

    const step: Step = { id: "s1", do: "fill", target: "First name", value: "Ada" };
    const r = await resolveL1(step, ctxFor(d));
    expect(r.ok).toBe(true);
    const sent = d.callsTo("batch")[0]?.args[0] as Array<{ action: string; value?: string }>;
    expect(sent[0]?.action).toBe("fill");
    expect(sent[0]?.value).toBe("Ada");
  });
});

describe("L1 — iframe mis-resolution guard", () => {
  // The /contexts benchmark trap: a testid hint whose only match lives inside a same-origin iframe
  // (not pierced by the AX snapshot), with a look-alike parent button ranked for the NL intent. The
  // guard must FAIL HARD (naming the hint) instead of silently clicking the look-alike.
  function iframeTrapDriver(): MockDriver {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          // The look-alike parent — NOT the iframe submit button, but ranks for the NL intent.
          makeInteractiveElement({ ref: "e6", role: "button", name: "Fill Iframe Form" }),
        ],
      }),
    );
    d.setResolveAll([makeRankedCandidate({ ref: "e6", role: "button", name: "Fill Iframe Form" })]);
    // If the guard failed to fire, the batch would "succeed" on the look-alike (silent false positive).
    d.setBatchResult(makeSuccessBatch("role:button:Fill Iframe Form"));
    return d;
  }

  const iframeStep = (): Step => ({
    id: "submit_iframe",
    do: "click",
    target: ["[data-testid='iframe-submit']", "the Submit button inside the iframe form"],
  });

  test("iframe-only hint + look-alike fallback → fails hard, does NOT act", async () => {
    const d = iframeTrapDriver();
    d.setSelectorFrame("[data-testid='iframe-submit']", "iframe");

    const r = await resolveL1(iframeStep(), ctxFor(d));

    expect(r.ok).toBe(false);
    expect(r.escalate).toBe(false);
    expect(r.error).toContain("[data-testid='iframe-submit']");
    expect(r.error).toContain("only inside an iframe");
    expect(r.error).toContain("mis-resolve");
    // The guard fired BEFORE the batch — no silent click on the look-alike parent.
    expect(d.callsTo("batch")).toHaveLength(0);
    expect(d.callsTo("locateSelectorFrame")).toHaveLength(1);
  });

  test("no iframe-capable driver (feature-detect absent) → unchanged behaviour, acts as before", async () => {
    const d = iframeTrapDriver(); // never calls setSelectorFrame → method not installed
    const r = await resolveL1(iframeStep(), ctxFor(d));
    // Without the probe the legacy path runs: it acts (and, as before, may mis-resolve) — proving the
    // guard is purely additive and off unless the driver exposes locateSelectorFrame.
    expect(d.callsTo("batch")).toHaveLength(1);
    expect(r.ok).toBe(true);
  });

  test("iframe-only hint with NO fallback → not-found error still names the hint", async () => {
    const d = new MockDriver();
    // Empty snapshot: nothing ranks, so no fallback target is picked.
    d.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    d.setResolveAll([]);
    d.setSelectorFrame("[data-testid='iframe-submit']", "iframe");

    const r = await resolveL1(iframeStep(), ctxFor(d));

    expect(r.ok).toBe(false);
    expect(r.escalate).toBe(false);
    expect(r.error).toContain("[data-testid='iframe-submit']");
    expect(r.error).toContain("only inside an iframe");
    expect(d.callsTo("batch")).toHaveLength(0);
  });

  test("hint IS present in the snapshot → no probe, happy path acts", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({
            ref: "e1",
            role: "button",
            name: "Submit",
            attributes: { "data-testid": "iframe-submit" },
          }),
        ],
      }),
    );
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Submit" })]);
    d.setBatchResult(makeSuccessBatch("[data-testid='iframe-submit']"));
    // Method installed, but the hint matches the snapshot → guard must NOT probe it.
    d.setSelectorFrame("[data-testid='iframe-submit']", "iframe");

    const r = await resolveL1(iframeStep(), ctxFor(d));

    expect(r.ok).toBe(true);
    expect(d.callsTo("locateSelectorFrame")).toHaveLength(0);
    expect(d.callsTo("batch")).toHaveLength(1);
  });

  test("driver reports 'main' (hint absent from snapshot but in main doc) → no failure", async () => {
    const d = iframeTrapDriver();
    d.setSelectorFrame("[data-testid='iframe-submit']", "main");
    const r = await resolveL1(iframeStep(), ctxFor(d));
    // Probed (zero snapshot matches) but NOT iframe-bound → legacy path proceeds and acts.
    expect(d.callsTo("locateSelectorFrame")).toHaveLength(1);
    expect(d.callsTo("batch")).toHaveLength(1);
    expect(r.ok).toBe(true);
  });
});
