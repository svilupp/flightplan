import { describe, expect, test } from "bun:test";
import { normalizeSelector, normalizeSelectorArg } from "./normalize-selector.ts";

describe("normalizeSelector", () => {
  test("strips a leading css: prefix, leaving raw CSS", () => {
    expect(normalizeSelector("css:button")).toBe("button");
    expect(normalizeSelector("css:#duplicate")).toBe("#duplicate");
    expect(normalizeSelector("css:a[data-primary-link][href*='/orders/']")).toBe(
      "a[data-primary-link][href*='/orders/']",
    );
  });

  test("css: strip is case-insensitive and trims surrounding whitespace", () => {
    expect(normalizeSelector("CSS: .card ")).toBe(".card");
    expect(normalizeSelector("  css:tr")).toBe("tr");
  });

  test("does NOT translate a bracket inside a css: selector (remainder is raw CSS)", () => {
    // After stripping css:, the rest is a plain attribute selector, not a role bracket form.
    expect(normalizeSelector('css:[role="button"]')).toBe('[role="button"]');
  });

  test("preserves browser-pilot native role bracket syntax", () => {
    expect(normalizeSelector('role:button[name="More actions"]')).toBe(
      'role:button[name="More actions"]',
    );
    expect(normalizeSelector("role:link[name='GAL-2033']")).toBe("role:link[name='GAL-2033']");
    expect(normalizeSelector("role:menuitem[name=Duplicate]")).toBe(
      "role:menuitem[name=Duplicate]",
    );
  });

  test("preserves a native role bracket name plus positional index", () => {
    expect(normalizeSelector('role:button[name="Mark as fulfilled"][2]')).toBe(
      'role:button[name="Mark as fulfilled"][2]',
    );
  });

  test("leaves canonical role:<role>:<name> selectors unchanged (idempotent)", () => {
    expect(normalizeSelector("role:button:More actions")).toBe("role:button:More actions");
    expect(normalizeSelector("role:link:GAL-2032")).toBe("role:link:GAL-2032");
  });

  test("leaves text:, ref:, and plain selectors unchanged", () => {
    expect(normalizeSelector("text:Duplicate")).toBe("text:Duplicate");
    expect(normalizeSelector("ref:e12")).toBe("ref:e12");
    expect(normalizeSelector("#collect-payment-button")).toBe("#collect-payment-button");
    expect(normalizeSelector("a[data-primary-link]")).toBe("a[data-primary-link]");
  });

  test("does not touch a positional role selector without a name bracket", () => {
    expect(normalizeSelector("role:button[2]")).toBe("role:button[2]");
  });
});

describe("normalizeSelectorArg", () => {
  test("normalizes a single string, preserving string shape", () => {
    expect(normalizeSelectorArg("css:#duplicate")).toBe("#duplicate");
  });

  test("normalizes every entry of a fallback list, preserving order and array shape", () => {
    expect(
      normalizeSelectorArg(["css:#duplicate", 'role:button[name="Duplicate"]', "text:Duplicate"]),
    ).toEqual(["#duplicate", 'role:button[name="Duplicate"]', "text:Duplicate"]);
  });

  test("empty string passes through unchanged (ambient-form submit)", () => {
    expect(normalizeSelectorArg("")).toBe("");
  });
});
