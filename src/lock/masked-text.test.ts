// Tests for the masked-text page-signature component (L0 cache-hit quality — Layer 1 + 2).
//
// The hard requirement: the composite signature MUST stay stable when the ONLY change is inside a
// masked/volatile region, and MUST change when a non-masked region changes. These build mock
// snapshots (no browser) and assert the masked-text hash directly, plus the composite behaviour
// via `capturePageSignature` + `signatureMatches`.

import { describe, expect, test } from "bun:test";
import type { SnapshotNode } from "../driver/index.ts";
import { MockDriver, makeSnapshot } from "../driver/index.ts";
import { capturePageSignature } from "../ladder/page-signature.ts";
import { computeMaskedTextHash } from "./masked-text.ts";
import { signatureMatches } from "./signature.ts";

const URL = "http://h/p";

function snap(tree: SnapshotNode[]) {
  return makeSnapshot({ url: URL, accessibilityTree: tree });
}

describe("computeMaskedTextHash — volatile-region masking (Layer 1)", () => {
  test("stable when only a dynamic-role (status/timer/…) region's text changes", () => {
    const before = snap([
      { role: "button", ref: "n1", name: "Save" },
      { role: "status", ref: "n2", name: "3 items in cart" },
    ]);
    const after = snap([
      { role: "button", ref: "n1", name: "Save" },
      { role: "status", ref: "n2", name: "4 items in cart" }, // live counter churned
    ]);
    expect(computeMaskedTextHash(after)).toBe(computeMaskedTextHash(before));
  });

  test.each([
    "alert",
    "log",
    "timer",
    "progressbar",
    "marquee",
  ])("masks the dynamic role %s", (role) => {
    const before = snap([{ role, ref: "n1", name: "one" }]);
    const after = snap([{ role, ref: "n1", name: "two" }]);
    expect(computeMaskedTextHash(after)).toBe(computeMaskedTextHash(before));
  });

  test("stable when an [aria-live] region's text changes", () => {
    const before = snap([
      { role: "generic", ref: "n0", name: "static" },
      { role: "generic", ref: "n1", name: "10:00:00", properties: { "aria-live": "polite" } },
    ]);
    const after = snap([
      { role: "generic", ref: "n0", name: "static" },
      { role: "generic", ref: "n1", name: "10:00:01", properties: { "aria-live": "polite" } },
    ]);
    expect(computeMaskedTextHash(after)).toBe(computeMaskedTextHash(before));
  });

  test("stable when a [data-live] region's text changes", () => {
    const before = snap([
      { role: "generic", ref: "n1", name: "42", properties: { "data-live": "" } },
    ]);
    const after = snap([
      { role: "generic", ref: "n1", name: "43", properties: { "data-live": "" } },
    ]);
    expect(computeMaskedTextHash(after)).toBe(computeMaskedTextHash(before));
  });

  test("stable when a hidden / aria-hidden subtree's text changes", () => {
    const before = snap([{ role: "generic", ref: "n1", name: "a", properties: { hidden: true } }]);
    const after = snap([{ role: "generic", ref: "n1", name: "b", properties: { hidden: true } }]);
    expect(computeMaskedTextHash(after)).toBe(computeMaskedTextHash(before));

    const b2 = snap([
      { role: "generic", ref: "n1", name: "a", properties: { "aria-hidden": "true" } },
    ]);
    const a2 = snap([
      { role: "generic", ref: "n1", name: "b", properties: { "aria-hidden": "true" } },
    ]);
    expect(computeMaskedTextHash(a2)).toBe(computeMaskedTextHash(b2));
  });

  test("aria-live='off' is NOT masked (an off live-region is normal content)", () => {
    const before = snap([
      { role: "generic", ref: "n1", name: "a", properties: { "aria-live": "off" } },
    ]);
    const after = snap([
      { role: "generic", ref: "n1", name: "b", properties: { "aria-live": "off" } },
    ]);
    expect(computeMaskedTextHash(after)).not.toBe(computeMaskedTextHash(before));
  });

  test("CHANGES when a NON-masked region's text changes", () => {
    const before = snap([{ role: "button", ref: "n1", name: "Save" }]);
    const after = snap([{ role: "button", ref: "n1", name: "Submit" }]);
    expect(computeMaskedTextHash(after)).not.toBe(computeMaskedTextHash(before));
  });

  test("masks the volatile region AND its whole subtree", () => {
    const before = snap([
      { role: "status", ref: "n1", children: [{ role: "generic", ref: "n2", name: "loading 1%" }] },
    ]);
    const after = snap([
      {
        role: "status",
        ref: "n1",
        children: [{ role: "generic", ref: "n2", name: "loading 99%" }],
      },
    ]);
    expect(computeMaskedTextHash(after)).toBe(computeMaskedTextHash(before));
  });
});

describe("computeMaskedTextHash — dynamic number/date/currency normalization (Item 3)", () => {
  test("stable when a PLAIN (non-live-region) counter changes", () => {
    // A bare `generic`/`text` node — NOT a masked live-region role — holding a live counter.
    const before = snap([{ role: "text", ref: "n1", name: "Cart total: 3 items" }]);
    const after = snap([{ role: "text", ref: "n1", name: "Cart total: 12 items" }]);
    expect(computeMaskedTextHash(after)).toBe(computeMaskedTextHash(before));
  });

  test.each([
    ["12:30:45", "09:05:01"], // clock
    ["$1,234.56", "$9.99"], // price
    ["2026-07-02", "2025-01-15"], // ISO date
    ["45%", "3%"], // percent
  ])("stable when a plain %s-shaped token churns", (a, b) => {
    const before = snap([{ role: "text", ref: "n1", name: `Value ${a}` }]);
    const after = snap([{ role: "text", ref: "n1", name: `Value ${b}` }]);
    expect(computeMaskedTextHash(after)).toBe(computeMaskedTextHash(before));
  });

  test("still CHANGES when the surrounding literal text changes", () => {
    const before = snap([{ role: "text", ref: "n1", name: "Cart total: 3 items" }]);
    const after = snap([{ role: "text", ref: "n1", name: "Wishlist total: 3 items" }]);
    expect(computeMaskedTextHash(after)).not.toBe(computeMaskedTextHash(before));
  });
});

describe("computeMaskedTextHash — ignore_regions (Layer 2)", () => {
  test("an ignore_regions selector excludes a subtree from the text hash", () => {
    // `.ticker` matches the node's class attribute → the region is pruned.
    // Use a NON-numeric text change so the difference isn't collapsed by dynamic-number
    // normalization (Item 3) — this test is about `ignore_regions` subtree exclusion, not numbers.
    const before = snap([
      { role: "button", ref: "n1", name: "Save" },
      { role: "generic", ref: "n2", name: "Acme headline", properties: { class: "ticker price" } },
    ]);
    const after = snap([
      { role: "button", ref: "n1", name: "Save" },
      {
        role: "generic",
        ref: "n2",
        name: "Globex headline",
        properties: { class: "ticker price" },
      },
    ]);
    const opts = { ignoreRegions: [".ticker"] };
    expect(computeMaskedTextHash(after, opts)).toBe(computeMaskedTextHash(before, opts));
    // Without the ignore_regions the two DO differ (proving the selector caused the exclusion).
    expect(computeMaskedTextHash(after)).not.toBe(computeMaskedTextHash(before));
  });

  test("matches a role/name/ref ignore selector too (no CSS on a11y nodes)", () => {
    const before = snap([{ role: "timerish", ref: "n1", name: "1" }]);
    const after = snap([{ role: "timerish", ref: "n1", name: "2" }]);
    const opts = { ignoreRegions: ["timerish"] }; // bare role match
    expect(computeMaskedTextHash(after, opts)).toBe(computeMaskedTextHash(before, opts));
  });
});

describe("composite signature (masked-text + struct) via capturePageSignature", () => {
  test("composite still MATCHES when only a masked region changed", async () => {
    const driver = new MockDriver().setStructureSignature("/p|SAME");
    const before = snap([
      { role: "button", ref: "n1", name: "Save" },
      { role: "status", ref: "n2", name: "count: 1" },
    ]);
    const after = snap([
      { role: "button", ref: "n1", name: "Save" },
      { role: "status", ref: "n2", name: "count: 2" },
    ]);
    const a = await capturePageSignature(driver, before);
    const b = await capturePageSignature(driver, after);
    expect(signatureMatches(a.sig, b.sig)).toBe(true);
  });

  test("composite does NOT match when a non-masked region changed", async () => {
    const driver = new MockDriver().setStructureSignature("/p|SAME");
    const before = snap([{ role: "button", ref: "n1", name: "Save" }]);
    const after = snap([{ role: "button", ref: "n1", name: "Delete" }]);
    const a = await capturePageSignature(driver, before);
    const b = await capturePageSignature(driver, after);
    expect(signatureMatches(a.sig, b.sig)).toBe(false);
  });
});
