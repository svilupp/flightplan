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
import type { InteractiveElement, PageSnapshot, SnapshotNode } from "../driver/index.ts";
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
