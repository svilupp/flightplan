// Tests for the unified `target` locator-list normalization (PLAN_v002 §1/§2):
// `classifyLocator` (deterministic prefix whitelist, every prefix + NL fallthrough) and
// `normalizeTarget`/`describeTarget` (the fold into `{ selectors, nl }`).

import { describe, expect, test } from "bun:test";
import { classifyLocator, describeTarget, normalizeTarget } from "./normalize-target.ts";

describe("classifyLocator", () => {
  test("ref: prefix classifies as ref", () => {
    expect(classifyLocator("ref:e12")).toBe("ref");
  });

  test("role: prefix classifies as role", () => {
    expect(classifyLocator("role:button:Next")).toBe("role");
  });

  test("text: prefix classifies as text", () => {
    expect(classifyLocator('text:"Next"')).toBe("text");
  });

  test("css: prefix classifies as css", () => {
    expect(classifyLocator("css:button.primary")).toBe("css");
  });

  test("CSS: prefix classifies case-insensitively", () => {
    expect(classifyLocator("CSS:button.primary")).toBe("css");
  });

  test("special prefixes remain lowercase-only", () => {
    expect(classifyLocator("ROLE:button:Next")).toBe("nl");
    expect(classifyLocator("TEXT:Next")).toBe("nl");
    expect(classifyLocator("REF:e1")).toBe("nl");
  });

  test("leading [ classifies as css (attribute selector)", () => {
    expect(classifyLocator("[data-testid='x']")).toBe("css");
  });

  test("leading whitespace before a prefix is still recognized", () => {
    expect(classifyLocator("  role:button:Next")).toBe("role");
  });

  // Everything else is natural language, PERIOD — no shape heuristics (v002-2).
  test("bare prose falls through to nl", () => {
    expect(classifyLocator("the Next button")).toBe("nl");
  });

  test("prose starting with a dot is nl, not misread as a CSS class", () => {
    expect(classifyLocator(".NET downloads")).toBe("nl");
  });

  test("prose containing a CSS-like combinator is nl", () => {
    expect(classifyLocator("Products > Shoes")).toBe("nl");
  });

  test("bare CSS without a prefix and without a leading [ is nl (must use css:)", () => {
    expect(classifyLocator("button.primary")).toBe("nl");
  });

  test("empty string is nl", () => {
    expect(classifyLocator("")).toBe("nl");
  });
});

describe("normalizeTarget", () => {
  test("undefined target folds to no selectors, no nl", () => {
    expect(normalizeTarget(undefined)).toEqual({ selectors: [] });
  });

  test("a single NL string folds to one nl entry, no selectors", () => {
    expect(normalizeTarget("the trash-can icon")).toEqual({
      selectors: [],
      nl: "the trash-can icon",
    });
  });

  test("a single selector string folds to one selector, no nl", () => {
    expect(normalizeTarget("[data-testid='x']")).toEqual({ selectors: ["[data-testid='x']"] });
  });

  test("selectors-first-NL-last list: selectors keep author order, nl is the last entry", () => {
    const out = normalizeTarget([
      "[data-testid='wizard-next-1']",
      "role:button:Next",
      "the Next button",
    ]);
    expect(out.selectors).toEqual(["[data-testid='wizard-next-1']", "role:button:Next"]);
    expect(out.nl).toBe("the Next button");
  });

  test("css: prefix is stripped from the selector fed to the driver", () => {
    const out = normalizeTarget(["css:button.primary", "the primary button"]);
    expect(out.selectors).toEqual(["button.primary"]);
    expect(out.nl).toBe("the primary button");
  });

  test("CSS: prefix is stripped case-insensitively", () => {
    expect(normalizeTarget("CSS:button.primary")).toEqual({ selectors: ["button.primary"] });
  });

  test("multiple nl entries are joined as context", () => {
    const out = normalizeTarget(["the row", "for the cheapest plan"]);
    expect(out.selectors).toEqual([]);
    expect(out.nl).toBe("the row; for the cheapest plan");
  });

  test("entries are trimmed and empty entries are skipped", () => {
    const out = normalizeTarget(["  [data-testid='x']  ", "  ", "the button  "]);
    expect(out.selectors).toEqual(["[data-testid='x']"]);
    expect(out.nl).toBe("the button");
  });

  test("selector-only list (no nl) has no nl key", () => {
    const out = normalizeTarget(["[data-testid='x']", "role:button:Next"]);
    expect(out.nl).toBeUndefined();
  });
});

describe("describeTarget", () => {
  test("prefers the nl entry when present", () => {
    expect(describeTarget(["[data-testid='x']", "the Next button"])).toBe("the Next button");
  });

  test("falls back to the first selector when there is no nl entry", () => {
    expect(describeTarget(["[data-testid='x']", "role:button:Next"])).toBe("[data-testid='x']");
  });

  test("undefined target describes as undefined", () => {
    expect(describeTarget(undefined)).toBeUndefined();
  });
});
