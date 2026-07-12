// Flightplan — L2 resolver prompt tests (P6 plan item #3: gauntlet L2→L3 tier mismatch).
//
// OFFLINE, deterministic: exercises `buildResolverPrompt` directly against hand-built
// `CandidatePacketEntry[]` fixtures — no driver/network/model call involved. Asserts the prompt
// renders per-candidate `context` when present (so a genuinely ambiguous same-name/same-role/
// same-score set becomes disambiguable) and stays silent about it when absent.

import { describe, expect, test } from "bun:test";
import type { CandidatePacketEntry } from "./resolve-common.ts";
import { buildResolverPrompt } from "./resolver-l2.ts";

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
