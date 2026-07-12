// Tests for the orchestrator — the L0→L1→(L2 hook) walk (PLAN.md §2 mermaid (b) / §5 Phase 2)
// plus the ONE-shared-snapshot cross-cut (Phase 7): L1 reuses the shared snapshot on a clean L0
// miss, but re-snapshots when an L0 replay acted then failed.

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
import { computeMatchSignature } from "../lock/signature.ts";
import { createLadder, resolveStep } from "./orchestrator.ts";
import type { AiHooks, CachedRecipe, ResolveContext, StepExecution } from "./types.ts";

const clickStep = (over: Partial<ClickStep> = {}): Step => ({
  id: "s1",
  do: "click",
  target: "Create order",
  ...over,
});

function snapshotWith(name: string) {
  return makeSnapshot({
    interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name })],
  });
}

/** Wire the driver so native ranking returns the single button e1 for `name`. */
function ranksTo(d: MockDriver, name: string): MockDriver {
  d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name })]);
  return d;
}

function hookFor(recipe: CachedRecipe): ResolveContext["lock"] {
  return { lookup: () => recipe };
}

describe("orchestrator — L0 stub always misses (Phase 2)", () => {
  test("L0 records a miss attempt and falls through to L1", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));

    const { execution, attempts } = await resolveStep(clickStep(), { driver: d, now: () => 0 });
    expect(attempts[0]?.tier).toBe("L0");
    expect(attempts[0]?.ok).toBe(false);
    expect(attempts[0]?.escalated).toBe(true);
    expect(attempts[1]?.tier).toBe("L1");
    expect(execution.tier).toBe("L1");
    expect(execution.ok).toBe(true);
  });

  test("even with a lock hook returning a recipe, Phase 2 L0 still escalates (no validation yet)", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));
    const ctx: ResolveContext = {
      driver: d,
      now: () => 0,
      lock: {
        lookup: () => ({ selector: "[data-testid='create-order']", strategy: "testid" }),
      },
    };
    const { execution, attempts } = await resolveStep(clickStep(), ctx);
    expect(attempts[0]?.tier).toBe("L0");
    expect(attempts[0]?.ok).toBe(false);
    expect(execution.tier).toBe("L1"); // resolved at L1, not L0
  });
});

describe("orchestrator — ONE shared snapshot cross-cut (Phase 7)", () => {
  test("clean L0 miss → L1 REUSES the shared snapshot (exactly one snapshot taken)", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));
    // No lock hook → L0 misses BEFORE any replay.
    const { execution, attempts } = await resolveStep(clickStep(), { driver: d, now: () => 0 });
    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1"]);
    expect(execution.tier).toBe("L1");
    expect(execution.ok).toBe(true);
    // Shared snapshot (orchestrator) reused by L1 → no second snapshot.
    expect(d.callsTo("snapshot")).toHaveLength(1);
    // The enriched snapshot was requested with attributes.
    expect((d.callsTo("snapshot")[0]?.args[0] as { attributes?: boolean })?.attributes).toBe(true);
  });

  test("L0 validates then replay FAILS → L1 takes a FRESH snapshot (page may have mutated)", async () => {
    const URL = "http://localhost:3000/";
    const TEXT = `${URL}|t`;
    const STRUCT = "/|s";
    const snap = makeSnapshot({
      url: URL,
      interactiveElements: [
        makeInteractiveElement({ ref: "e1", role: "button", name: "Create order" }),
      ],
    });
    const d = new MockDriver().setSnapshot(snap).setSignature(TEXT).setStructureSignature(STRUCT);
    ranksTo(d, "Create order");
    // L0 replay is the first batch (fails); L1's batch (second) succeeds.
    d.enqueueBatchResult(makeFailureBatch("missing"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));

    const recipe: CachedRecipe = {
      selector: "role:button:Create order",
      strategy: "role_name",
      match: { url_glob: "http://localhost:3000/*", sig: computeMatchSignature(TEXT, STRUCT) },
    };
    const { execution, attempts } = await resolveStep(clickStep(), {
      driver: d,
      now: () => 0,
      lock: hookFor(recipe),
    });

    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1"]);
    expect(execution.tier).toBe("L1");
    expect(execution.ok).toBe(true);
    // shared snapshot (orchestrator) + L1's fresh re-snapshot after the replay-fail = 2.
    expect(d.callsTo("snapshot")).toHaveLength(2);
    // L0 did reach + fail the replay (proof the fresh re-snapshot was warranted).
    expect(d.callsTo("batch")).toHaveLength(2);
  });
});

describe("orchestrator — L1 success short-circuits", () => {
  test("when L1 resolves, no AI hook is consulted", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));

    let l2Called = false;
    const ai: AiHooks = {
      resolveL2: async (_s, prior) => {
        l2Called = true;
        return { ...prior, tier: "L2", ok: true, escalate: false };
      },
    };
    const { execution } = await resolveStep(clickStep(), { driver: d, now: () => 0, ai });
    expect(execution.ok).toBe(true);
    expect(execution.tier).toBe("L1");
    expect(l2Called).toBe(false);
  });
});

describe("orchestrator — L1 escalation", () => {
  // NOTE: these AI-climb tests script `hidden` (a NON-repairable failure) so they isolate the
  // pure escalation path. A repairable failure (covered/disabled/missing) would correctly trigger
  // auto-repair (Phase 5, Unit D) first — that path has its own tests below / in repair.test.ts.
  test("with NO AI hook → returns escalate:true + the handoff (Phase 2 default)", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeFailureBatch("hidden"));

    const { execution, attempts } = await resolveStep(clickStep(), { driver: d, now: () => 0 });
    expect(execution.ok).toBe(false);
    expect(execution.escalate).toBe(true);
    expect(execution.tier).toBe("L1");
    expect(execution.handoff).toBeDefined();
    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1"]);
  });

  test("with a stub L2 hook → the orchestrator calls it and returns its result", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeFailureBatch("hidden"));

    let received: StepExecution | undefined;
    const ai: AiHooks = {
      resolveL2: async (_step, prior) => {
        received = prior;
        return {
          ok: true,
          tier: "L2",
          strategy: "role_name",
          durableSelector: "role:button:Create order",
          escalate: false,
        };
      },
    };
    const { execution, attempts } = await resolveStep(clickStep(), { driver: d, now: () => 0, ai });
    expect(received?.tier).toBe("L1");
    expect(received?.handoff).toBeDefined(); // the failed L1 result (with handoff) is passed in
    expect(execution.tier).toBe("L2");
    expect(execution.ok).toBe(true);
    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1", "L2"]);
  });

  test("L2 → L3 → L4 climb when each escalates and hooks exist", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeFailureBatch("hidden"));

    const ai: AiHooks = {
      resolveL2: async () => ({ ok: false, tier: "L2", escalate: true }),
      resolveL3: async () => ({ ok: false, tier: "L3", escalate: true }),
      classifyL4: async () => ({ ok: false, tier: "L4", escalate: false, error: "bug" }),
    };
    const { execution, attempts } = await resolveStep(clickStep(), { driver: d, now: () => 0, ai });
    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1", "L2", "L3", "L4"]);
    expect(execution.tier).toBe("L4");
    expect(execution.escalate).toBe(false);
  });
});

describe("orchestrator — dispatch boundary", () => {
  test("uncertain L0 replay is terminal and is not sent to L1", async () => {
    const d = new MockDriver()
      .setSnapshot(snapshotWith("Create order"))
      .setSignature("http://localhost:3000/|t")
      .setStructureSignature("/|s")
      .setBatchResult(
        makeFailureBatch("missing", {
          dispatchState: "uncertain",
          retrySafe: false,
          retryReason: "response lost after input",
        }),
      );
    ranksTo(d, "Create order");
    const recipe: CachedRecipe = {
      selector: "role:button:Create order",
      strategy: "role_name",
      match: {
        url_glob: "http://localhost:3000/*",
        sig: computeMatchSignature("http://localhost:3000/|t", "/|s"),
      },
    };

    const { execution, attempts } = await resolveStep(clickStep(), {
      driver: d,
      now: () => 0,
      lock: hookFor(recipe),
    });

    expect(attempts.map((a) => a.tier)).toEqual(["L0"]);
    expect(d.callsTo("batch")).toHaveLength(1);
    expect(d.callsTo("resolveAll")).toHaveLength(0);
    expect(execution.dispatchState).toBe("uncertain");
    expect(execution.retrySafe).toBe(false);
  });

  test("dispatched L1 failure does not climb to another tier", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(
      makeFailureBatch("hidden", {
        dispatchState: "dispatched",
        retrySafe: false,
        retryReason: "post-dispatch outcome failed",
      }),
    );
    let l2Called = false;
    const ai: AiHooks = {
      resolveL2: async () => {
        l2Called = true;
        return { ok: true, tier: "L2", escalate: false };
      },
    };

    const { execution, attempts } = await resolveStep(clickStep(), { driver: d, now: () => 0, ai });

    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1"]);
    expect(d.callsTo("batch")).toHaveLength(1);
    expect(l2Called).toBe(false);
    expect(execution.dispatchState).toBe("dispatched");
  });
});

describe("orchestrator — auto-repair (Phase 5, Unit D) wires between L1 and the AI climb", () => {
  test("covered → overlay dismissed + retry resolves at L1; AI never consulted", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.enqueueBatchResult(
      makeFailureBatch("covered", { coveringElement: { tag: "div", id: "cookie-banner" } }),
    );
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));

    let l2Called = false;
    const ai: AiHooks = {
      resolveL2: async (_s, prior) => {
        l2Called = true;
        return { ...prior, tier: "L2", ok: true, escalate: false };
      },
    };
    const { execution, attempts } = await resolveStep(clickStep(), { driver: d, now: () => 0, ai });
    expect(execution.ok).toBe(true);
    expect(execution.tier).toBe("L1");
    expect(l2Called).toBe(false);
    expect(d.callsTo("press").some((c) => c.args[0] === "Escape")).toBe(true);
    // the repair retry is surfaced as an extra L1 resolution_attempt carrying a repair: note.
    expect(attempts.some((a) => a.note?.startsWith("repair:covered"))).toBe(true);
    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1", "L1"]);
  });

  test("repaired-but-still-failing (missing) climbs to L2 with the repair attempts recorded", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeFailureBatch("missing")); // permanently missing → repair can't fix it

    let l2Called = false;
    const ai: AiHooks = {
      resolveL2: async () => {
        l2Called = true;
        return {
          ok: true,
          tier: "L2",
          escalate: false,
          durableSelector: "role:button:Create order",
        };
      },
    };
    const { execution, attempts } = await resolveStep(clickStep(), {
      driver: d,
      now: () => 0,
      sleep: async () => {},
      ai,
    });
    expect(l2Called).toBe(true);
    expect(execution.tier).toBe("L2");
    expect(execution.ok).toBe(true);
    expect(attempts.some((a) => a.note?.startsWith("repair:missing"))).toBe(true);
    expect(attempts[attempts.length - 1]?.tier).toBe("L2");
  });

  test("L1 escalation without a failureReason (no candidates) skips repair and climbs to L2", async () => {
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ interactiveElements: [] })); // nothing to match → no failureReason
    // resolveAll returns [] by default → no target → escalate with no failureReason.

    let l2Called = false;
    const ai: AiHooks = {
      resolveL2: async () => {
        l2Called = true;
        return { ok: true, tier: "L2", escalate: false };
      },
    };
    const { execution, attempts } = await resolveStep(clickStep(), { driver: d, now: () => 0, ai });
    expect(l2Called).toBe(true);
    expect(execution.tier).toBe("L2");
    expect(attempts.some((a) => a.note?.startsWith("repair:"))).toBe(false); // no repair attempted
    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1", "L2"]);
  });

  test("no-repair-needed: a clean L1 success records no repair attempt and never sleeps/dismisses", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));

    const { execution, attempts } = await resolveStep(clickStep(), { driver: d, now: () => 0 });
    expect(execution.ok).toBe(true);
    expect(execution.tier).toBe("L1");
    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1"]);
    expect(attempts.some((a) => a.note?.startsWith("repair:"))).toBe(false);
    expect(d.callsTo("press")).toHaveLength(0);
  });
});

describe("orchestrator — single-step `tier_hint: 'vision'` routing (pillar c)", () => {
  // A lone vision-hinted step still runs the free/deterministic L0+L1 tiers, but when it must
  // escalate it SKIPS the L2 text tier and climbs STRAIGHT to L3 (vision). L3→L4 is unchanged.
  test("L1 escalation on a vision-hinted step goes to L3, NOT L2", async () => {
    const d = ranksTo(new MockDriver(), "Star icon");
    d.setSnapshot(snapshotWith("Star icon"));
    d.setBatchResult(makeFailureBatch("hidden")); // L1 escalates (non-repairable)

    let l2Called = false;
    let l3Called = false;
    let l3Prior: StepExecution | undefined;
    const ai: AiHooks = {
      resolveL2: async () => {
        l2Called = true;
        return { ok: true, tier: "L2", escalate: false };
      },
      resolveL3: async (_step, prior) => {
        l3Called = true;
        l3Prior = prior;
        return { ok: true, tier: "L3", strategy: "role_name", escalate: false };
      },
    };
    const step = clickStep({ target: "Star icon", tier_hint: "vision" });
    const { execution, attempts } = await resolveStep(step, { driver: d, now: () => 0, ai });

    expect(l2Called).toBe(false); // the text tier is skipped for a vision hint
    expect(l3Called).toBe(true);
    expect(l3Prior?.tier).toBe("L1"); // L3 receives the failed L1 exec directly
    expect(execution.tier).toBe("L3");
    expect(execution.ok).toBe(true);
    // L0 + L1 still ran ahead of the vision hop → only L2 is skipped in the recorded walk.
    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1", "L3"]);
  });

  test("vision-hinted L3 escalation still climbs to L4 (L3→L4 unchanged)", async () => {
    const d = ranksTo(new MockDriver(), "Star icon");
    d.setSnapshot(snapshotWith("Star icon"));
    d.setBatchResult(makeFailureBatch("hidden"));

    const ai: AiHooks = {
      resolveL2: async () => {
        throw new Error("L2 must not be called for a vision-hinted step");
      },
      resolveL3: async () => ({ ok: false, tier: "L3", escalate: true }),
      classifyL4: async () => ({ ok: false, tier: "L4", escalate: false, error: "bug" }),
    };
    const step = clickStep({ target: "Star icon", tier_hint: "vision" });
    const { execution, attempts } = await resolveStep(step, { driver: d, now: () => 0, ai });

    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1", "L3", "L4"]);
    expect(execution.tier).toBe("L4");
    expect(execution.escalate).toBe(false);
  });

  test("a NON-hinted step still climbs through L2 normally (control)", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeFailureBatch("hidden"));

    let l2Called = false;
    const ai: AiHooks = {
      resolveL2: async () => {
        l2Called = true;
        return { ok: true, tier: "L2", escalate: false };
      },
      resolveL3: async () => {
        throw new Error("L3 must not be reached before L2 for a non-hinted step");
      },
    };
    const { execution, attempts } = await resolveStep(clickStep(), { driver: d, now: () => 0, ai });

    expect(l2Called).toBe(true);
    expect(execution.tier).toBe("L2");
    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1", "L2"]);
  });

  test("vision-hinted with only an L2 hook wired falls back to L2 (no L3 available)", async () => {
    // Defensive: if the AI runtime has no vision hook, the hinted step must not dead-end — it
    // degrades to the text tier rather than escalating past every hook.
    const d = ranksTo(new MockDriver(), "Star icon");
    d.setSnapshot(snapshotWith("Star icon"));
    d.setBatchResult(makeFailureBatch("hidden"));

    let l2Called = false;
    const ai: AiHooks = {
      resolveL2: async () => {
        l2Called = true;
        return { ok: true, tier: "L2", escalate: false };
      },
    };
    const step = clickStep({ target: "Star icon", tier_hint: "vision" });
    const { execution, attempts } = await resolveStep(step, { driver: d, now: () => 0, ai });

    expect(l2Called).toBe(true);
    expect(execution.tier).toBe("L2");
    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1", "L2"]);
  });
});

describe("orchestrator — createLadder", () => {
  test("createLadder binds resolveStep with options", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));
    const ladder = createLadder();
    const { execution } = await ladder.resolveStep(clickStep(), { driver: d, now: () => 0 });
    expect(execution.ok).toBe(true);
  });
});

describe("orchestrator — `startTier: 'L3'` (AI-only vision baseline)", () => {
  test("skips L0 + L1 and resolves via L3 even though L0/L1 WOULD have succeeded", async () => {
    // Wire the driver so a normal L0/L1 walk would succeed immediately (proves this is a REAL
    // skip, not merely "L3 also happens to work").
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));

    let l3Called = false;
    const ai: AiHooks = {
      resolveL2: async () => {
        throw new Error("L2 must not be called in baseline mode");
      },
      resolveL3: async (_step, prior) => {
        l3Called = true;
        // Baseline L3 receives a synthetic, non-recorded prior — never the real L0/L1 output.
        expect(prior.tier).toBe("L1");
        return { ok: true, tier: "L3", strategy: "role_name", escalate: false };
      },
    };
    const { execution, attempts } = await resolveStep(
      clickStep(),
      { driver: d, now: () => 0, ai },
      { startTier: "L3" },
    );

    expect(l3Called).toBe(true);
    expect(execution.tier).toBe("L3");
    expect(execution.ok).toBe(true);
    // ONLY the L3 attempt is recorded — no L0/L1 attempts, proving they were skipped, not just
    // superseded.
    expect(attempts.map((a) => a.tier)).toEqual(["L3"]);
    // The driver's snapshot/batch (what L0/L1 would use) were never touched by the orchestrator
    // itself — L0/L1 never ran.
    expect(d.callsTo("snapshot")).toHaveLength(0);
    expect(d.callsTo("batch")).toHaveLength(0);
  });

  test("L3 escalation falls through to L4 (bounded climb still applies)", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));

    const ai: AiHooks = {
      resolveL3: async () => ({ ok: false, tier: "L3", escalate: true }),
      classifyL4: async () => ({ ok: false, tier: "L4", escalate: false, error: "bug" }),
    };
    const { execution, attempts } = await resolveStep(
      clickStep(),
      { driver: d, now: () => 0, ai },
      { startTier: "L3" },
    );
    expect(attempts.map((a) => a.tier)).toEqual(["L3", "L4"]);
    expect(execution.tier).toBe("L4");
  });

  test("with no AI runtime configured, fails clearly instead of silently falling back to L0", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));

    const { execution, attempts } = await resolveStep(
      clickStep(),
      { driver: d, now: () => 0 },
      { startTier: "L3" },
    );
    expect(execution.ok).toBe(false);
    expect(execution.error).toMatch(/start-tier l3/);
    expect(attempts).toHaveLength(0);
  });

  test("omitting `startTier` is byte-identical to the default L0 walk", async () => {
    const d = ranksTo(new MockDriver(), "Create order");
    d.setSnapshot(snapshotWith("Create order"));
    d.setBatchResult(makeSuccessBatch("role:button:Create order"));
    const { execution, attempts } = await resolveStep(clickStep(), { driver: d, now: () => 0 }, {});
    expect(attempts.map((a) => a.tier)).toEqual(["L0", "L1"]);
    expect(execution.tier).toBe("L1");
  });
});
