import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfigWithDefaults } from "../config/index.ts";
import { createGuardedDriver } from "../guard/driver.ts";
import { runFlow } from "../runner/runner.ts";
import { OwnerActionDriver, type OwnerActionLease } from "./owner-action-driver.ts";
import type { OwnerActionPort } from "./owner-contract.ts";

function fixture(allowed = true) {
  let dispatched = 0;
  const events: string[] = [];
  const assurance = "owner-serialized-prechecked-native" as const;
  const state = {
    pageTargetId: "page",
    documentId: "doc",
    url: "https://fixture.test",
    title: "Fixture",
    text: "Increment",
    observedAt: 1,
  };
  const port: OwnerActionPort = {
    capabilities: async () => ({
      version: 1,
      profile: "strict",
      assurance,
      actions: ["click", "fill", "goto"],
      reads: ["state", "snapshot", "element"],
      images: false,
    }),
    observe: async ({ kind }) => ({
      ...state,
      ...(kind === "snapshot"
        ? {
            nodes: [
              {
                selector: "#increment",
                role: "button",
                name: "Increment",
                text: "Increment",
                visible: true,
                enabled: true,
                attributes: { id: "increment" },
              },
            ],
          }
        : {}),
      ...(kind === "element"
        ? {
            element: {
              exists: true,
              count: 1,
              text: "Increment",
              visible: true,
              boundingBox: { x: 0, y: 0, width: 10, height: 10 },
            },
          }
        : {}),
    }),
    prepare: async ({ action, pageTargetId }) => {
      events.push(`prepare:${action.kind}`);
      return {
        preparedId: "p",
        pageTargetId,
        documentId: "doc",
        assurance,
        policyVersion: "owner-global",
        evidence: { ...state, action: action.kind },
      };
    },
    authorize: async () => ({
      verdict: allowed ? "allow" : "deny",
      ...(allowed ? { approvalId: "approval" } : {}),
      reason: "owner_policy",
    }),
    dispatch: async () => {
      dispatched++;
      return {
        dispatchState: "dispatched",
        retrySafe: false,
        inputEventsSent: ["mousePressed", "mouseReleased"],
        assurance,
      };
    },
  };
  const lease: OwnerActionLease = {
    port,
    pageTargetId: "page",
    ownerEpoch: "epoch",
    grantToken: "grant",
    handback: async () => {
      events.push("handback");
    },
    detach: async () => {
      events.push("detach");
    },
  };
  return { lease, events, dispatched: () => dispatched };
}
const config = {
  mode: "session",
  session_ref: "fixture",
  target_policy: "exact",
  target_id: "page",
} as const;
test("restricted driver rejects raw and unsupported capabilities without owner dispatch", async () => {
  const f = fixture();
  const driver = new OwnerActionDriver({
    acquire: async () => f.lease,
    requiredAssurance: "owner-serialized-prechecked-native",
  });
  await driver.connect(config);
  for (const action of [
    () => driver.page(),
    () => driver.evaluateExpression(),
    () => driver.screenshot(),
    () => driver.press("Enter"),
    () => driver.click(["#increment", "#other"]),
  ])
    await expect(action()).rejects.toThrow();
  expect(f.dispatched()).toBe(0);
  await driver.teardown();
  expect(f.events).toEqual(["handback", "detach"]);
});
test("restricted snapshot mapping uses owner projections and locally scoped refs", async () => {
  const f = fixture();
  const driver = new OwnerActionDriver({
    acquire: async () => f.lease,
    requiredAssurance: "owner-serialized-prechecked-native",
  });
  await driver.connect(config);
  const snapshot = await driver.snapshot({ attributes: true });
  expect(snapshot.interactiveElements[0]).toMatchObject({
    ref: "e1",
    selector: "#increment",
    name: "Increment",
    attributes: { id: "increment" },
  });
  expect(await driver.click("ref:e1")).toBe(true);
  expect(f.dispatched()).toBe(1);
  await driver.teardown();
  await expect(driver.click("ref:e1")).rejects.toThrow();
});
for (const allowed of [true, false])
  test(`recipe owner policy ${allowed ? "allows" : "denies"} even when flow declares observe`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "fp-owner-driver-"));
    const f = fixture(allowed);
    try {
      const flow = join(dir, "flow.toml");
      await Bun.write(
        flow,
        'version=1\nkind="flow"\nid="owner.test"\ndescription="owner fixture"\n[[steps]]\nid="click"\ndo="click"\ntarget="css:#increment"\neffect="observe"\n',
      );
      const result = await runFlow({
        flowPath: flow,
        out: join(dir, "runs"),
        config: resolveConfigWithDefaults([{ connect: config, browser: { dialog: "fail" } }]),
        driverFactory: () =>
          new OwnerActionDriver({
            acquire: async () => f.lease,
            requiredAssurance: "owner-serialized-prechecked-native",
          }),
        env: {},
        noLockWrite: true,
      });
      expect({ summary: result.summary, events: f.events }).toMatchObject({
        summary: { verdict: allowed ? "passed" : "failed" },
      });
      expect(f.dispatched()).toBe(allowed ? 1 : 0);
      expect(f.events.slice(-2)).toEqual(["handback", "detach"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

for (const decision of ["allow", "deny", "unknown"] as const)
  test(`local ${decision} intersects owner policy through prepared evidence`, async () => {
    const f = fixture();
    let seen = "";
    let observedDispatch: boolean | "unknown" | undefined;
    const raw = new OwnerActionDriver({
      acquire: async () => f.lease,
      requiredAssurance: "owner-serialized-prechecked-native",
    });
    const guarded = createGuardedDriver(
      raw,
      {
        mode: "enforce",
        policyVersion: "extra",
        requiredAssurance: "owner-serialized-prechecked-native",
        onObservation: (observation) => {
          observedDispatch = observation.dispatched;
        },
        evaluate: async (proposal) => {
          seen = proposal.evidence.text;
          return { decision, reason: "restriction" };
        },
      },
      (text) => text,
    );
    await guarded.connect(config);
    if (decision === "allow") expect(await guarded.click("#increment")).toBe(true);
    else await expect(guarded.click("#increment")).rejects.toThrow("restriction");
    expect(seen).toBe("Increment");
    expect(observedDispatch).toBe(decision === "allow" ? "unknown" : false);
    expect(f.dispatched()).toBe(decision === "allow" ? 1 : 0);
    await guarded.teardown();
  });
test("local allow cannot widen installed owner deny", async () => {
  const f = fixture(false);
  const raw = new OwnerActionDriver({
    acquire: async () => f.lease,
    requiredAssurance: "owner-serialized-prechecked-native",
  });
  const guarded = createGuardedDriver(
    raw,
    {
      mode: "enforce",
      policyVersion: "extra",
      requiredAssurance: "owner-serialized-prechecked-native",
      evaluate: async () => ({ decision: "allow", reason: "local_allow" }),
    },
    (text) => text,
  );
  await guarded.connect(config);
  await expect(guarded.click("#increment")).rejects.toThrow("approval_unavailable");
  expect(f.dispatched()).toBe(0);
  await guarded.teardown();
});
test("unsupported batch semantics and automatic dialog dismissal fail before owner preparation", async () => {
  const f = fixture();
  const driver = new OwnerActionDriver({
    acquire: async () => f.lease,
    requiredAssurance: "owner-serialized-prechecked-native",
  });
  await driver.connect(config);
  await expect(driver.setDialogPolicy("dismiss")).rejects.toThrow();
  await expect(
    driver.batch([{ action: "click", selector: "#increment", waitForNavigation: true }]),
  ).rejects.toThrow("batch_step_options_unsupported");
  await expect(
    driver.batch([{ action: "click", selector: "#increment" }], { onFail: "continue" }),
  ).rejects.toThrow("batch_options_unsupported");
  await expect(driver.click("#increment", { waitForNavigation: true })).rejects.toThrow(
    "action_options_unsupported",
  );
  await expect(driver.press("Enter", { modifiers: ["Control"] })).rejects.toThrow(
    "action_options_unsupported",
  );
  expect(f.events).toEqual([]);
  await driver.teardown();
});
