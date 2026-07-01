// Tests for auto-repair (Unit D — Phase 5): covered/disabled/missing deterministic recovery.
//
// All offline against MockDriver with a fake clock (`ctx.sleep`) so the bounded waits are instant.
// Covers: the failure-class mapping, each repair action (dismiss / poll / settle), the retry that
// re-runs L1, the hard attempt/poll bounds (no infinite loop), and the no-repair-needed no-op.

import { describe, expect, test } from "bun:test";
import {
  MockDriver,
  makeFailureBatch,
  makeInteractiveElement,
  makeRankedCandidate,
  makeSnapshot,
  makeSuccessBatch,
} from "../driver/index.ts";
import type { ClickStep, Step } from "../flow/types.ts";
import { resolveL1 } from "./l1.ts";
import { attemptRepair, mapFailureReason } from "./repair.ts";
import type { AiHooks, ResolveContext } from "./types.ts";

const clickStep = (over: Partial<ClickStep> = {}): Step =>
  ({ id: "s1", do: "click", target: "Create order", ...over }) as ClickStep;

/** A snapshot carrying the single "Create order" button (optionally disabled). */
function snapshotWith(name: string, opts: { disabled?: boolean } = {}) {
  return makeSnapshot({
    interactiveElements: [
      makeInteractiveElement({
        ref: "e1",
        role: "button",
        name,
        ...(opts.disabled !== undefined ? { disabled: opts.disabled } : {}),
      }),
    ],
  });
}

/**
 * The native ranking L1 now resolves through (`driver.resolveAll`). Every repair scenario drives
 * a page whose sole target is the "Create order" button (ref `e1`), so a single full-score
 * candidate lets L1 pick it, act, and surface the batch's `failureReason` for auto-repair.
 */
const CREATE_ORDER_CANDIDATE = makeRankedCandidate({ ref: "e1", role: "button", name: "Create order" });

/** A fake clock sleep that records the requested delays and never actually waits. */
function fakeSleep() {
  const calls: number[] = [];
  return { calls, sleep: async (ms: number) => void calls.push(ms) };
}

/** An AiHooks whose L2 records that it was consulted (repair must NOT reach the model tiers). */
function spyAi(): { ai: AiHooks; called: () => boolean } {
  let l2Called = false;
  return {
    ai: {
      resolveL2: async () => {
        l2Called = true;
        return { ok: false, tier: "L2", escalate: true };
      },
    },
    called: () => l2Called,
  };
}

describe("repair — mapFailureReason", () => {
  test("maps the three classes (+ detached/replaced → missing); ignores the rest", () => {
    expect(mapFailureReason("covered")).toBe("covered");
    expect(mapFailureReason("disabled")).toBe("disabled");
    expect(mapFailureReason("missing")).toBe("missing");
    expect(mapFailureReason("detached")).toBe("missing");
    expect(mapFailureReason("replaced")).toBe("missing");
    expect(mapFailureReason("hidden")).toBeUndefined();
    expect(mapFailureReason("timeout")).toBeUndefined();
    expect(mapFailureReason(undefined)).toBeUndefined();
  });
});

describe("repair — covered", () => {
  test("dismisses the overlay (Escape + click #id) and retry resolves at L1", async () => {
    const d = new MockDriver();
    d.setSnapshot(snapshotWith("Create order"));
    d.setResolveAll([CREATE_ORDER_CANDIDATE]);
    d.enqueueBatchResult(
      makeFailureBatch("covered", { coveringElement: { tag: "div", id: "cookie-banner" } }),
    );
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));
    const ctx: ResolveContext = { driver: d, now: () => 0 };

    const l1 = await resolveL1(clickStep(), ctx);
    expect(l1.failureReason).toBe("covered");

    const rep = await attemptRepair(clickStep(), l1, ctx, {}, {});
    expect(rep.repaired).toBe(true);
    expect(rep.kind).toBe("covered");
    expect(rep.execution.ok).toBe(true);
    expect(rep.execution.tier).toBe("L1");
    // dismiss sequence: Escape, then an optional click on the overlay by its stable #id.
    expect(d.callsTo("press").some((c) => c.args[0] === "Escape")).toBe(true);
    expect(d.callsTo("click").some((c) => c.args[0] === "#cookie-banner")).toBe(true);
    // exactly one repair attempt, surfaced with a repair: note.
    expect(rep.attempts).toHaveLength(1);
    expect(rep.attempts[0]?.note).toMatch(/^repair:covered/);
    expect(rep.attempts[0]?.ok).toBe(true);
  });

  test("dismisses by .class when the overlay has only a className", async () => {
    const d = new MockDriver();
    d.setSnapshot(snapshotWith("Create order"));
    d.setResolveAll([CREATE_ORDER_CANDIDATE]);
    d.enqueueBatchResult(
      makeFailureBatch("covered", {
        coveringElement: { tag: "div", className: "modal backdrop" },
      }),
    );
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));
    const ctx: ResolveContext = { driver: d, now: () => 0 };

    const l1 = await resolveL1(clickStep(), ctx);
    const rep = await attemptRepair(clickStep(), l1, ctx, {}, {});
    expect(rep.repaired).toBe(true);
    // first class only.
    expect(d.callsTo("click").some((c) => c.args[0] === ".modal")).toBe(true);
  });

  test("a permanently-covered page escalates after maxAttempts without looping (no model call)", async () => {
    const d = new MockDriver();
    d.setSnapshot(snapshotWith("Create order"));
    d.setResolveAll([CREATE_ORDER_CANDIDATE]);
    d.setBatchResult(
      makeFailureBatch("covered", { coveringElement: { tag: "div", id: "cookie-banner" } }),
    );
    const { ai, called } = spyAi();
    const ctx: ResolveContext = { driver: d, now: () => 0, ai };

    const l1 = await resolveL1(clickStep(), ctx);
    const rep = await attemptRepair(clickStep(), l1, ctx, {}, { maxAttempts: 2 });
    expect(rep.repaired).toBe(false);
    expect(rep.execution.escalate).toBe(true);
    expect(rep.execution.failureReason).toBe("covered");
    expect(rep.attempts).toHaveLength(2); // exactly maxAttempts — bounded, no infinite loop.
    expect(called()).toBe(false); // repair is model-free.
  });
});

describe("repair — disabled", () => {
  test("polls until the element enables, then retry resolves", async () => {
    const present = snapshotWith("Create order");
    const disabled = snapshotWith("Create order", { disabled: true });
    const enabled = snapshotWith("Create order", { disabled: false });
    const d = new MockDriver();
    d.setSnapshot(enabled); // default → the retry L1 snapshot
    d.setResolveAll([CREATE_ORDER_CANDIDATE]);
    d.enqueueSnapshot(present, disabled, disabled, enabled); // initial L1 + 3 poll ticks
    d.enqueueBatchResult(makeFailureBatch("disabled"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));
    const clock = fakeSleep();
    const ctx: ResolveContext = { driver: d, now: () => 0, sleep: clock.sleep };

    const l1 = await resolveL1(clickStep(), ctx);
    expect(l1.failureReason).toBe("disabled");

    const rep = await attemptRepair(clickStep(), l1, ctx, {}, { pollIntervalMs: 250, pollMaxTicks: 8 });
    expect(rep.repaired).toBe(true);
    expect(rep.kind).toBe("disabled");
    expect(rep.execution.ok).toBe(true);
    expect(clock.calls).toEqual([250, 250, 250]); // polled 3 ticks then found enabled.
    expect(rep.attempts).toHaveLength(1);
    expect(rep.attempts[0]?.note).toContain("enabled=true");
  });

  test("never-enabling element gives up after pollMaxTicks and escalates (no second poll)", async () => {
    const present = snapshotWith("Create order");
    const disabled = snapshotWith("Create order", { disabled: true });
    const d = new MockDriver();
    d.setSnapshot(disabled); // every poll snapshot stays disabled
    d.setResolveAll([CREATE_ORDER_CANDIDATE]);
    d.enqueueSnapshot(present); // initial L1 snapshot
    d.setBatchResult(makeFailureBatch("disabled")); // every batch stays disabled
    const clock = fakeSleep();
    const { ai, called } = spyAi();
    const ctx: ResolveContext = { driver: d, now: () => 0, sleep: clock.sleep, ai };

    const l1 = await resolveL1(clickStep(), ctx);
    const rep = await attemptRepair(clickStep(), l1, ctx, {}, { pollMaxTicks: 8, maxAttempts: 2 });
    expect(rep.repaired).toBe(false);
    expect(rep.execution.escalate).toBe(true);
    expect(rep.execution.failureReason).toBe("disabled");
    expect(clock.calls).toHaveLength(8); // exactly pollMaxTicks — does NOT re-poll.
    expect(rep.attempts).toHaveLength(1);
    expect(rep.attempts[0]?.note).toContain("enabled=false");
    expect(called()).toBe(false);
  });
});

describe("repair — missing", () => {
  test("settles then re-resolves; one retry resolves", async () => {
    const d = new MockDriver();
    d.setSnapshot(snapshotWith("Create order"));
    d.setResolveAll([CREATE_ORDER_CANDIDATE]);
    d.enqueueBatchResult(makeFailureBatch("missing"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));
    const clock = fakeSleep();
    const ctx: ResolveContext = { driver: d, now: () => 0, sleep: clock.sleep };

    const l1 = await resolveL1(clickStep(), ctx);
    expect(l1.failureReason).toBe("missing");

    const rep = await attemptRepair(clickStep(), l1, ctx, {}, { settleMs: 150 });
    expect(rep.repaired).toBe(true);
    expect(rep.kind).toBe("missing");
    expect(rep.execution.ok).toBe(true);
    expect(clock.calls).toEqual([150]); // exactly one settle, one retry.
    expect(rep.attempts).toHaveLength(1);
    expect(rep.attempts[0]?.note).toMatch(/^repair:missing/);
  });

  test("detached is repaired as missing", async () => {
    const d = new MockDriver();
    d.setSnapshot(snapshotWith("Create order"));
    d.setResolveAll([CREATE_ORDER_CANDIDATE]);
    d.enqueueBatchResult(makeFailureBatch("detached"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));
    const ctx: ResolveContext = { driver: d, now: () => 0, sleep: async () => {} };

    const l1 = await resolveL1(clickStep(), ctx);
    const rep = await attemptRepair(clickStep(), l1, ctx, {}, {});
    expect(rep.kind).toBe("missing");
    expect(rep.repaired).toBe(true);
  });
});

describe("repair — no-op / bounds", () => {
  test("an unrepairable failure (hidden) is a no-op: no attempts, exec untouched, no dismiss", async () => {
    const d = new MockDriver();
    d.setSnapshot(snapshotWith("Create order"));
    d.setResolveAll([CREATE_ORDER_CANDIDATE]);
    d.setBatchResult(makeFailureBatch("hidden"));
    const ctx: ResolveContext = { driver: d, now: () => 0 };

    const l1 = await resolveL1(clickStep(), ctx);
    const rep = await attemptRepair(clickStep(), l1, ctx, {}, {});
    expect(rep.attempts).toHaveLength(0);
    expect(rep.repaired).toBe(false);
    expect(rep.kind).toBeUndefined();
    expect(rep.execution).toBe(l1); // the input exec is returned unchanged.
    expect(d.callsTo("press")).toHaveLength(0);
  });
});
