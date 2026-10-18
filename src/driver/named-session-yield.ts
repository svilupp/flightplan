import type { YieldHost, YieldIdentity } from "../runner/checkpoints.ts";
import { memoryCheckpointStore } from "../runner/checkpoints.ts";
import type { NamedSessionBorrow, NamedSessionBorrower } from "./named-session.ts";
import { confirmsOwnerHandback } from "./owner-handback.ts";

export interface NamedSessionYieldOptions {
  session: string;
  binding: string;
  borrow: NamedSessionBorrower;
  flightplan: {
    currentIdentity(): Promise<YieldIdentity>;
    /** Must hand back and detach the actual active driver before returning. */
    release(): Promise<void>;
    /** Must acquire a fresh driver lease, not reuse a suspended Page. */
    acquire(): Promise<YieldIdentity>;
    refresh(): Promise<void>;
  };
  perform(
    lease: NamedSessionBorrow,
    request: { checkpointId: string; task: string; deadline: number },
    signal: AbortSignal,
  ): Promise<{ pageIdentity: string }>;
  verifyReturn: YieldHost["verifyReturn"];
  store?: YieldHost["store"];
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Same-process host transfer. Does not implement a durable execution cursor or reserve priority. */
export function createNamedSessionYieldHost(options: NamedSessionYieldOptions): YieldHost {
  let lease: NamedSessionBorrow | undefined;
  let returnedPage: string | undefined;
  let release: Promise<void> | undefined;
  return {
    store: options.store ?? memoryCheckpointStore(),
    binding: options.binding,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal ? { signal: options.signal } : {}),
    currentIdentity: () => options.flightplan.currentIdentity(),
    releaseFlightplan: () => options.flightplan.release(),
    async acquireHost(signal) {
      if (lease) throw new Error("yield_host_already_acquired");
      returnedPage = undefined;
      release = undefined;
      lease = await options.borrow({
        session: options.session,
        targetPolicy: "selected",
        signal,
        recovery: "never",
      });
    },
    async perform(request, signal) {
      if (!lease) throw new Error("yield_host_not_acquired");
      const result = await options.perform(lease, request, signal);
      if (!result.pageIdentity) throw new Error("yield_host_page_unavailable");
      returnedPage = result.pageIdentity;
      return result;
    },
    async releaseHost() {
      if (release) return release;
      const acquired = lease;
      if (!acquired) return;
      release = (async () => {
        try {
          const result = await acquired.handback({
            targetId: returnedPage ?? acquired.page.targetId,
          });
          if (
            !confirmsOwnerHandback(
              result,
              acquired.ownerEpoch,
              returnedPage ?? acquired.page.targetId,
            )
          )
            throw new Error("yield_host_handback_unknown");
        } finally {
          await acquired.detach();
          lease = undefined;
        }
      })();
      return release;
    },
    acquireFlightplan: () => options.flightplan.acquire(),
    refresh: () => options.flightplan.refresh(),
    verifyReturn: (checkpoint, page) => options.verifyReturn(checkpoint, page),
  };
}
