// Tests for lock page signatures (PLAN.md §4 / §5 Phase 3 / §8 risk #1).
//
// The composite `match.sig` = text component (`captureStateSignature()`) + structure component
// (`captureStateSignature({ mode: 'structure' })`, browser-pilot native). These verify: the
// composite round-trips through split; both components must match (with legacy text-only
// degradation); the anchored url glob; the write-time url_glob derivation; and that
// `capturePageSignature` composes the driver's two signatures around the snapshot URL.

import { describe, expect, test } from "bun:test";
import { MockDriver, makeSnapshot } from "../driver/index.ts";
import { capturePageSignature } from "../ladder/page-signature.ts";
import { computeMaskedTextHash } from "./masked-text.ts";
import {
  computeMatchSignature,
  deriveUrlGlob,
  signatureMatches,
  splitMatchSignature,
  urlGlobMatches,
} from "./signature.ts";

describe("computeMatchSignature / splitMatchSignature", () => {
  test("composes text + struct and round-trips", () => {
    const sig = computeMatchSignature("http://h/p|aaa", "/p|bbb");
    expect(sig).toBe("text:http://h/p|aaa;struct:/p|bbb");
    expect(splitMatchSignature(sig)).toEqual({ text: "http://h/p|aaa", struct: "/p|bbb" });
  });

  test("a legacy bare value parses as text-only", () => {
    expect(splitMatchSignature("http://h/p|aaa")).toEqual({ text: "http://h/p|aaa" });
  });
});

describe("signatureMatches", () => {
  const a = computeMatchSignature("http://h/p|TEXT", "/p|STRUCT");

  test("identical composite → match", () => {
    expect(signatureMatches(a, a)).toBe(true);
  });

  test("text differs → mismatch (content changed)", () => {
    const b = computeMatchSignature("http://h/p|OTHER", "/p|STRUCT");
    expect(signatureMatches(a, b)).toBe(false);
  });

  test("structure differs → mismatch (layout changed)", () => {
    const b = computeMatchSignature("http://h/p|TEXT", "/p|DIFFERENT");
    expect(signatureMatches(a, b)).toBe(false);
  });

  test("legacy text-only on one side → degrades to text equality", () => {
    expect(signatureMatches("http://h/p|TEXT", a)).toBe(true);
    expect(signatureMatches("http://h/p|NOPE", a)).toBe(false);
  });

  describe("struct-only mode (Layer 2 [cache] signature = 'struct-only')", () => {
    test("matches despite a text diff when the struct component is unchanged", () => {
      const textDrift = computeMatchSignature("http://h/p|CHANGED", "/p|STRUCT");
      expect(signatureMatches(a, textDrift, "struct-only")).toBe(true);
      // ...whereas full mode would NOT match (the text component drifted).
      expect(signatureMatches(a, textDrift, "full")).toBe(false);
    });

    test("still mismatches when the struct component itself changes", () => {
      const structDrift = computeMatchSignature("http://h/p|TEXT", "/p|DIFFERENT");
      expect(signatureMatches(a, structDrift, "struct-only")).toBe(false);
    });

    test("falls back to text equality when a side has no struct component (legacy sig)", () => {
      expect(signatureMatches("http://h/p|TEXT", a, "struct-only")).toBe(true);
      expect(signatureMatches("http://h/p|NOPE", a, "struct-only")).toBe(false);
    });
  });
});

describe("urlGlobMatches", () => {
  test("anchored glob with * wildcard", () => {
    expect(urlGlobMatches("http://h/wizard*", "http://h/wizard?x=1")).toBe(true);
    expect(urlGlobMatches("http://h/wizard*", "http://h/wizard")).toBe(true);
    expect(urlGlobMatches("http://h/wizard*", "http://h/other")).toBe(false);
    expect(urlGlobMatches("/a*", "/abc")).toBe(true);
  });
});

describe("deriveUrlGlob", () => {
  test("keeps origin+path, wildcards the query/fragment", () => {
    expect(deriveUrlGlob("http://localhost:3000/drift?variant=b")).toBe(
      "http://localhost:3000/drift*",
    );
    expect(deriveUrlGlob("http://localhost:3000/wizard")).toBe("http://localhost:3000/wizard*");
    expect(deriveUrlGlob("/local/path#frag")).toBe("/local/path*");
  });

  test("the derived glob matches the page it was derived from", () => {
    const url = "http://localhost:3000/drift?variant=a";
    expect(urlGlobMatches(deriveUrlGlob(url), url)).toBe(true);
    // and a sibling variant of the same path
    expect(urlGlobMatches(deriveUrlGlob(url), "http://localhost:3000/drift?variant=c")).toBe(true);
  });
});

describe("capturePageSignature", () => {
  test("composes the snapshot masked-text hash + the driver's structure sig, returns the URL", async () => {
    const struct = "/p|STRUCTHASH";
    // Layer 1: the TEXT component is now computed INSIDE flightplan from the snapshot's a11y tree
    // (masked), NOT the driver's raw text signature. Only the struct component comes from the driver.
    const driver = new MockDriver().setSignature("IGNORED|texthash").setStructureSignature(struct);
    const snapshot = makeSnapshot({
      url: "http://localhost:3000/p",
      accessibilityTree: [{ role: "button", ref: "n1", name: "Save" }],
    });

    const { sig, url } = await capturePageSignature(driver, snapshot);

    const expectedText = computeMaskedTextHash(snapshot);
    expect(sig).toBe(computeMatchSignature(expectedText, struct));
    expect(splitMatchSignature(sig)).toEqual({ text: expectedText, struct });
    // url comes from the snapshot (the page the tier resolved against).
    expect(url).toBe("http://localhost:3000/p");
    // The driver's RAW text signature was NOT consulted (masked text is computed locally).
    const textModeCall = driver
      .callsTo("captureStateSignature")
      .some((c) => (c.args[0] as { mode?: string } | undefined)?.mode !== "structure");
    expect(textModeCall).toBe(false);
  });

  test("sources the struct component from mode:'structure'", async () => {
    const driver = new MockDriver().setStructureSignature("/p|STRUCT");
    const snapshot = makeSnapshot({
      url: "http://h/p",
      accessibilityTree: [{ role: "link", ref: "n1", name: "Home" }],
    });
    const { sig } = await capturePageSignature(driver, snapshot);
    const expectedText = computeMaskedTextHash(snapshot);
    expect(splitMatchSignature(sig)).toEqual({ text: expectedText, struct: "/p|STRUCT" });
    // And the driver was actually asked for the structure mode.
    const structCall = driver
      .callsTo("captureStateSignature")
      .some((c) => (c.args[0] as { mode?: string } | undefined)?.mode === "structure");
    expect(structCall).toBe(true);
  });

  test("ignore_regions are threaded into BOTH the masked-text hash and the struct maskSelectors", async () => {
    const driver = new MockDriver().setStructureSignature("/p|STRUCT");
    const snapshot = makeSnapshot({
      url: "http://h/p",
      accessibilityTree: [{ role: "button", ref: "n1", name: "Save" }],
    });
    await capturePageSignature(driver, snapshot, { ignoreRegions: ["#feed", "role:timer"] });
    // The struct call carried the ignore_regions as maskSelectors.
    const structCall = driver
      .callsTo("captureStateSignature")
      .find((c) => (c.args[0] as { mode?: string } | undefined)?.mode === "structure");
    expect(structCall).toBeDefined();
    expect((structCall!.args[0] as { maskSelectors?: string[] }).maskSelectors).toEqual([
      "#feed",
      "role:timer",
    ]);
  });
});
