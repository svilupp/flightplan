import type { DriverFactory } from "../runner/types.ts";
import type { NamedSessionBorrower, NamedSessionHandback } from "./named-session.ts";
import { OwnerActionDriver } from "./owner-action-driver.ts";
import { OwnerActionError } from "./owner-actions.ts";
import type { OwnerActionPort, OwnerAssurance } from "./owner-contract.ts";
import { confirmsOwnerHandback } from "./owner-handback.ts";

export interface BorrowedOwnerActions {
  protocolVersion: 1;
  ownerEpoch: string;
  fencingToken: string;
  exclusive: true;
  pageTargetId: string;
  port: OwnerActionPort;
  handback(options: { targetId: string }): Promise<NamedSessionHandback>;
  detach(): Promise<void>;
}
export type OwnerActionsBorrower = (
  request: Parameters<NamedSessionBorrower>[0],
) => Promise<BorrowedOwnerActions>;

export async function nativeOwnerActionsBorrower(
  request: Parameters<OwnerActionsBorrower>[0],
): Promise<BorrowedOwnerActions> {
  const spec = "browser-pilot/adapters/node";
  const module = (await import(/* @vite-ignore */ spec)) as {
    borrowOwnerActions?: OwnerActionsBorrower;
  };
  if (!module.borrowOwnerActions) throw new OwnerActionError("typed_api_unavailable");
  return module.borrowOwnerActions(request);
}

/** Required assurance is trusted host configuration; a recipe cannot weaken the owner's policy. */
export function nativeOwnerActionDriverFactory(
  options: { borrow?: OwnerActionsBorrower; requiredAssurance?: OwnerAssurance } = {},
): DriverFactory {
  return (_config, context) =>
    new OwnerActionDriver({
      requiredAssurance: options.requiredAssurance,
      acquire: async (config) => {
        if (config.mode !== "session") throw new OwnerActionError("named_session_required");
        const lease = await (options.borrow ?? nativeOwnerActionsBorrower)({
          session: config.session_ref,
          targetPolicy: config.target_policy,
          ...(config.target_id ? { targetId: config.target_id } : {}),
          ...(context ? { signal: context.signal, deadline: context.deadline } : {}),
          recovery: "never",
        });
        if (
          lease.protocolVersion !== 1 ||
          lease.exclusive !== true ||
          !lease.ownerEpoch ||
          !lease.fencingToken ||
          !lease.pageTargetId ||
          (config.target_policy === "exact" && lease.pageTargetId !== config.target_id)
        ) {
          await lease.detach();
          throw new OwnerActionError("typed_lease_invalid");
        }
        return {
          port: lease.port,
          pageTargetId: lease.pageTargetId,
          ownerEpoch: lease.ownerEpoch,
          grantToken: lease.fencingToken,
          async handback() {
            const result = await lease.handback({ targetId: lease.pageTargetId });
            if (!confirmsOwnerHandback(result, lease.ownerEpoch, lease.pageTargetId))
              throw new OwnerActionError("handback_unknown", "uncertain");
          },
          detach: () => lease.detach(),
        };
      },
    });
}
