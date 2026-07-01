// Tests for the ladder's role guard, ambiguity policy, and L2 handoff (PLAN.md §8 risk #8;
// §7 escalation). Candidate ranking is the driver's native `resolveAll` (exercised in l1.test.ts),
// so this module no longer owns a fuzzy scorer.

import { describe, expect, test } from "bun:test";
import { buildHandoff, isAmbiguous, isInteractiveRole } from "./fuzzy.ts";
import type { RankedCandidate } from "./types.ts";

describe("isInteractiveRole — the role guard", () => {
  test("interactive roles pass, document roles fail", () => {
    expect(isInteractiveRole("button")).toBe(true);
    expect(isInteractiveRole("textbox")).toBe(true);
    expect(isInteractiveRole("code")).toBe(false);
    expect(isInteractiveRole("paragraph")).toBe(false);
  });
});

describe("isAmbiguous", () => {
  const cand = (score: number): RankedCandidate => ({
    role: "button",
    name: "Continue",
    selector: "role:button:Continue",
    strategy: "role_name",
    score,
  });
  test("two close high scorers are ambiguous", () => {
    expect(isAmbiguous([cand(0.95), cand(0.93)])).toBe(true);
  });
  test("a clear winner is not ambiguous", () => {
    expect(isAmbiguous([cand(0.95), cand(0.5)])).toBe(false);
  });
  test("a single candidate is never ambiguous", () => {
    expect(isAmbiguous([cand(0.95)])).toBe(false);
  });
});

describe("buildHandoff — compact projection + signals", () => {
  test("projects topMatches, caps to maxMatches, carries signals", () => {
    const ranked: RankedCandidate[] = [
      { role: "button", name: "A", selector: "role:button:A", strategy: "role_name", score: 0.9 },
      { role: "button", name: "B", selector: "role:button:B", strategy: "role_name", score: 0.8 },
      { role: "button", name: "C", selector: "role:button:C", strategy: "role_name", score: 0.7 },
    ];
    const h = buildHandoff({
      intent: "pick A",
      action: "click",
      ranked,
      failureReason: "covered",
      coveringElement: { tag: "div", className: "banner" },
      maxMatches: 2,
    });
    expect(h.intent).toBe("pick A");
    expect(h.action).toBe("click");
    expect(h.topMatches).toHaveLength(2);
    expect(h.topMatches[0]).toEqual({ role: "button", name: "A", selector: "role:button:A", score: 0.9 });
    expect(h.failureReason).toBe("covered");
    expect(h.coveringElement?.className).toBe("banner");
  });
});
