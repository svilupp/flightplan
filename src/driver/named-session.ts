import type { DriverFactory } from "../runner/types.ts";
import type { BrowserPilotDriverOptions, DriverAcquisition } from "./browser-pilot-driver.ts";
import { BrowserPilotDriver } from "./browser-pilot-driver.ts";
import { confirmsOwnerHandback } from "./owner-handback.ts";

export interface NamedSessionHandback {
  confirmed: true;
  ownerEpoch: string;
  targetId: string;
  refsInvalidated: true;
  pendingActions: "drained";
  bindingRevision: number;
  observationEpoch: string;
}

export interface NamedSessionBorrow extends DriverAcquisition {
  protocolVersion: 1;
  ownerEpoch: string;
  fencingToken: string;
  exclusive: true;
  capabilities: {
    ownerProtocolVersion: 2;
    rawCompatibility: true;
    nativeAtomic: false;
  };
  /** Owner atomically verifies page identity, updates selected binding, and invalidates refs. */
  handback(page: { targetId: string }): Promise<NamedSessionHandback>;
}
export type NamedSessionBorrower = (request: {
  session: string;
  targetPolicy: "selected" | "exact";
  targetId?: string;
  signal?: AbortSignal;
  deadline?: number;
  recovery?: "never";
}) => Promise<NamedSessionBorrow>;
export interface SessionHandback {
  status: "not_acquired" | "verified" | "unknown";
  session?: string;
  target_id?: string;
  owner_epoch?: string;
  observation_epoch?: string;
  binding_revision?: number;
}
/** Native capability lookup. Missing API is terminal: never reconstruct a WS connection. */
export async function nativeNamedSessionBorrower(
  request: Parameters<NamedSessionBorrower>[0],
): Promise<NamedSessionBorrow> {
  const spec = "browser-pilot/adapters/node";
  const module = (await import(/* @vite-ignore */ spec)) as unknown as {
    borrowNamedSession?: NamedSessionBorrower;
  };
  if (!module.borrowNamedSession)
    throw new Error(
      "BP_NAMED_SESSION_UNAVAILABLE: installed browser-pilot lacks fenced borrowNamedSession; upgrade BP or inject a compatible host borrower",
    );
  return module.borrowNamedSession(request);
}
export function namedSessionDriverFactory(
  borrow: NamedSessionBorrower,
  options: Omit<BrowserPilotDriverOptions, "acquire" | "acquisitionContext"> = {},
) {
  let handback: SessionHandback = { status: "not_acquired" };
  const factory: DriverFactory = (_config, context) => {
    let driver: BrowserPilotDriver;
    driver = new BrowserPilotDriver({
      ...options,
      acquisitionContext: context,
      acquire: async (connection, scope) => {
        if (connection.mode !== "session")
          throw new Error("Named session adapter requires session mode");
        const lease = await borrow({
          session: connection.session_ref,
          recovery: "never",
          targetPolicy: connection.target_policy,
          ...(connection.target_id ? { targetId: connection.target_id } : {}),
          ...(scope?.signal ? { signal: scope.signal } : {}),
          ...(scope?.deadline !== undefined ? { deadline: scope.deadline } : {}),
        });
        if (
          lease.protocolVersion !== 1 ||
          lease.exclusive !== true ||
          lease.capabilities?.ownerProtocolVersion !== 2 ||
          lease.capabilities.rawCompatibility !== true ||
          lease.capabilities.nativeAtomic !== false ||
          !lease.ownerEpoch ||
          !lease.fencingToken ||
          typeof lease.handback !== "function"
        ) {
          await lease.detach();
          throw new Error(
            "BP_NAMED_SESSION_CAPABILITY: borrower must provide a fenced exclusive lease and owner handback",
          );
        }
        if (connection.target_policy === "exact" && lease.page.targetId !== connection.target_id) {
          await lease.detach();
          throw new Error("BP_NAMED_SESSION_TARGET_MISMATCH: borrower returned a different target");
        }
        handback = {
          status: "unknown",
          session: connection.session_ref,
          owner_epoch: lease.ownerEpoch,
        };
        let detached = false;
        return {
          browser: lease.browser,
          page: lease.page,
          detach: async () => {
            if (detached) return;
            detached = true;
            try {
              const page = await driver.pageState();
              if (!page.activeTargetId)
                throw new Error("BP_HANDBACK_UNKNOWN: final page identity is unavailable");
              const result = await lease.handback({ targetId: page.activeTargetId });
              if (!confirmsOwnerHandback(result, lease.ownerEpoch, page.activeTargetId))
                throw new Error(
                  "BP_HANDBACK_UNKNOWN: owner did not confirm drained final page and observation invalidation",
                );
              handback = {
                ...handback,
                status: "verified",
                target_id: page.activeTargetId,
                observation_epoch: result.observationEpoch,
                binding_revision: result.bindingRevision,
              };
            } finally {
              await lease.detach();
            }
          },
        };
      },
    });
    return driver;
  };
  return { factory, handback: () => ({ ...handback }) };
}
