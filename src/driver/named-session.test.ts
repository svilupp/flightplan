import { expect, test } from "bun:test";
import type { BorrowedBrowser, Page } from "browser-pilot/core";
import {
  type NamedSessionBorrow,
  namedSessionDriverFactory,
  nativeNamedSessionBorrower,
} from "./named-session.ts";

const config = { mode: "session", session_ref: "work", target_policy: "selected" } as const;
function owner() {
  let active = false,
    acquisitions = 0,
    detaches = 0,
    handbacks = 0;
  let selected = "page-1";
  const browser = {
    page: async () => ({ targetId: selected }) as Page,
    listTargets: async () => [{ targetId: selected, type: "page" }],
  } as unknown as BorrowedBrowser;
  return {
    borrow: async (): Promise<NamedSessionBorrow> => {
      if (active) throw new Error("session_busy");
      active = true;
      acquisitions++;
      return {
        protocolVersion: 1,
        ownerEpoch: "owner-epoch",
        fencingToken: String(acquisitions),
        exclusive: true,
        capabilities: { ownerProtocolVersion: 2, rawCompatibility: true, nativeAtomic: false },
        browser,
        page: { targetId: selected, onDialog: async () => {} } as unknown as Page,
        handback: async (page) => {
          handbacks++;
          selected = page.targetId;
          return {
            confirmed: true,
            ownerEpoch: "owner-epoch",
            targetId: page.targetId,
            refsInvalidated: true,
            pendingActions: "drained",
            bindingRevision: handbacks,
            observationEpoch: `observation-${handbacks}`,
          };
        },
        detach: async () => {
          detaches++;
          active = false;
        },
      };
    },
    counters: () => ({ acquisitions, detaches, handbacks, selected }),
  };
}
test("sequential borrows reuse owner and hand back final identity before detach", async () => {
  const o = owner();
  const adapter = namedSessionDriverFactory(o.borrow);
  for (let run = 0; run < 2; run++) {
    const driver = adapter.factory(config);
    await driver.connect(config);
    await driver.teardown();
    expect(adapter.handback()).toMatchObject({
      status: "verified",
      target_id: "page-1",
      owner_epoch: "owner-epoch",
    });
  }
  expect(o.counters()).toEqual({ acquisitions: 2, detaches: 2, handbacks: 2, selected: "page-1" });
});
test("competing borrow fails without allocating replacement or detaching owner", async () => {
  const o = owner();
  const adapter = namedSessionDriverFactory(o.borrow);
  const first = adapter.factory(config),
    second = adapter.factory(config);
  await first.connect(config);
  expect(second.connect(config)).rejects.toThrow("session_busy");
  expect(o.counters().acquisitions).toBe(1);
  expect(o.counters().detaches).toBe(0);
  await first.teardown();
});
test("unfenced borrower is rejected and detaches the acquired wrapper", async () => {
  const o = owner();
  const adapter = namedSessionDriverFactory(
    async () => ({ ...(await o.borrow()), exclusive: false }) as unknown as NamedSessionBorrow,
  );
  expect(adapter.factory(config).connect(config)).rejects.toThrow("CAPABILITY");
  expect(o.counters().detaches).toBe(1);
});
test("failed handback remains unknown but always detaches", async () => {
  const o = owner();
  const adapter = namedSessionDriverFactory(async () => ({
    ...(await o.borrow()),
    handback: async () => {
      throw new Error("target disappeared");
    },
  }));
  const driver = adapter.factory(config);
  await driver.connect(config);
  expect(driver.teardown()).rejects.toThrow("target disappeared");
  expect(adapter.handback().status).toBe("unknown");
  expect(o.counters().detaches).toBe(1);
});
test("installed missing BP public borrowing API fails with no reconnect fallback", async () => {
  const module = (await import("browser-pilot/adapters/node")) as unknown as {
    borrowNamedSession?: unknown;
  };
  if (!module.borrowNamedSession)
    expect(
      nativeNamedSessionBorrower({ session: "work", targetPolicy: "selected" }),
    ).rejects.toThrow("BP_NAMED_SESSION_UNAVAILABLE");
});

test("exact target mismatch rejects the lease before driver setup and detaches once", async () => {
  const o = owner();
  const adapter = namedSessionDriverFactory(o.borrow);
  const exact = { ...config, target_policy: "exact" as const, target_id: "different-page" };
  const driver = adapter.factory(exact);
  await expect(driver.connect(exact)).rejects.toThrow("TARGET_MISMATCH");
  await driver.teardown();
  expect(o.counters()).toMatchObject({ acquisitions: 1, detaches: 1, handbacks: 0 });
  expect(adapter.handback().status).toBe("not_acquired");
});

for (const field of [
  "ownerEpoch",
  "targetId",
  "refsInvalidated",
  "pendingActions",
  "observationEpoch",
  "bindingRevision",
] as const) {
  test(`handback receipt rejects invalid ${field} instead of reporting verified`, async () => {
    const o = owner();
    const adapter = namedSessionDriverFactory(async () => {
      const lease = await o.borrow();
      return {
        ...lease,
        handback: async (page) => {
          const receipt = await lease.handback(page);
          return {
            ...receipt,
            [field]: field === "bindingRevision" ? -1 : field === "refsInvalidated" ? false : "",
          } as never;
        },
      };
    });
    const driver = adapter.factory(config);
    await driver.connect(config);
    await expect(driver.teardown()).rejects.toThrow("BP_HANDBACK_UNKNOWN");
    expect(adapter.handback().status).toBe("unknown");
    expect(o.counters().detaches).toBe(1);
  });
}
