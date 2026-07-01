// Tests for the strategy-array builder (PLAN.md §4 priority / §8 risk #8). testid + label rungs
// are derived from the enriched snapshot's real DOM attributes (browser-pilot 0.1.0, Phase 7 3a).

import { describe, expect, test } from "bun:test";
import { makeInteractiveElement } from "../driver/index.ts";
import {
  buildHintCandidates,
  buildStrategyArray,
  durableSelectorForElement,
  labelSelectorForElement,
  scopedTextSelectorForElement,
  strategyForElement,
  structuralFingerprintForElement,
  testidSelectorForElement,
} from "./strategy-array.ts";

describe("buildStrategyArray — §4 priority order, ref-first", () => {
  test("interactive element (no attrs): ref first, then role_name, then scoped_text", () => {
    const el = makeInteractiveElement({ ref: "e1", role: "button", name: "Create order" });
    const arr = buildStrategyArray(el, "click");
    expect(arr.map((c) => c.selector)).toEqual([
      "ref:e1",
      "role:button:Create order",
      "text:Create order",
    ]);
    // ref entry is a short-circuit; durable strategies follow.
    expect(arr[1]?.strategy).toBe("role_name");
    expect(arr[2]?.strategy).toBe("scoped_text");
  });

  test("element with a data-testid attribute: testid rung sorts to the top (after ref)", () => {
    const el = makeInteractiveElement({
      ref: "e1",
      role: "button",
      name: "Create order",
      attributes: { "data-testid": "create-order" },
    });
    const arr = buildStrategyArray(el, "click");
    expect(arr.map((c) => c.selector)).toEqual([
      "ref:e1",
      "[data-testid='create-order']",
      "role:button:Create order",
      "text:Create order",
    ]);
    expect(arr[1]?.strategy).toBe("testid");
  });

  test("element with an aria-label attribute: label rung is present between role_name and scoped_text", () => {
    const el = makeInteractiveElement({
      ref: "e1",
      role: "textbox",
      name: "Email",
      attributes: { "aria-label": "Email address" },
    });
    const arr = buildStrategyArray(el, "fill");
    expect(arr.map((c) => c.selector)).toEqual([
      "ref:e1",
      "role:textbox:Email",
      "[aria-label='Email address']",
      "text:Email",
    ]);
    expect(arr[2]?.strategy).toBe("label");
  });

  test("non-interactive element: NO scoped_text rung (role guard, risk #8)", () => {
    const el = makeInteractiveElement({ ref: "e1", role: "code", name: "Create order" });
    const arr = buildStrategyArray(el, "click");
    expect(arr.some((c) => c.selector.startsWith("text:"))).toBe(false);
  });

  test("element with no name: role-only role_name rung", () => {
    const el = makeInteractiveElement({ ref: "e1", role: "button", name: "" });
    const arr = buildStrategyArray(el, "click");
    expect(arr.map((c) => c.selector)).toContain("role:button");
    expect(arr.some((c) => c.selector.startsWith("text:"))).toBe(false); // no name → no text:
  });
});

describe("testid derivation from enriched DOM attributes (Phase 7 Change 3a)", () => {
  test("testid IS derived from el.attributes['data-testid']", () => {
    const el = makeInteractiveElement({
      ref: "e1",
      role: "button",
      name: "Create order",
      attributes: { "data-testid": "create-order" },
    });
    expect(testidSelectorForElement(el)).toBe("[data-testid='create-order']");
    expect(strategyForElement(el)).toBe("testid");
  });

  test("data-test / data-qa are honored as testid sources (first present wins)", () => {
    const dataTest = makeInteractiveElement({
      ref: "e1",
      role: "button",
      name: "Save",
      attributes: { "data-test": "save-btn" },
    });
    expect(testidSelectorForElement(dataTest)).toBe("[data-testid='save-btn']");
    const dataQa = makeInteractiveElement({
      ref: "e2",
      role: "button",
      name: "Save",
      attributes: { "data-qa": "save-qa" },
    });
    expect(testidSelectorForElement(dataQa)).toBe("[data-testid='save-qa']");
  });

  test("no testid attribute → not derivable (falls to role_name); synthetic selector never consulted", () => {
    const el = makeInteractiveElement({ ref: "e1", role: "button", name: "Create order" });
    // selector defaults to `[data-backend-node-id="1"]` — must NOT be treated as a testid.
    expect(testidSelectorForElement(el)).toBeUndefined();
    expect(strategyForElement(el)).toBe("role_name");
  });

  test("testid IS available from an author hint shaped like a testid", () => {
    const cands = buildHintCandidates(["[data-testid='create-order']", "text:Create order"]);
    expect(cands[0]?.strategy).toBe("testid");
    expect(cands[1]?.strategy).toBe("scoped_text");
  });
});

describe("label derivation from enriched DOM attributes (Phase 7 Change 3a)", () => {
  test("aria-label → [aria-label=…] label selector", () => {
    const el = makeInteractiveElement({
      ref: "e1",
      role: "searchbox",
      name: "",
      attributes: { "aria-label": "Search products" },
    });
    expect(labelSelectorForElement(el)).toBe("[aria-label='Search products']");
  });

  test("placeholder is used as a label source when no aria-label is present", () => {
    const el = makeInteractiveElement({
      ref: "e1",
      role: "textbox",
      name: "",
      attributes: { placeholder: "you@example.com" },
    });
    expect(labelSelectorForElement(el)).toBe("[placeholder='you@example.com']");
  });

  test("no label attributes → undefined (never fabricated from the accessible name)", () => {
    const el = makeInteractiveElement({ ref: "e1", role: "textbox", name: "Email" });
    expect(labelSelectorForElement(el)).toBeUndefined();
  });
});

describe("durableSelectorForElement — never a ref, always derivable", () => {
  test("testid wins the durable selector when the element carries one", () => {
    const el = makeInteractiveElement({
      ref: "e1",
      role: "button",
      name: "Submit",
      attributes: { "data-testid": "submit" },
    });
    expect(durableSelectorForElement(el)).toBe("[data-testid='submit']");
    expect(strategyForElement(el)).toBe("testid");
  });

  test("derives role_name for a named interactive element with no testid", () => {
    const el = makeInteractiveElement({ ref: "e1", role: "button", name: "Submit" });
    const sel = durableSelectorForElement(el);
    expect(sel).toBe("role:button:Submit");
    expect(sel?.startsWith("ref:")).toBe(false);
  });

  test("falls back to structural fingerprint when nothing else is derivable", () => {
    // A roleless, nameless element forces the fingerprint fallback (no testid/role_name/label/text).
    const el = makeInteractiveElement({ ref: "e1", role: "", name: "" });
    const sel = durableSelectorForElement(el);
    expect(sel?.startsWith("fingerprint:")).toBe(true);
  });
});

describe("scopedTextSelectorForElement / structuralFingerprintForElement", () => {
  test("scoped_text requires both an interactive role and a name", () => {
    expect(
      scopedTextSelectorForElement(makeInteractiveElement({ ref: "e1", role: "button", name: "Go" })),
    ).toBe("text:Go");
    expect(
      scopedTextSelectorForElement(makeInteractiveElement({ ref: "e1", role: "button", name: "" })),
    ).toBeUndefined();
    expect(
      scopedTextSelectorForElement(makeInteractiveElement({ ref: "e1", role: "code", name: "Go" })),
    ).toBeUndefined();
  });

  test("structural fingerprint encodes role + name", () => {
    const fp = structuralFingerprintForElement(
      makeInteractiveElement({ ref: "e1", role: "button", name: "Go" }),
    );
    expect(fp).toBe("fingerprint:role=button;name=Go");
  });
});
