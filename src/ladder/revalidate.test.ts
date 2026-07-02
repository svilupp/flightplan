// Tests for L0 per-target revalidation (L0 cache-hit quality — Layer 3).
//
// Pure snapshot-only matching: given a cached recipe and a fresh snapshot's interactive elements,
// does the cached selector (or a candidate) still uniquely resolve the locked target?

import { describe, expect, test } from "bun:test";
import type { InteractiveElement } from "../driver/index.ts";
import { makeInteractiveElement } from "../driver/index.ts";
import type { StrategyEntry } from "../lock/types.ts";
import { parseDurableSelector, racePortfolio, revalidateCachedTarget } from "./revalidate.ts";
import type { CachedRecipe } from "./types.ts";

function entry(
  kind: StrategyEntry["kind"],
  selector: string,
  greens = 1,
  over: Partial<StrategyEntry> = {},
): StrategyEntry {
  return { kind, selector, greens, ...over };
}

describe("parseDurableSelector", () => {
  test("role_name → role + name", () => {
    expect(parseDurableSelector("role:button:Save")).toEqual({ role: "button", name: "Save" });
  });
  test("role-only → role", () => {
    expect(parseDurableSelector("role:button")).toEqual({ role: "button" });
  });
  test("testid → testid value", () => {
    expect(parseDurableSelector("[data-testid='save']")).toEqual({ testid: "save" });
    expect(parseDurableSelector("[data-qa=go]")).toEqual({ testid: "go" });
  });
  test("label → aria-label / placeholder attr", () => {
    expect(parseDurableSelector("[aria-label='Close']")).toEqual({
      attr: { key: "aria-label", value: "Close" },
    });
  });
  test("scoped_text → text", () => {
    expect(parseDurableSelector("text:Continue")).toEqual({ text: "Continue" });
  });
  test("fingerprint → role + name", () => {
    expect(parseDurableSelector("fingerprint:role=button;name=Save")).toEqual({
      fingerprint: { role: "button", name: "Save" },
    });
  });
  test("a bare css / unknown selector → undefined (cannot revalidate on it)", () => {
    expect(parseDurableSelector(".btn.primary")).toBeUndefined();
    expect(parseDurableSelector("ref:e1")).toBeUndefined();
  });
});

describe("revalidateCachedTarget", () => {
  const recipe: CachedRecipe = { selector: "role:button:Save", strategy: "role_name" };

  test("exactly one matching element → ok, returns that element + recipe", () => {
    const els: InteractiveElement[] = [
      makeInteractiveElement({ ref: "e1", role: "button", name: "Save" }),
      makeInteractiveElement({ ref: "e2", role: "button", name: "Cancel" }),
    ];
    const r = revalidateCachedTarget(recipe, els);
    expect(r.ok).toBe(true);
    expect(r.element?.ref).toBe("e1");
    expect(r.recipe).toBe(recipe);
  });

  test("no matching element → not ok (genuine drift)", () => {
    const els: InteractiveElement[] = [
      makeInteractiveElement({ ref: "e1", role: "button", name: "Cancel" }),
    ];
    expect(revalidateCachedTarget(recipe, els).ok).toBe(false);
  });

  test("two matching elements → not ok (now ambiguous)", () => {
    const els: InteractiveElement[] = [
      makeInteractiveElement({ ref: "e1", role: "button", name: "Save" }),
      makeInteractiveElement({ ref: "e2", role: "button", name: "Save" }),
    ];
    expect(revalidateCachedTarget(recipe, els).ok).toBe(false);
  });

  test("falls through to a candidate when the head no longer resolves", () => {
    const withCandidates: CachedRecipe = {
      selector: "role:button:Old Label", // gone
      strategy: "role_name",
      candidates: [{ selector: "[data-testid='save']", strategy: "testid" }],
    };
    const els: InteractiveElement[] = [
      makeInteractiveElement({
        ref: "e9",
        role: "button",
        name: "Save",
        attributes: { "data-testid": "save" },
      }),
    ];
    const r = revalidateCachedTarget(withCandidates, els);
    expect(r.ok).toBe(true);
    expect(r.recipe?.selector).toBe("[data-testid='save']");
  });

  test("role matches but accessible name changed → not ok (role+name must agree)", () => {
    const els: InteractiveElement[] = [
      // Same role, different name → the role_name selector `role:button:Save` won't match it.
      makeInteractiveElement({ ref: "e1", role: "button", name: "Store" }),
    ];
    expect(revalidateCachedTarget(recipe, els).ok).toBe(false);
  });
});

describe("racePortfolio (DESIGN §3.2)", () => {
  const NOW = 0;

  test("ALL AGREE: multiple strategies resolve the SAME element → high confidence, all agreed", () => {
    const els: InteractiveElement[] = [
      makeInteractiveElement({
        ref: "e1",
        role: "button",
        name: "Save",
        attributes: { "data-testid": "save", "aria-label": "Save" },
      }),
      makeInteractiveElement({ ref: "e2", role: "button", name: "Cancel" }),
    ];
    const race = racePortfolio(
      [
        entry("testid", "[data-testid='save']"),
        entry("role_name", "role:button:Save"),
        entry("label", "[aria-label='Save']"),
      ],
      els,
      NOW,
    );
    expect(race.ok).toBe(true);
    expect(race.element?.ref).toBe("e1");
    expect(race.agreed).toHaveLength(3); // all three point at e1
    expect(race.drifted).toHaveLength(0);
    expect(race.agreement).toBe("3/3");
  });

  test("PARTIAL AGREEMENT: majority element wins; the disagreeing strategy drifts", () => {
    const els: InteractiveElement[] = [
      makeInteractiveElement({
        ref: "e1",
        role: "button",
        name: "Save",
        attributes: { "data-testid": "save" },
      }),
      // A stray element the stale role_name selector now points at.
      makeInteractiveElement({ ref: "e2", role: "button", name: "Wrong" }),
    ];
    const race = racePortfolio(
      [
        entry("testid", "[data-testid='save']"), // → e1
        entry("label", "[aria-label='Save']"), // → nothing (no aria-label on any el)
        entry("role_name", "role:button:Wrong"), // → e2 (disagrees)
      ],
      els,
      NOW,
    );
    expect(race.ok).toBe(true);
    // Only testid resolves e1 (majority of resolved-and-agreeing); role_name resolved e2 → drift.
    expect(race.winner?.selector).toBe("[data-testid='save']");
    expect(race.drifted.map((d) => d.selector)).toContain("role:button:Wrong");
  });

  test("SINGLE RESOLVE: exactly one strategy resolves → act (lower confidence)", () => {
    const els: InteractiveElement[] = [
      makeInteractiveElement({
        ref: "e1",
        role: "button",
        name: "Save",
        attributes: { "data-testid": "save" },
      }),
    ];
    const race = racePortfolio(
      [
        entry("role_name", "role:button:Gone"), // absent
        entry("testid", "[data-testid='save']"), // resolves
      ],
      els,
      NOW,
    );
    expect(race.ok).toBe(true);
    expect(race.winner?.selector).toBe("[data-testid='save']");
    expect(race.agreement).toBe("1/2");
  });

  test("NONE resolve → clean miss", () => {
    const els: InteractiveElement[] = [
      makeInteractiveElement({ ref: "e1", role: "button", name: "Totally Different" }),
    ];
    const race = racePortfolio([entry("role_name", "role:button:Save")], els, NOW);
    expect(race.ok).toBe(false);
    expect(race.agreement).toBe("0/1");
  });

  test("DISAGREEMENT (no majority): prefer the best recency-weighted track record", () => {
    // Two strategies each resolve a DIFFERENT element (1 backer each) → tie on count. The one with
    // the better track record wins; the other drifts.
    const els: InteractiveElement[] = [
      makeInteractiveElement({ ref: "e1", role: "button", name: "Alpha" }),
      makeInteractiveElement({ ref: "e2", role: "button", name: "Beta" }),
    ];
    const race = racePortfolio(
      [
        entry("role_name", "role:button:Alpha", 20, { last_ok: new Date(NOW).toISOString() }),
        entry("role_name", "role:button:Beta", 1, { last_ok: new Date(NOW).toISOString() }),
      ],
      els,
      NOW,
    );
    expect(race.ok).toBe(true);
    expect(race.winner?.selector).toBe("role:button:Alpha"); // higher greens → higher score
    expect(race.drifted.map((d) => d.selector)).toContain("role:button:Beta");
  });
});
