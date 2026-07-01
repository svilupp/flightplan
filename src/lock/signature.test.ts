// Tests for lock page signatures (PLAN.md §4 / §5 Phase 3 / §8 risk #1).
//
// The composite `match.sig` = text component (`captureStateSignature()`) + structure component
// (`captureStateSignature({ mode: 'structure' })`, browser-pilot native). These verify: the
// composite round-trips through split; both components must match (with legacy text-only
// degradation); the anchored url glob; the write-time url_glob derivation; and that
// `capturePageSignature` composes the driver's two signatures around the snapshot URL.

import { describe, expect, test } from "bun:test";
import { makeSnapshot, MockDriver } from "../driver/index.ts";
import { capturePageSignature } from "../ladder/page-signature.ts";
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
  test("composes the driver's text + structure sigs and returns the snapshot URL", async () => {
    const text = "http://localhost:3000/p|TEXTHASH";
    const struct = "/p|STRUCTHASH";
    const driver = new MockDriver().setSignature(text).setStructureSignature(struct);
    const snapshot = makeSnapshot({ url: "http://localhost:3000/p" });

    const { sig, url } = await capturePageSignature(driver, snapshot);

    // sig is exactly the composite of the driver's two signatures.
    expect(sig).toBe(computeMatchSignature(text, struct));
    expect(splitMatchSignature(sig)).toEqual({ text, struct });
    // url comes from the snapshot (the page the tier resolved against).
    expect(url).toBe("http://localhost:3000/p");
  });

  test("sources the struct component from mode:'structure' (not the text sig)", async () => {
    const driver = new MockDriver()
      .setSignature("http://h/p|TEXT")
      .setStructureSignature("/p|STRUCT");
    const { sig } = await capturePageSignature(driver, makeSnapshot({ url: "http://h/p" }));
    // The two components are distinct → the driver's structure channel was used.
    expect(splitMatchSignature(sig)).toEqual({ text: "http://h/p|TEXT", struct: "/p|STRUCT" });
    // And the driver was actually asked for the structure mode.
    const structCall = driver
      .callsTo("captureStateSignature")
      .some((c) => (c.args[0] as { mode?: string } | undefined)?.mode === "structure");
    expect(structCall).toBe(true);
  });
});
