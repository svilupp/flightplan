import type {
  OwnerAction,
  OwnerActionPort,
  OwnerActionReceipt,
  OwnerAssurance,
  OwnerPreparedAction,
} from "./owner-contract.ts";
import type { DispatchState } from "./types.ts";

export class OwnerActionError extends Error {
  constructor(
    readonly reason: string,
    readonly dispatchState: DispatchState = "not_dispatched",
  ) {
    super(`BP_OWNER_ACTION:${reason}`);
    this.name = "OwnerActionError";
  }
}

/** Consume server-minted preparation/approval handles. Never treat client verdicts as authority. */
export async function executeOwnerAction(
  port: OwnerActionPort,
  pageTargetId: string,
  action: OwnerAction,
  requiredAssurance: OwnerAssurance = "renderer-same-task-dom",
  restrict?: (prepared: Readonly<OwnerPreparedAction>) => Promise<void>,
): Promise<OwnerActionReceipt> {
  const capabilities = await port.capabilities();
  if (
    capabilities.version !== 1 ||
    capabilities.profile !== "strict" ||
    capabilities.assurance !== requiredAssurance ||
    !capabilities.actions.includes(action.kind)
  )
    throw new OwnerActionError("capability_unavailable");
  let prepared: OwnerPreparedAction;
  try {
    prepared = await port.prepare({ pageTargetId, action });
  } catch {
    throw new OwnerActionError("preparation_refused");
  }
  if (
    !prepared.preparedId ||
    prepared.pageTargetId !== pageTargetId ||
    !prepared.documentId ||
    prepared.assurance !== requiredAssurance
  )
    throw new OwnerActionError("preparation_invalid");
  await restrict?.(prepared);
  let approval: import("./owner-contract.ts").OwnerApproval;
  try {
    approval = await port.authorize({ preparedId: prepared.preparedId });
  } catch {
    throw new OwnerActionError("authorization_unavailable");
  }
  if (approval.verdict !== "allow" || !approval.approvalId)
    throw new OwnerActionError("approval_unavailable");
  let receipt: OwnerActionReceipt;
  try {
    receipt = await port.dispatch({ approvalId: approval.approvalId });
  } catch {
    // Once dispatch RPC is sent, a lost reply cannot prove input was withheld.
    throw new OwnerActionError("dispatch_reply_unknown", "uncertain");
  }
  if (
    !receipt ||
    receipt.assurance !== requiredAssurance ||
    !["not_dispatched", "dispatched", "unknown"].includes(receipt.dispatchState)
  )
    throw new OwnerActionError("receipt_invalid", "uncertain");
  return receipt;
}
