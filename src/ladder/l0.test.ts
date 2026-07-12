// Tests for L0 — locked-recipe validate + replay (PLAN.md §5 Phase 3).
//
// L0 reads the cached recipe via `ctx.lock`, validates `match{url_glob,sig}` against the current
// page (text-hash + structural skeleton), and replays the recipe. Any miss → escalate to L1.
//
// The STRUCTURE component of the composite `match.sig` is now sourced from the driver
// (`captureStateSignature({ mode:'structure' })`), so tests drive it via the MockDriver's
// structure-signature channel and build the expected sig with `computeMatchSignature` — they do
// NOT import the (deleted) `computeStructureSignature`.

import { describe, expect, test } from "bun:test";
import type { BatchStep, InteractiveElement, PageSnapshot, SnapshotNode } from "../driver/index.ts";
import {
  MockDriver,
  makeFailureBatch,
  makeInteractiveElement,
  makeSnapshot,
  makeSuccessBatch,
} from "../driver/index.ts";
import type { Step } from "../flow/types.ts";
import { computeMaskedTextHash } from "../lock/masked-text.ts";
import { computeMatchSignature } from "../lock/signature.ts";
import { resolveL0 } from "./l0.ts";
import type { CachedRecipe, ResolveContext } from "./types.ts";

const step: Step = { id: "s1", do: "click", target: "Create order" };

const TREE: SnapshotNode[] = [
  { role: "main", ref: "n1", children: [{ role: "button", ref: "n2", name: "Create order" }] },
];
// The interactive element the cached `role:button:Create order` selector resolves to (Layer 3).
const ELEMENTS: InteractiveElement[] = [
  makeInteractiveElement({ ref: "e2", role: "button", name: "Create order" }),
];
const URL = "http://localhost:3000/drift";
const STRUCT_SIG = "/drift|structhash";

function pageSnapshot(): PageSnapshot {
  return makeSnapshot({ url: URL, accessibilityTree: TREE, interactiveElements: ELEMENTS });
}

/**
 * The composite sig L0 will compute for `pageSnapshot()`: the masked-text hash (computed inside
 * flightplan from the snapshot's a11y tree — Layer 1) combined with the mock's structure signature.
 */
function matchingSig(): string {
  return computeMatchSignature(computeMaskedTextHash(pageSnapshot()), STRUCT_SIG);
}

/** A driver whose snapshot + structure signature make `matchingSig()` the current page sig. */
function validDriver(batch = makeSuccessBatch("role:button:Create order")): MockDriver {
  return new MockDriver()
    .setSnapshot(pageSnapshot())
    .setStructureSignature(STRUCT_SIG)
    .setBatchResult(batch);
}

function hookFor(recipe: CachedRecipe): ResolveContext["lock"] {
  return { lookup: () => recipe };
}

describe("L0 — misses (escalate to L1)", () => {
  test("no lock hook → miss", async () => {
    const r = await resolveL0(step, { driver: new MockDriver(), now: () => 0 });
    expect(r.ok).toBe(false);
    expect(r.tier).toBe("L0");
    expect(r.escalate).toBe(true);
    expect(r.replayed).toBeUndefined(); // never reached a replay
  });

  test("lock hook returns undefined → miss", async () => {
    const ctx: ResolveContext = {
      driver: new MockDriver(),
      now: () => 0,
      lock: { lookup: () => undefined },
    };
    expect((await resolveL0(step, ctx)).escalate).toBe(true);
  });

  test("recipe with NO match gate → miss (cannot validate)", async () => {
    const ctx: ResolveContext = {
      driver: new MockDriver(),
      now: () => 0,
      lock: { lookup: () => ({ selector: "[data-testid='create-order']", strategy: "testid" }) },
    };
    const r = await resolveL0(step, ctx);
    expect(r.ok).toBe(false);
    expect(r.escalate).toBe(true);
  });
});

describe("L0 — validate + replay", () => {
  test("url + signature match → HIT, replays the cached recipe", async () => {
    const driver = validDriver();
    const recipe: CachedRecipe = {
      selector: "role:button:Create order",
      strategy: "role_name",
      match: { url_glob: "http://localhost:3000/drift*", sig: matchingSig() },
    };
    const r = await resolveL0(step, { driver, now: () => 0, lock: hookFor(recipe) });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe("L0");
    expect(r.escalate).toBe(false);
    expect(r.durableSelector).toBe("role:button:Create order");
    expect(r.strategy).toBe("role_name");
    expect(r.signatureBasis?.sig).toBe(matchingSig());
    // The recipe was actually replayed via batch.
    expect(driver.callsTo("batch")).toHaveLength(1);
  });

  test("structural fingerprint replay uses the live ref, never the non-actionable token", async () => {
    const driver = validDriver(makeSuccessBatch("ref:e2"));
    const recipe: CachedRecipe = {
      selector: "fingerprint:role=button;name=Create order",
      strategy: "structural_fingerprint",
      match: { url_glob: "http://localhost:3000/drift*", sig: matchingSig() },
    };
    const r = await resolveL0(step, { driver, now: () => 0, lock: hookFor(recipe) });
    expect(r.ok).toBe(true);
    const sent = (driver.callsTo("batch")[0]!.args[0] as BatchStep[])[0]!.selector;
    expect(sent).toEqual(["ref:e2"]);
    expect(sent).not.toContain("fingerprint:role=button;name=Create order");
  });

  test("signature mismatch AND selector no longer resolves → clean MISS (no replay)", async () => {
    // A GENUINE drift: the signature changed AND the cached element is gone from the snapshot, so
    // Layer 3 revalidation cannot rescue it → clean miss → L1 (as before Layer 3).
    const driver = new MockDriver()
      .setSnapshot(makeSnapshot({ url: URL, accessibilityTree: [], interactiveElements: [] }))
      .setStructureSignature(STRUCT_SIG)
      .setBatchResult(makeSuccessBatch("role:button:Create order"));
    const recipe: CachedRecipe = {
      selector: "role:button:Create order",
      strategy: "role_name",
      match: { url_glob: "http://localhost:3000/drift*", sig: "text:STALE|x;struct:/x|y" },
    };
    const r = await resolveL0(step, { driver, now: () => 0, lock: hookFor(recipe) });
    expect(r.ok).toBe(false);
    expect(r.escalate).toBe(true);
    expect(r.revalidated).toBeUndefined();
    expect(r.replayed).toBeUndefined(); // gate failed + revalidation failed before any replay
    // We never replayed (the gate failed and revalidation could not rescue it).
    expect(driver.callsTo("batch")).toHaveLength(0);
  });

  test("url_glob mismatch → MISS (no signature work, no replay)", async () => {
    const driver = validDriver();
    const recipe: CachedRecipe = {
      selector: "role:button:Create order",
      strategy: "role_name",
      match: { url_glob: "http://other.example/*", sig: matchingSig() },
    };
    const r = await resolveL0(step, { driver, now: () => 0, lock: hookFor(recipe) });
    expect(r.ok).toBe(false);
    expect(r.escalate).toBe(true);
    expect(driver.callsTo("batch")).toHaveLength(0);
    // url_glob fails before the sig is even computed.
    expect(driver.callsTo("captureStateSignature")).toHaveLength(0);
  });

  test("validated but replay fails → MISS with replayed:true (escalate to L1 to heal)", async () => {
    const driver = validDriver(makeFailureBatch("missing"));
    const recipe: CachedRecipe = {
      selector: "role:button:Create order",
      strategy: "role_name",
      match: { url_glob: "http://localhost:3000/drift*", sig: matchingSig() },
    };
    const r = await resolveL0(step, { driver, now: () => 0, lock: hookFor(recipe) });
    expect(r.ok).toBe(false);
    expect(r.escalate).toBe(true);
    // It DID attempt the replay (batch) before missing → flagged so L1 re-snapshots.
    expect(r.replayed).toBe(true);
    expect(driver.callsTo("batch")).toHaveLength(1);
  });

  test("L0 reuses a shared snapshot when the orchestrator threads one in (no extra snapshot call)", async () => {
    const driver = validDriver();
    const recipe: CachedRecipe = {
      selector: "role:button:Create order",
      strategy: "role_name",
      match: { url_glob: "http://localhost:3000/drift*", sig: matchingSig() },
    };
    const shared = pageSnapshot();
    const r = await resolveL0(step, { driver, now: () => 0, lock: hookFor(recipe) }, shared);
    expect(r.ok).toBe(true);
    // The shared snapshot was reused → L0 took no snapshot of its own.
    expect(driver.callsTo("snapshot")).toHaveLength(0);
  });
});

describe("L0 — Layer 3 per-target revalidation on signature miss", () => {
  const recipe: CachedRecipe = {
    selector: "role:button:Create order",
    strategy: "role_name",
    // A STALE signature — will NOT match the fresh page sig.
    match: { url_glob: "http://localhost:3000/drift*", sig: "text:STALE|x;struct:/stale|y" },
  };

  test("sig miss + cached selector still uniquely resolves → L0 replay (revalidated hit, no escalation)", async () => {
    const driver = validDriver(); // snapshot still has the button/Create order element
    const r = await resolveL0(step, { driver, now: () => 0, lock: hookFor(recipe) });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe("L0");
    expect(r.escalate).toBe(false);
    // Distinct marker so metrics separate it from a pure signature hit.
    expect(r.revalidated).toBe(true);
    expect(r.error).toContain("l0_revalidated");
    expect(r.durableSelector).toBe("role:button:Create order");
    // It replayed via the normal batch path (0 AI, no L2/L3).
    expect(driver.callsTo("batch")).toHaveLength(1);
    // The FRESH basis is carried so a non-frozen run refreshes the stale stored sig.
    expect(r.signatureBasis?.sig).toBe(matchingSig());
  });

  test("sig miss + selector now ambiguous (>1 match) → clean MISS → L1", async () => {
    // Two elements now match `role:button:Create order` → not uniquely resolvable → clean miss.
    const ambiguous: InteractiveElement[] = [
      makeInteractiveElement({ ref: "e2", role: "button", name: "Create order" }),
      makeInteractiveElement({ ref: "e3", role: "button", name: "Create order" }),
    ];
    const driver = new MockDriver()
      .setSnapshot(
        makeSnapshot({ url: URL, accessibilityTree: TREE, interactiveElements: ambiguous }),
      )
      .setStructureSignature(STRUCT_SIG)
      .setBatchResult(makeSuccessBatch("role:button:Create order"));
    const r = await resolveL0(step, { driver, now: () => 0, lock: hookFor(recipe) });
    expect(r.ok).toBe(false);
    expect(r.escalate).toBe(true);
    expect(r.revalidated).toBeUndefined();
    expect(driver.callsTo("batch")).toHaveLength(0); // never replayed
  });

  test("revalidation falls through to a candidate selector when the head no longer resolves", async () => {
    // The head `role:button:Create order` is gone, but a candidate testid still uniquely resolves.
    const withTestid: InteractiveElement[] = [
      makeInteractiveElement({
        ref: "e9",
        role: "button",
        name: "Create order",
        attributes: { "data-testid": "create-order" },
      }),
    ];
    const driver = new MockDriver()
      .setSnapshot(
        makeSnapshot({ url: URL, accessibilityTree: TREE, interactiveElements: withTestid }),
      )
      .setStructureSignature(STRUCT_SIG)
      .setBatchResult(makeSuccessBatch("[data-testid='create-order']"));
    const recipeWithCandidate: CachedRecipe = {
      selector: "role:button:Ye Olde Label", // head no longer matches (name changed)
      strategy: "role_name",
      candidates: [{ selector: "[data-testid='create-order']", strategy: "testid" }],
      match: { url_glob: "http://localhost:3000/drift*", sig: "text:STALE|x;struct:/stale|y" },
    };
    const r = await resolveL0(step, { driver, now: () => 0, lock: hookFor(recipeWithCandidate) });
    expect(r.ok).toBe(true);
    expect(r.revalidated).toBe(true);
    expect(driver.callsTo("batch")).toHaveLength(1);
  });

  test("portfolio race attaches an agreement outcome on a signature HIT (2 strategies agree)", async () => {
    // The button carries a testid AND resolves by role+name → two portfolio strategies agree.
    const els: InteractiveElement[] = [
      makeInteractiveElement({
        ref: "e2",
        role: "button",
        name: "Create order",
        attributes: { "data-testid": "create-order" },
      }),
    ];
    const driver = new MockDriver()
      .setSnapshot(makeSnapshot({ url: URL, accessibilityTree: TREE, interactiveElements: els }))
      .setStructureSignature(STRUCT_SIG)
      .setBatchResult(makeSuccessBatch("[data-testid='create-order']"));
    const recipe: CachedRecipe = {
      selector: "[data-testid='create-order']",
      strategy: "testid",
      match: { url_glob: "http://localhost:3000/drift*", sig: matchingSig() },
      strategies: [
        { kind: "testid", selector: "[data-testid='create-order']", greens: 5 },
        { kind: "role_name", selector: "role:button:Create order", greens: 3 },
      ],
    };
    const r = await resolveL0(step, { driver, now: () => 0, lock: hookFor(recipe) });
    expect(r.ok).toBe(true);
    expect(r.portfolio?.agreement).toBe("2/2");
    expect(r.portfolio?.agreed).toHaveLength(2);
    expect(r.portfolio?.drifted).toHaveLength(0);
  });

  test("struct-only mode: signature 'miss' on text but struct unchanged → HIT (not revalidated)", async () => {
    // In struct-only mode the (masked) text drift is ignored: struct matches → a pure signature
    // hit, so `revalidated` stays unset.
    const driver = validDriver();
    const structOnlyRecipe: CachedRecipe = {
      selector: "role:button:Create order",
      strategy: "role_name",
      // text differs, struct is the live one → struct-only should treat this as a hit.
      match: {
        url_glob: "http://localhost:3000/drift*",
        sig: computeMatchSignature("http://localhost:3000/drift|OLDTEXT", STRUCT_SIG),
      },
    };
    const r = await resolveL0(step, {
      driver,
      now: () => 0,
      lock: hookFor(structOnlyRecipe),
      cache: { signature: "struct-only" },
    });
    expect(r.ok).toBe(true);
    expect(r.revalidated).toBeUndefined(); // matched by struct-only signature, not Layer 3
    expect(driver.callsTo("batch")).toHaveLength(1);
  });
});

describe("L0 — actionability + discrimination gate (Tasks B/C)", () => {
  /** The first selector browser-pilot was handed in the (single) replay batch, if any. */
  function firstReplaySelector(driver: MockDriver): string | undefined {
    const call = driver.callsTo("batch")[0];
    if (!call) return undefined;
    const sel = (call.args[0] as BatchStep[])[0]?.selector;
    return Array.isArray(sel) ? sel[0] : sel;
  }

  test("Task C: non-discriminating recipe (role-only over many buttons) → clean MISS, never replays", async () => {
    // An ai_pick persisted a NON-DISCRIMINATING `role:button` over an icon toolbar. A warm replay
    // would race `role:button`, match all buttons, and click the FIRST (Bold) — mis-acting. The gate
    // must SKIP L0 (escalate → vision) instead of blindly replaying the wrong element.
    const tree: SnapshotNode[] = [
      {
        role: "main",
        ref: "n1",
        children: [
          { role: "button", ref: "n2", name: "Bold" },
          { role: "button", ref: "n3", name: "Italic" },
        ],
      },
    ];
    const elements: InteractiveElement[] = [
      makeInteractiveElement({ ref: "e2", role: "button", name: "Bold" }),
      makeInteractiveElement({ ref: "e3", role: "button", name: "Italic" }),
    ];
    const url = "http://localhost:3000/icon-editor";
    const structSig = "/icon-editor|s";
    const snap = makeSnapshot({ url, accessibilityTree: tree, interactiveElements: elements });
    const sig = computeMatchSignature(computeMaskedTextHash(snap), structSig);
    const driver = new MockDriver()
      .setSnapshot(snap)
      .setStructureSignature(structSig)
      // If it (wrongly) replayed, bp would report clicking the first button — this must NOT happen.
      .setBatchResult(makeSuccessBatch("role:button"));
    const recipe: CachedRecipe = {
      selector: "role:button",
      strategy: "role_name",
      match: { url_glob: "http://localhost:3000/icon-editor*", sig },
      strategies: [{ kind: "role_name", selector: "role:button", greens: 3 }],
    };
    const iconStep: Step = { id: "pick-italic", do: "ai_pick", target: "the italic button" };
    const r = await resolveL0(iconStep, { driver, now: () => 0, lock: hookFor(recipe) });
    expect(r.ok).toBe(false);
    expect(r.escalate).toBe(true);
    expect(r.replayed).toBeUndefined(); // gated BEFORE any replay → no page mutation
    expect(driver.callsTo("batch")).toHaveLength(0); // never mis-clicked
  });

  test("Fix 1 target-identity: a RIVAL-element sibling is dropped — the PRIMARY leads, never the rival", async () => {
    // The polluted portfolio carries a fuzzy sibling (`role:button:Submit`) that resolves to a
    // DIFFERENT element than the recipe's PRIMARY (`[data-testid='save']` → the Save button). The
    // replay must LEAD WITH THE PRIMARY and DROP the rival — never resolve/click the wrong element
    // (the measured admin-crud bug where a rival `bulk-delete` won the `check_row_u2` race).
    const tree: SnapshotNode[] = [
      {
        role: "main",
        ref: "n1",
        children: [
          { role: "button", ref: "n2", name: "Save" },
          { role: "button", ref: "n3", name: "Submit" },
        ],
      },
    ];
    const elements: InteractiveElement[] = [
      makeInteractiveElement({
        ref: "e2",
        role: "button",
        name: "Save",
        attributes: { "data-testid": "save" },
      }),
      makeInteractiveElement({ ref: "e3", role: "button", name: "Submit" }),
    ];
    const url = "http://localhost:3000/admin";
    const structSig = "/admin|s";
    const snap = makeSnapshot({ url, accessibilityTree: tree, interactiveElements: elements });
    const sig = computeMatchSignature(computeMaskedTextHash(snap), structSig);
    const driver = new MockDriver()
      .setSnapshot(snap)
      .setStructureSignature(structSig)
      .setBatchResult(makeSuccessBatch("[data-testid='save']"));
    const recipe: CachedRecipe = {
      selector: "[data-testid='save']", // PRIMARY → the Save button (the recipe's intended element)
      strategy: "testid",
      match: { url_glob: "http://localhost:3000/admin*", sig },
      strategies: [
        { kind: "testid", selector: "[data-testid='save']", greens: 5 },
        { kind: "role_name", selector: "role:button:Submit", greens: 1 }, // RIVAL (different element)
      ],
    };
    const r = await resolveL0(
      { id: "s1", do: "click", target: "Save" },
      { driver, now: () => 0, lock: hookFor(recipe) },
    );
    expect(r.ok).toBe(true);
    expect(driver.callsTo("batch")).toHaveLength(1);
    // The PRIMARY leads; the rival `role:button:Submit` was DROPPED (never sent to the batch).
    const sent = (driver.callsTo("batch")[0]!.args[0] as BatchStep[])[0]!.selector as string[];
    expect(firstReplaySelector(driver)).toBe("[data-testid='save']");
    expect(sent).not.toContain("role:button:Submit");
    // The rival is stamped as drift so it sinks and never leads a future replay.
    expect(r.portfolio?.drifted.map((d) => d.selector)).toContain("role:button:Submit");
  });

  test("Fix 1 compound primary: a scoped hint leads ALONE on a sig miss; a resolvable rival never wins", async () => {
    // The admin-crud `check_row_u2` shape: PRIMARY is a compound scoped hint
    // `[data-row-id='u2'] [data-testid='row-check']` (not AX-identity-resolvable), and the polluted
    // portfolio carries a fuzzy sibling `[data-testid='bulk-delete']` that DOES uniquely resolve to a
    // DIFFERENT element. Every warm step here hits a signature MISS (table re-renders). The replay
    // must LEAD WITH THE PRECISE SCOPED PRIMARY and DROP bulk-delete — not race to the rival.
    const tree: SnapshotNode[] = [
      {
        role: "main",
        ref: "n1",
        children: [
          { role: "checkbox", ref: "n2", name: "" },
          { role: "button", ref: "n3", name: "Delete selected" },
        ],
      },
    ];
    const elements: InteractiveElement[] = [
      makeInteractiveElement({ ref: "e2", role: "checkbox", name: "" }),
      makeInteractiveElement({
        ref: "e3",
        role: "button",
        name: "Delete selected",
        attributes: { "data-testid": "bulk-delete" },
      }),
    ];
    const url = "http://localhost:3100/admin-crud";
    const structSig = "/admin-crud|q65dns";
    const snap = makeSnapshot({ url, accessibilityTree: tree, interactiveElements: elements });
    const driver = new MockDriver()
      .setSnapshot(snap)
      .setStructureSignature(structSig)
      .setBatchResult(makeSuccessBatch("[data-row-id='u2'] [data-testid='row-check']"));
    const recipe: CachedRecipe = {
      selector: "[data-row-id='u2'] [data-testid='row-check']",
      strategy: "testid",
      // STALE sig → signature MISS (as every warm admin-crud step sees).
      match: { url_glob: "http://localhost:3100/admin-crud*", sig: "text:STALE|x;struct:/x|y" },
      strategies: [
        { kind: "testid", selector: "[data-row-id='u2'] [data-testid='row-check']", greens: 1 },
        { kind: "testid", selector: '[data-testid="bulk-delete"]', greens: 0 },
      ],
    };
    const iconStep: Step = {
      id: "check_row_u2",
      do: "click",
      target: ["[data-row-id='u2'] [data-testid='row-check']", "the checkbox on Bruno's row"],
    };
    const r = await resolveL0(iconStep, { driver, now: () => 0, lock: hookFor(recipe) });
    expect(r.ok).toBe(true);
    expect(r.revalidated).toBe(true);
    expect(driver.callsTo("batch")).toHaveLength(1);
    const sent = (driver.callsTo("batch")[0]!.args[0] as BatchStep[])[0]!.selector as string[];
    // The scoped primary leads ALONE; the rival bulk-delete is dropped (never sent to the batch).
    expect(firstReplaySelector(driver)).toBe("[data-row-id='u2'] [data-testid='row-check']");
    expect(sent).not.toContain('[data-testid="bulk-delete"]');
    expect(r.portfolio?.drifted.map((d) => d.selector)).toContain('[data-testid="bulk-delete"]');
  });

  test("Fix 2 positional: a `role:button[N]` primary is DISCRIMINATING and replays at L0", async () => {
    // An ai_pick over an icon toolbar persisted a POSITIONAL `role:button[2]` (the 2nd icon). It
    // resolves to exactly ONE element (not the non-discriminating `role:button` mis-click) and warm
    // replays deterministically at L0 with zero model calls.
    const tree: SnapshotNode[] = [
      {
        role: "main",
        ref: "n1",
        children: [
          { role: "button", ref: "n2", name: "" },
          { role: "button", ref: "n3", name: "" },
          { role: "button", ref: "n4", name: "" },
        ],
      },
    ];
    const elements: InteractiveElement[] = [
      makeInteractiveElement({ ref: "e2", role: "button", name: "" }),
      makeInteractiveElement({ ref: "e3", role: "button", name: "" }),
      makeInteractiveElement({ ref: "e4", role: "button", name: "" }),
    ];
    const url = "http://localhost:3100/icon-editor";
    const structSig = "/icon-editor|5lzjpx";
    const snap = makeSnapshot({ url, accessibilityTree: tree, interactiveElements: elements });
    const sig = computeMatchSignature(computeMaskedTextHash(snap), structSig);
    const driver = new MockDriver()
      .setSnapshot(snap)
      .setStructureSignature(structSig)
      .setBatchResult(makeSuccessBatch("role:button[2]"));
    const recipe: CachedRecipe = {
      selector: "role:button[2]",
      strategy: "role_name",
      match: { url_glob: "http://localhost:3100/icon-editor*", sig },
      strategies: [{ kind: "role_name", selector: "role:button[2]", greens: 2 }],
    };
    const iconStep: Step = { id: "click_italic", do: "ai_pick", target: "the italic icon" };
    const r = await resolveL0(iconStep, { driver, now: () => 0, lock: hookFor(recipe) });
    expect(r.ok).toBe(true);
    expect(r.escalate).toBe(false);
    expect(r.durableSelector).toBe("role:button[2]");
    expect(driver.callsTo("batch")).toHaveLength(1);
    expect(firstReplaySelector(driver)).toBe("role:button[2]");
  });

  test("non-regression: a GOOD unique-enabled warm hit replays with the ORIGINAL lead unchanged", async () => {
    // The winner uniquely resolves to an enabled element → the gate is a no-op (order preserved).
    const driver = validDriver();
    const recipe: CachedRecipe = {
      selector: "role:button:Create order",
      strategy: "role_name",
      match: { url_glob: "http://localhost:3000/drift*", sig: matchingSig() },
      strategies: [{ kind: "role_name", selector: "role:button:Create order", greens: 4 }],
    };
    const r = await resolveL0(step, { driver, now: () => 0, lock: hookFor(recipe) });
    expect(r.ok).toBe(true);
    expect(driver.callsTo("batch")).toHaveLength(1);
    expect(firstReplaySelector(driver)).toBe("role:button:Create order");
  });
});
