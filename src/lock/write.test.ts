// Tests for the lock write policy (PLAN.md §5 Phase 3 write policy / §2 mermaid (a)).
//
// `resolveLockWriteMode` (flag → mode) and `decideLockWrite` (the pure per-step decision):
// L0 hit → no write; first-learn → store; unchanged re-resolution → no write; drift → heal,
// failing the run only under --frozen.

import { describe, expect, test } from "bun:test";
import type { StepExecution } from "../ladder/index.ts";
import type { Strategy } from "../types.ts";
import type { LockMatch, LockTarget } from "./types.ts";
import { decideLockWrite, resolveLockWriteMode } from "./write.ts";

const inferStrategy = (_s: string): Strategy | null => "role_name";
const MATCH: LockMatch = { url_glob: "http://h/p*", sig: "text:http://h/p|t;struct:/p|s" };
const NOW = () => 0;

/** A successful L1 resolution whose durable winner is `selector`. */
function exec(selector: string, strategy: Strategy = "role_name"): StepExecution {
  return { ok: true, tier: "L1", durableSelector: selector, strategy, escalate: false };
}

/** An existing v2 portfolio target whose winner is `selector`. */
function existingTarget(selector: string, strategy: Strategy = "role_name"): LockTarget {
  return {
    step: "s1",
    target: "the button",
    match: MATCH,
    strategies: [{ kind: strategy, selector, greens: 2, last_ok: "1970-01-01T00:00:00.000Z" }],
  };
}

/** The winner selector of a decision's target portfolio. */
function winnerSelector(t: LockTarget | undefined): string | undefined {
  return t?.strategies?.[0]?.selector;
}

const STEP = { id: "s1", target: "the button" };

describe("resolveLockWriteMode", () => {
  test("maps the flags (frozen wins over no-lock-write)", () => {
    expect(resolveLockWriteMode({})).toBe("auto");
    expect(resolveLockWriteMode({ noLockWrite: true })).toBe("no-write");
    expect(resolveLockWriteMode({ frozen: true })).toBe("frozen");
    expect(resolveLockWriteMode({ frozen: true, noLockWrite: true })).toBe("frozen");
  });
});

describe("decideLockWrite — no-write paths", () => {
  test("an L0 cache hit never writes", () => {
    const d = decideLockWrite({
      mode: "auto",
      existing: existingTarget("role:button:Go"),
      resolvedAtL0: true,
      step: STEP,
      execution: exec("role:button:Go"),
      match: MATCH,
      inferStrategy,
      now: NOW,
    });
    expect(d.healed).toBe(false);
    expect(d.target).toBeUndefined();
  });

  test("no durable selector → nothing to store", () => {
    const d = decideLockWrite({
      mode: "auto",
      existing: undefined,
      resolvedAtL0: false,
      step: STEP,
      execution: { ok: true, tier: "L1", escalate: false },
      match: MATCH,
      inferStrategy,
      now: NOW,
    });
    expect(d.target).toBeUndefined();
    expect(d.healed).toBe(false);
  });

  test("existing recipe, same winner → not a heal (portfolio track records still update)", () => {
    const d = decideLockWrite({
      mode: "auto",
      existing: existingTarget("role:button:Go"),
      resolvedAtL0: false,
      step: STEP,
      execution: exec("role:button:Go"),
      match: MATCH,
      inferStrategy,
      now: NOW,
    });
    // Winner unchanged → NOT a heal. But the portfolio IS persisted so `greens` accumulates.
    expect(d.healed).toBe(false);
    expect(winnerSelector(d.target)).toBe("role:button:Go");
    expect(d.target?.strategies?.[0]?.greens).toBe(3); // 2 → 3 on this green
  });

  test("a FROZEN L0 hit is read-only (no track-record write)", () => {
    const d = decideLockWrite({
      mode: "frozen",
      existing: existingTarget("role:button:Go"),
      resolvedAtL0: true,
      step: STEP,
      execution: {
        ...exec("role:button:Go"),
        tier: "L0",
        portfolio: {
          winner: { kind: "role_name", selector: "role:button:Go" },
          agreed: [{ kind: "role_name", selector: "role:button:Go" }],
          drifted: [],
          agreement: "1/1",
        },
      },
      match: MATCH,
      inferStrategy,
      now: NOW,
    });
    expect(d.healed).toBe(false);
    expect(d.target).toBeUndefined(); // portfolio consulted, never written
  });
});

describe("decideLockWrite — first learn", () => {
  test("no existing recipe → store a fresh recipe (not a heal)", () => {
    const d = decideLockWrite({
      mode: "auto",
      existing: undefined,
      resolvedAtL0: false,
      step: STEP,
      execution: exec("role:button:Go"),
      match: MATCH,
      inferStrategy,
      now: NOW,
    });
    expect(d.healed).toBe(false);
    expect(d.fail).toBe(false);
    expect(winnerSelector(d.target)).toBe("role:button:Go");
    expect(d.target?.strategies?.[0]?.greens).toBe(1);
    expect(d.target?.match).toEqual(MATCH);
  });
});

describe("decideLockWrite — heal (drift)", () => {
  const drift = () =>
    ({
      existing: existingTarget("role:button:OldName"),
      resolvedAtL0: false,
      step: STEP,
      execution: exec("role:button:NewName"),
      match: MATCH,
      inferStrategy,
      now: NOW,
    }) as const;

  test("auto → heal, new winner leads the portfolio, prior winner demoted (still present)", () => {
    const d = decideLockWrite({ mode: "auto", ...drift() });
    expect(d.healed).toBe(true);
    expect(d.fail).toBe(false);
    expect(winnerSelector(d.target)).toBe("role:button:NewName");
    // The prior winner is DEMOTED, not deleted — it stays in the portfolio (drift resets confidence).
    expect(d.target?.strategies?.some((s) => s.selector === "role:button:OldName")).toBe(true);
  });

  test("--frozen → heal reported AND run must fail", () => {
    const d = decideLockWrite({ mode: "frozen", ...drift() });
    expect(d.healed).toBe(true);
    expect(d.fail).toBe(true);
    // The merged target is still produced (heal-in-memory); the session gates disk persistence.
    expect(winnerSelector(d.target)).toBe("role:button:NewName");
  });

  test("--no-lock-write → heal reported, run NOT failed", () => {
    const d = decideLockWrite({ mode: "no-write", ...drift() });
    expect(d.healed).toBe(true);
    expect(d.fail).toBe(false);
  });
});
