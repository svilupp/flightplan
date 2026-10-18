import { expect, test } from "bun:test";
import { ownerRestrictions } from "./owner-restrictions.ts";

test("local navigation restriction receives owner-prepared destination and cannot claim dispatch", async () => {
  let destination: string | undefined;
  let dispatched: boolean | "unknown" | undefined;
  const restriction = ownerRestrictions(
    {
      mode: "enforce",
      policyVersion: "local",
      requiredAssurance: "owner-serialized-prechecked-native",
      evaluate: async (proposal) => {
        destination = proposal.navigationUrl;
        return { decision: "allow", reason: "allowed" };
      },
      onObservation: (record) => {
        dispatched = record.dispatched;
      },
    },
    (text) => text,
  );
  await restriction.beforeAuthorize({
    preparedId: "prepared",
    pageTargetId: "page",
    documentId: "doc",
    policyVersion: "root",
    assurance: "owner-serialized-prechecked-native",
    evidence: {
      pageTargetId: "page",
      documentId: "doc",
      url: "https://fixture.test/start",
      title: "",
      text: "",
      observedAt: 1,
      action: "goto",
      destination: "https://fixture.test/next",
    },
  });
  expect(destination).toBe("https://fixture.test/next");
  expect(dispatched).toBe("unknown");
});
