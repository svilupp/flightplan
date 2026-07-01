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
import { MockDriver, makeSnapshot, makeSuccessBatch, makeFailureBatch } from "../driver/index.ts";
import type { PageSnapshot, SnapshotNode } from "../driver/index.ts";
import type { ClickStep, Step } from "../flow/types.ts";
import { computeMatchSignature } from "../lock/signature.ts";
import { resolveL0 } from "./l0.ts";
import type { CachedRecipe, ResolveContext } from "./types.ts";

const step: Step = { id: "s1", do: "click", target: "Create order" } as ClickStep;

const TREE: SnapshotNode[] = [{ role: "main", ref: "n1", children: [{ role: "button", ref: "n2" }] }];
const URL = "http://localhost:3000/drift";
const TEXT_SIG = `${URL}|texthash`;
const STRUCT_SIG = "/drift|structhash";

function pageSnapshot(): PageSnapshot {
  return makeSnapshot({ url: URL, accessibilityTree: TREE });
}

/** The composite sig L0 will compute given the mock's configured text + structure signatures. */
function matchingSig(): string {
  return computeMatchSignature(TEXT_SIG, STRUCT_SIG);
}

/** A driver whose snapshot + text/structure signatures make `matchingSig()` the current page sig. */
function validDriver(batch = makeSuccessBatch("role:button:Create order")): MockDriver {
  return new MockDriver()
    .setSnapshot(pageSnapshot())
    .setSignature(TEXT_SIG)
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
    const ctx: ResolveContext = { driver: new MockDriver(), now: () => 0, lock: { lookup: () => undefined } };
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

  test("signature mismatch → MISS (re-resolve at L1), no replay attempted", async () => {
    const driver = validDriver();
    const recipe: CachedRecipe = {
      selector: "role:button:Create order",
      strategy: "role_name",
      match: { url_glob: "http://localhost:3000/drift*", sig: "text:STALE|x;struct:/x|y" },
    };
    const r = await resolveL0(step, { driver, now: () => 0, lock: hookFor(recipe) });
    expect(r.ok).toBe(false);
    expect(r.escalate).toBe(true);
    expect(r.replayed).toBeUndefined(); // gate failed before any replay
    // We never replayed (the gate failed first).
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
