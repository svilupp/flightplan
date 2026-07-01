// Flightplan — candidate-context tests (P6 plan item #3: gauntlet L2→L3 tier mismatch).
//
// OFFLINE, deterministic: no driver/network involved. Exercises `buildAncestorContextMap` (the
// accessibility-tree walk that derives nearest-heading/landmark context per `ref`) and
// `buildCandidatePacket` (which attaches that context onto the index-numbered packet) directly
// against hand-built `SnapshotNode[]` / `RankedCandidate[]` fixtures — the same shapes
// `gatherCandidates` produces from a real `driver.snapshot()`.

import { describe, expect, test } from "bun:test";
import type { SnapshotNode } from "browser-pilot";
import type { RankedCandidate } from "../ladder/index.ts";
import { buildAncestorContextMap, buildCandidatePacket } from "./resolve-common.ts";

/** Three near-identical "Save" buttons under three differently-headed panels (the gauntlet shape). */
const GAUNTLET_TREE: SnapshotNode[] = [
  {
    role: "region",
    name: "Billing address",
    ref: "e1",
    children: [{ role: "button", name: "Save", ref: "e2" }],
  },
  {
    role: "region",
    name: "Search filters",
    ref: "e3",
    children: [{ role: "button", name: "Save", ref: "e4" }],
  },
  {
    role: "region",
    name: "Draft message",
    ref: "e5",
    children: [{ role: "button", name: "Save", ref: "e6" }],
  },
  // A button with no named ancestor at all — context should be omitted, not throw.
  { role: "button", name: "Loose Save", ref: "e7" },
];

function rankedFor(ref: string, name = "Save"): RankedCandidate {
  return { ref, role: "button", name, selector: `role:button:${name}`, strategy: "role_name", score: 0.9 };
}

describe("buildAncestorContextMap", () => {
  test("maps each ref to its nearest named ancestor", () => {
    const map = buildAncestorContextMap(GAUNTLET_TREE);
    expect(map.get("e2")).toBe("Billing address");
    expect(map.get("e4")).toBe("Search filters");
    expect(map.get("e6")).toBe("Draft message");
  });

  test("omits refs with no named ancestor", () => {
    const map = buildAncestorContextMap(GAUNTLET_TREE);
    expect(map.has("e7")).toBe(false);
  });

  test("joins nested named ancestors, nearest-most-specific last, capped at 2", () => {
    const nested: SnapshotNode[] = [
      {
        role: "main",
        name: "Account settings",
        ref: "e1",
        children: [
          {
            role: "region",
            name: "Billing address",
            ref: "e2",
            children: [
              {
                role: "form",
                name: "Address form",
                ref: "e3",
                children: [{ role: "button", name: "Save", ref: "e4" }],
              },
            ],
          },
        ],
      },
    ];
    const map = buildAncestorContextMap(nested);
    // Capped at the 2 nearest named ancestors (outer-first join), not all 3.
    expect(map.get("e4")).toBe("Billing address > Address form");
  });

  test("treats a preceding sibling heading as an implicit section label (real gauntlet DOM shape)", () => {
    // The real `/gauntlet` fixture wraps each "Save" in a plain `<div class="panel">` with no
    // accessible name/role, so browser-pilot's a11y tree flattens heading + button into FLAT
    // SIBLINGS at the root level (no landmark ancestor at all) — verified against a live
    // `driver.snapshot()` of examples/flows/gauntlet.toml's fixture page.
    const flatSiblings: SnapshotNode[] = [
      { role: "heading", name: "Search filters", ref: "e4" },
      { role: "paragraph", name: "", ref: "e5" },
      { role: "button", name: "Save", ref: "e6" },
      { role: "heading", name: "Billing address", ref: "e7" },
      { role: "paragraph", name: "", ref: "e8" },
      { role: "button", name: "Save", ref: "e9" },
      { role: "heading", name: "Draft message", ref: "e10" },
      { role: "paragraph", name: "", ref: "e11" },
      { role: "button", name: "Save", ref: "e12" },
    ];
    const map = buildAncestorContextMap(flatSiblings);
    expect(map.get("e6")).toBe("Search filters");
    expect(map.get("e9")).toBe("Billing address");
    expect(map.get("e12")).toBe("Draft message");
    // A heading is itself a CONTEXT_ROLE, so it maps to its own name (harmless — headings are
    // never candidates), not to whatever preceded it.
    expect(map.get("e4")).toBe("Search filters");
  });
});

describe("buildCandidatePacket", () => {
  test("attaches context by ref when a context map is provided", () => {
    const ranked = [rankedFor("e2"), rankedFor("e4"), rankedFor("e6")];
    const contextByRef = buildAncestorContextMap(GAUNTLET_TREE);
    const packet = buildCandidatePacket(ranked, contextByRef);

    expect(packet).toEqual([
      { index: 0, role: "button", name: "Save", score: 0.9, context: "Billing address" },
      { index: 1, role: "button", name: "Save", score: 0.9, context: "Search filters" },
      { index: 2, role: "button", name: "Save", score: 0.9, context: "Draft message" },
    ]);
  });

  test("omits context field (not just undefined) when no context is found or no map given", () => {
    const ranked = [rankedFor("e7")];
    const contextByRef = buildAncestorContextMap(GAUNTLET_TREE);
    const withMap = buildCandidatePacket(ranked, contextByRef);
    const withoutMap = buildCandidatePacket(ranked);

    expect("context" in withMap[0]!).toBe(false);
    expect("context" in withoutMap[0]!).toBe(false);
  });

  test("candidates with no ref (e.g. synthetic) never get a context lookup", () => {
    const noRef: RankedCandidate = { role: "button", name: "Save", selector: "text:Save", strategy: "css", score: 0.5 };
    const contextByRef = buildAncestorContextMap(GAUNTLET_TREE);
    const packet = buildCandidatePacket([noRef], contextByRef);
    expect("context" in packet[0]!).toBe(false);
  });
});
