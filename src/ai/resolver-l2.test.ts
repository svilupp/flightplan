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
