import { expect, test } from "bun:test";
import type { Page } from "browser-pilot/core";
import { runYield } from "../runner/checkpoints.ts";
import type { NamedSessionBorrow } from "./named-session.ts";
import { createNamedSessionYieldHost } from "./named-session-yield.ts";

function fixture(handbackConfirmed = true) {
  const events: string[] = [];
  let sequence = 1;
  let owned = true;
  const identity = () => ({
    ownerEpoch: "owner",
    grantToken: String(sequence),
    pageIdentity: "page",
  });
  const host = createNamedSessionYieldHost({
    session: "fixture",
    binding: "fixture-binding",
    borrow: async (request) => {
      expect(request.recovery).toBe("never");
      if (owned) throw new Error("busy");
      owned = true;
      sequence++;
      events.push("host-acquire");
      return {
        ownerEpoch: "owner",
        fencingToken: String(sequence),
        page: { targetId: "page" } as Page,
        handback: async ({ targetId }) => {
          events.push(`host-handback:${targetId}`);
          return {
            confirmed: handbackConfirmed,
            ownerEpoch: "owner",
            targetId,
            refsInvalidated: true,
            pendingActions: "drained",
            bindingRevision: 1,
            observationEpoch: "observation",
          };
        },
        detach: async () => {
          events.push("host-detach");
          owned = false;
        },
      } as NamedSessionBorrow;
    },
    flightplan: {
      currentIdentity: async () => identity(),
      release: async () => {
        events.push("fp-release");
        owned = false;
      },
      acquire: async () => {
        expect(owned).toBe(false);
        sequence++;
        owned = true;
        events.push("fp-acquire");
        return identity();
      },
      refresh: async () => {
        events.push("fp-refresh");
      },
    },
    perform: async () => {
      events.push("host-task");
      return { pageIdentity: "page" };
    },
    verifyReturn: async () => {
      events.push("verify");
      return true;
    },
  });
  return { host, events };
}
test("named host yield hands back and detaches before fresh FP lease and observations", async () => {
  const { host, events } = fixture();
  await runYield(host, { task: "inspect", stepId: "host", recipeBinding: "recipe", receipts: [] });
  expect(events).toEqual([
    "fp-release",
    "host-acquire",
    "host-task",
    "host-handback:page",
    "host-detach",
    "fp-acquire",
    "fp-refresh",
    "verify",
  ]);
});
test("unknown host handback detaches but never reacquires Flightplan", async () => {
  const { host, events } = fixture(false);
  await expect(
    runYield(host, { task: "inspect", stepId: "host", recipeBinding: "recipe", receipts: [] }),
  ).rejects.toThrow("yield_failed");
  expect(events.filter((event) => event === "host-detach")).toHaveLength(1);
  expect(events).not.toContain("fp-acquire");
});
