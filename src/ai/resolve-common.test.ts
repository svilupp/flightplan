// Flightplan — candidate-context tests (P6 plan item #3: gauntlet L2→L3 tier mismatch).
//
// OFFLINE, deterministic: no driver/network involved. Exercises `buildAncestorContextMap` (the
// accessibility-tree walk that derives nearest-heading/landmark context per `ref`) and
// `buildCandidatePacket` (which attaches that context onto the index-numbered packet) directly
// against hand-built `SnapshotNode[]` / `RankedCandidate[]` fixtures — the same shapes
// `gatherCandidates` produces from a real `driver.snapshot()`.

import { describe, expect, test } from "bun:test";
import type { SnapshotNode } from "browser-pilot";
import {
  type BatchStep,
  MockDriver,
  makeInteractiveElement,
  makeRankedCandidate,
  makeSuccessBatch,
} from "../driver/index.ts";
import type { Step } from "../flow/types.ts";
import type { RankedCandidate, ResolveContext } from "../ladder/index.ts";
import { actOnPick, buildAncestorContextMap, buildCandidatePacket } from "./resolve-common.ts";

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
  return {
    ref,
    role: "button",
    name,
    selector: `role:button:${name}`,
    strategy: "role_name",
    score: 0.9,
  };
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
    const noRef: RankedCandidate = {
      role: "button",
      name: "Save",
      selector: "text:Save",
      strategy: "css",
      score: 0.5,
    };
    const contextByRef = buildAncestorContextMap(GAUNTLET_TREE);
    const packet = buildCandidatePacket([noRef], contextByRef);
    expect("context" in packet[0]!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// actOnPick — AI-tier pick candidate ORDERING (the ref-first handoff)
// ---------------------------------------------------------------------------
//
// The AI tier's contract: the model chose THIS specific element by index off a FRESH snapshot
// (page unchanged), so its `ref` is authoritative and non-stale. For a NAMELESS icon element the
// native-ranked `chosen.selector` is the bare, NON-UNIQUE `role:<role>` — ordering that first would
// let browser-pilot's order-honoring `findElement` resolve the FIRST same-role element before the
// ref is ever tried (the candidate-ordering bug). So the action array MUST lead with `ref:eN`.

const clickStep = (id: string, target: string): Step => ({ id, do: "click", target }) as Step;

function ctxFor(driver: MockDriver): ResolveContext {
  return { driver, now: () => 0 };
}

/** The ordered selector array the (single) batch step was built with. */
function batchSelectors(driver: MockDriver): string[] {
  const call = driver.callsTo("batch")[0];
  const steps = call?.args[0] as BatchStep[] | undefined;
  const selector = steps?.[0]?.selector;
  return Array.isArray(selector) ? selector : selector ? [selector] : [];
}

describe("actOnPick — AI-tier pick candidate ordering", () => {
  test("nameless icon pick leads with ref:<chosen>, not the bare non-unique role selector", async () => {
    // Two NAMELESS icon buttons; native ranking gives each the bare, non-unique `role:button`.
    // The model chose index 1 (e2 — the trash icon), so the action must target e2's ref FIRST.
    const elements = [
      makeInteractiveElement({
        ref: "e1",
        role: "button",
        name: "",
        attributes: { "data-testid": "save" },
      }),
      makeInteractiveElement({
        ref: "e2",
        role: "button",
        name: "",
        attributes: { "data-testid": "trash" },
      }),
    ];
    const ranked: RankedCandidate[] = [
      makeRankedCandidate({
        ref: "e1",
        role: "button",
        name: "",
        selector: "role:button",
        score: 0.3,
      }),
      makeRankedCandidate({
        ref: "e2",
        role: "button",
        name: "",
        selector: "role:button",
        score: 0.3,
      }),
    ];

    const d = new MockDriver();
    // browser-pilot honors ORDER: with ref-first it resolves e2 via the ref and reports `ref:e2`.
    d.enqueueBatchResult(makeSuccessBatch("ref:e2"));

    const exec = await actOnPick(clickStep("s1", "trash icon"), ctxFor(d), {
      tier: "L3",
      chosen: ranked[1]!,
      elements,
      ranked,
      signatureBasis: { sig: "sig", url: "http://x/icons" },
      intentText: "trash icon",
      action: "click",
    });

    // (1) The action array leads with the authoritative ref — NOT the bare `role:button`.
    const selectors = batchSelectors(d);
    expect(selectors[0]).toBe("ref:e2");
    expect(selectors).toEqual(["ref:e2", "role:button"]);

    // (2) Lock learning re-derives a DURABLE selector from the CHOSEN element (e2's testid), because
    // `selectorUsedToStrategy("ref:e2")` is null. It must be e2's testid, never the bare `role:button`.
    expect(exec.ok).toBe(true);
    expect(exec.tier).toBe("L3");
    expect(exec.strategy).toBe("testid");
    expect(exec.durableSelector).toBe("[data-testid='trash']");
    expect(exec.durableSelector).not.toBe("role:button");
    expect(exec.pinnedLabel).toBeUndefined(); // nameless → no pinned label
  });

  test("a pick with NO ref emits only the selector (never ref:undefined)", async () => {
    const chosen = makeRankedCandidate({
      role: "button",
      name: "Save",
      selector: "role:button:Save",
    }); // no `ref`
    const d = new MockDriver();
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save"));

    const exec = await actOnPick(clickStep("s1", "save"), ctxFor(d), {
      tier: "L2",
      chosen,
      elements: [],
      ranked: [chosen],
      signatureBasis: { sig: "sig", url: "http://x" },
      intentText: "save",
      action: "click",
    });

    const selectors = batchSelectors(d);
    expect(selectors).toEqual(["role:button:Save"]); // exactly one entry, no ref rung
    expect(selectors.some((s) => s.includes("ref:undefined"))).toBe(false);
    expect(exec.ok).toBe(true);
    expect(exec.strategy).toBe("role_name");
  });
});
