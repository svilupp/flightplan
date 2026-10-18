import { expect, test } from "bun:test";
import { executeOwnerAction, OwnerActionError } from "./owner-actions.ts";
import type { OwnerActionPort, OwnerAssurance } from "./owner-contract.ts";

function fixture(assurance: OwnerAssurance = "owner-serialized-prechecked-native") {
  const calls: string[] = [];
  const port: OwnerActionPort = {
    capabilities: async () => ({
      version: 1,
      profile: "strict",
      assurance,
      actions: ["click"],
      reads: ["state"],
      images: false,
    }),
    observe: async () => {
      throw new Error("unused");
    },
    prepare: async ({ pageTargetId }) => {
      calls.push("prepare");
      return {
        preparedId: "owner-prepared",
        pageTargetId,
        documentId: "doc",
        policyVersion: "global-v1",
        assurance,
        evidence: {
          pageTargetId,
          documentId: "doc",
          url: "https://fixture.test",
          title: "fixture",
          text: "",
          observedAt: 1,
          action: "click",
        },
      };
    },
    authorize: async ({ preparedId }) => {
      expect(preparedId).toBe("owner-prepared");
      calls.push("authorize");
      return { verdict: "allow", approvalId: "owner-approval", reason: "allowed" };
    },
    dispatch: async ({ approvalId }) => {
      expect(approvalId).toBe("owner-approval");
      calls.push("dispatch");
      return {
        dispatchState: "dispatched",
        retrySafe: false,
        inputEventsSent: ["mousePressed", "mouseReleased"],
        assurance,
      };
    },
  };
  return { port, calls };
}
test("native owner capabilities cannot downgrade default strict assurance", async () => {
  const { port, calls } = fixture();
  await expect(
    executeOwnerAction(port, "page", { kind: "click", selector: "#pay" }),
  ).rejects.toThrow("capability_unavailable");
  expect(calls).toEqual([]);
});
test("explicit native host policy consumes owner handles in order", async () => {
  const { port, calls } = fixture();
  const receipt = await executeOwnerAction(
    port,
    "page",
    { kind: "click", selector: "#pay" },
    "owner-serialized-prechecked-native",
  );
  expect(calls).toEqual(["prepare", "authorize", "dispatch"]);
  expect(receipt.dispatchState).toBe("dispatched");
});
for (const verdict of ["deny", "unknown"] as const)
  test(`${verdict} owner verdict never dispatches`, async () => {
    const { port, calls } = fixture("renderer-same-task-dom");
    port.authorize = async () => ({ verdict, reason: "policy" });
    await expect(
      executeOwnerAction(port, "page", { kind: "click", selector: "#pay" }),
    ).rejects.toThrow("approval_unavailable");
    expect(calls).toEqual(["prepare"]);
  });
test("post-send owner reply failure is uncertain and never retried", async () => {
  const { port, calls } = fixture("renderer-same-task-dom");
  port.dispatch = async () => {
    calls.push("dispatch");
    throw new Error("connection lost");
  };
  const error = await executeOwnerAction(port, "page", { kind: "click", selector: "#pay" }).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OwnerActionError);
  expect((error as OwnerActionError).dispatchState).toBe("uncertain");
  expect(calls.filter((call) => call === "dispatch")).toHaveLength(1);
});
test("prepared handle for another page is rejected before authorization", async () => {
  const { port, calls } = fixture("renderer-same-task-dom");
  const prepare = port.prepare.bind(port);
  port.prepare = async (request) => ({ ...(await prepare(request)), pageTargetId: "other" });
  await expect(
    executeOwnerAction(port, "page", { kind: "click", selector: "#pay" }),
  ).rejects.toThrow("preparation_invalid");
  expect(calls).toEqual(["prepare"]);
});

test("preparation transport refusal preserves no-dispatch and omits opaque server error payload", async () => {
  const { port, calls } = fixture("renderer-same-task-dom");
  port.prepare = async () => {
    throw new Error("opaque-private-value");
  };
  const error = await executeOwnerAction(port, "page", { kind: "click", selector: "#pay" }).catch(
    (value: unknown) => value,
  );
  expect(error).toBeInstanceOf(OwnerActionError);
  expect((error as OwnerActionError).dispatchState).toBe("not_dispatched");
  expect(String(error)).not.toContain("opaque-private-value");
  expect(calls).toEqual([]);
});
