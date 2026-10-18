// Flightplan — L2 resolver prompt tests (P6 plan item #3: gauntlet L2→L3 tier mismatch).
//
// OFFLINE, deterministic: exercises `buildResolverPrompt` directly against hand-built
// `CandidatePacketEntry[]` fixtures — no driver/network/model call involved. Asserts the prompt
// renders per-candidate `context` when present (so a genuinely ambiguous same-name/same-role/
// same-score set becomes disambiguable) and stays silent about it when absent.

import { describe, expect, test } from "bun:test";
import {
  MockDriver,
  makeRankedCandidate,
  makeSnapshot,
  makeSuccessBatch,
} from "../driver/index.ts";
import type { Step } from "../flow/types.ts";
import type { ResolveContext, StepExecution } from "../ladder/index.ts";
import type { CandidateChooser, ChooseResult } from "./chooser.ts";
import type { CandidatePacketEntry } from "./resolve-common.ts";
import { buildResolverPrompt, resolveL2 } from "./resolver-l2.ts";

describe("buildResolverPrompt", () => {
  test("renders per-candidate context when present (gauntlet-shaped packet)", () => {
    const packet: CandidatePacketEntry[] = [
      { index: 0, role: "button", name: "Save", score: 0.9, context: "Billing address" },
      { index: 1, role: "button", name: "Save", score: 0.9, context: "Search filters" },
      { index: 2, role: "button", name: "Save", score: 0.9, context: "Draft message" },
    ];
    const prompt = buildResolverPrompt(
      "save the billing address, not the search filters or the draft message",
      "click",
      packet,
    );

    expect(prompt).toContain('context="Billing address"');
    expect(prompt).toContain('context="Search filters"');
    expect(prompt).toContain('context="Draft message"');
    // Never leaks a raw selector into the prompt text.
    expect(prompt).not.toMatch(/\[data-|role:button:|#[a-zA-Z]/);
  });

  test("omits the context= segment for candidates with no context", () => {
    const packet: CandidatePacketEntry[] = [{ index: 0, role: "button", name: "Save", score: 0.9 }];
    const prompt = buildResolverPrompt("save it", "click", packet);
    const line = prompt.split("\n").find((l) => l.includes("[0]"));
    expect(line).toBeDefined();
    expect(line).not.toContain("context=");
  });

  test("empty packet still renders the no-candidates placeholder", () => {
    const prompt = buildResolverPrompt("save it", "click", []);
    expect(prompt).toContain("(no interactive candidates)");
  });
});

// ---------------------------------------------------------------------------
// resolveL2 chain walking (extended for the chooser chain)
// ---------------------------------------------------------------------------

function scriptedChooser(
  kind: "jev" | "llm" | "heuristic",
  results: ChooseResult[],
): CandidateChooser {
  let i = 0;
  return {
    kind,
    choose: () => Promise.resolve(results[Math.min(i++, results.length - 1)]!),
  };
}

function clickStep(): Step {
  return { id: "s1", do: "click", target: "Go" } as Step;
}

function ctxFor(driver: MockDriver): ResolveContext {
  return { driver, now: () => 0 };
}

function prior(): StepExecution {
  return { ok: false, tier: "L1", candidates: [], escalate: true };
}

describe("resolveL2 — chooser chain", () => {
  test("a JEV-pick chooser acts via actOnPick (tier L2)", async () => {
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    d.setResolveAll([makeRankedCandidate({ role: "button", name: "Go" })]);
    d.setBatchResult(makeSuccessBatch("role:button:Go"));
    const jev = scriptedChooser("jev", [{ kind: "pick", index: 0, confidence: 0.95 }]);

    const exec = await resolveL2([jev], clickStep(), prior(), ctxFor(d));
    expect(exec.ok).toBe(true);
    expect(exec.tier).toBe("L2");
  });

  test("JEV-abstain falls through to the LLM chooser in the SAME invocation", async () => {
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    d.setResolveAll([makeRankedCandidate({ role: "button", name: "Go" })]);
    d.setBatchResult(makeSuccessBatch("role:button:Go"));
    const jev = scriptedChooser("jev", [{ kind: "abstain", reason: "jev: none_of_the_above" }]);
    const llm = scriptedChooser("llm", [
      { kind: "pick", index: 0, confidence: 0.8, note: "a hint" },
    ]);

    const exec = await resolveL2([jev, llm], clickStep(), prior(), ctxFor(d));
    expect(exec.ok).toBe(true);
    expect(exec.tier).toBe("L2");
  });

  test("both choosers abstaining escalates", async () => {
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    d.setResolveAll([makeRankedCandidate({ role: "button", name: "Go" })]);
    const jev = scriptedChooser("jev", [{ kind: "abstain", reason: "jev: none_of_the_above" }]);
    const llm = scriptedChooser("llm", [{ kind: "abstain", reason: "llm: give_up" }]);

    const exec = await resolveL2([jev, llm], clickStep(), prior(), ctxFor(d));
    expect(exec.ok).toBe(false);
    expect(exec.escalate).toBe(true);
  });

  test('escalateTo: "vision" still surfaces as an escalating L2 result (orchestrator routes to L3)', async () => {
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    d.setResolveAll([makeRankedCandidate({ role: "button", name: "Go" })]);
    const llm = scriptedChooser("llm", [
      { kind: "abstain", reason: "llm: screenshot_needed", escalateTo: "vision" },
    ]);

    const exec = await resolveL2([llm], clickStep(), prior(), ctxFor(d));
    expect(exec.ok).toBe(false);
    expect(exec.escalate).toBe(true);
    expect(exec.tier).toBe("L2");
  });

  test('escalateTo: "vision" short-circuits the chain — a later chooser is NEVER consulted (D3)', async () => {
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    d.setResolveAll([makeRankedCandidate({ role: "button", name: "Go" })]);
    const llm = scriptedChooser("llm", [
      { kind: "abstain", reason: "llm: screenshot_needed", escalateTo: "vision" },
    ]);
    let heuristicCalls = 0;
    const heuristic: CandidateChooser = {
      kind: "heuristic",
      choose: () => {
        heuristicCalls += 1;
        return Promise.resolve({ kind: "pick", index: 0, confidence: 0.9 });
      },
    };

    const exec = await resolveL2([llm, heuristic], clickStep(), prior(), ctxFor(d));
    expect(exec.ok).toBe(false);
    expect(exec.escalate).toBe(true);
    expect(heuristicCalls).toBe(0); // the heuristic must never be consulted after screenshot_needed
  });

  test("a note is attached only when the picking chooser (LLM) returns one", async () => {
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    d.setResolveAll([makeRankedCandidate({ role: "button", name: "Go" })]);
    d.setBatchResult(makeSuccessBatch("role:button:Go"));
    const jev = scriptedChooser("jev", [
      { kind: "pick", index: 0, confidence: 0.95, reason: "jev: choice" },
    ]);

    const exec = await resolveL2([jev], clickStep(), prior(), ctxFor(d));
    expect(exec.ok).toBe(true);
    expect(exec.note).toBeUndefined(); // JEV never emits a note
  });
});

test("shadow compares original candidates after the authoritative action", async () => {
  const d = new MockDriver();
  d.setSnapshot(makeSnapshot({ interactiveElements: [] }));
  d.setResolveAll([
    makeRankedCandidate({ role: "button", ref: "e1", name: "First" }),
    makeRankedCandidate({ role: "button", ref: "e2", name: "Second" }),
  ]);
  d.setBatchResult(makeSuccessBatch("ref:e1"));
  const order: string[] = [];
  let authorityPacket: CandidatePacketEntry[] = [];
  const batch = d.batch.bind(d);
  d.batch = async (...args) => {
    order.push("action");
    d.setResolveAll([makeRankedCandidate({ role: "button", ref: "e3", name: "Changed" })]);
    return batch(...args);
  };
  const shadow: CandidateChooser = {
    kind: "jev",
    async choose(_intent, packet) {
      expect(packet).toBe(authorityPacket);
      expect(packet.map((candidate) => candidate.name)).toEqual(["First", "Second"]);
      order.push("shadow");
      return { kind: "pick", index: 1, confidence: 1 };
    },
  };
  const authority: CandidateChooser = {
    kind: "heuristic",
    async choose(_intent, packet) {
      authorityPacket = packet;
      order.push("authority");
      return { kind: "pick", index: 0, confidence: 1 };
    },
  };
  const result = await resolveL2([authority], clickStep(), prior(), ctxFor(d), shadow);
  expect(order).toEqual(["authority", "action", "shadow"]);
  expect(result.pinnedLabel).toBe("First");
});

test("profile freshness rejects a changed candidate before any dispatch", async () => {
  const d = new MockDriver();
  d.setSnapshot(makeSnapshot({ interactiveElements: [] }));
  let calls = 0;
  d.resolveAll = async () => [
    makeRankedCandidate({ role: "button", ref: ++calls === 1 ? "e1" : "e2", name: "Go" }),
  ];
  let dispatches = 0;
  d.batch = async () => {
    dispatches++;
    return makeSuccessBatch("ref:e2");
  };
  const result = await resolveL2(
    [scriptedChooser("jev", [{ kind: "pick", index: 0, confidence: 1 }])],
    clickStep(),
    prior(),
    ctxFor(d),
    undefined,
    undefined,
    true,
  );
  expect(result.ok).toBe(false);
  expect(result.error).toBe("jev_snapshot_stale");
  expect(dispatches).toBe(0);
});

test("verified scoped attributes are compared again before dispatch", async () => {
  const { makeInteractiveElement } = await import("../driver/index.ts");
  const d = new MockDriver();
  let observations = 0,
    dispatches = 0;
  d.snapshot = async () =>
    makeSnapshot({
      interactiveElements: [
        makeInteractiveElement({
          role: "button",
          ref: "e1",
          name: "Go",
          attributes: { title: ++observations < 4 ? "Save invoice" : "Delete invoice" },
        }),
      ],
    });
  d.setResolveAll([makeRankedCandidate({ role: "button", ref: "e1", name: "Go" })]);
  d.batch = async () => {
    dispatches++;
    return makeSuccessBatch("ref:e1");
  };
  const chooser: CandidateChooser = {
    kind: "jev",
    async choose(_intent, _packet, context) {
      expect(await context.verificationEvidence?.(0)).toEqual({
        candidate: { title: "Save invoice" },
        alternative: null,
      });
      return { kind: "pick", index: 0, confidence: 1 };
    },
  };
  const result = await resolveL2(
    [chooser],
    clickStep(),
    prior(),
    ctxFor(d),
    undefined,
    undefined,
    true,
  );
  expect(result.error).toBe("jev_snapshot_stale");
  expect(dispatches).toBe(0);
});

test("authoritative abstention preserves fallback allowance without paid shadow work", async () => {
  const d = new MockDriver();
  d.setSnapshot(makeSnapshot({ interactiveElements: [] }));
  d.setResolveAll([makeRankedCandidate({ role: "button", ref: "e1", name: "First" })]);
  let shadowCalls = 0;
  const shadow: CandidateChooser = {
    kind: "jev",
    async choose() {
      shadowCalls++;
      return { kind: "pick", index: 0, confidence: 1 };
    },
  };
  const result = await resolveL2(
    [scriptedChooser("heuristic", [{ kind: "abstain", reason: "uncertain" }])],
    clickStep(),
    prior(),
    ctxFor(d),
    shadow,
  );
  expect(result.ok).toBe(false);
  expect(result.escalate).toBe(true);
  expect(shadowCalls).toBe(0);
});
