import type { DispatchState } from "../driver/types.ts";

export interface YieldIdentity {
  ownerEpoch: string;
  grantToken: string;
  pageIdentity: string;
}
export interface YieldCheckpoint {
  id: string;
  version: 1;
  binding: string;
  stepId: string;
  receipts: Array<{ stepId: string; dispatchState?: DispatchState }>;
  identity: YieldIdentity;
  expiresAt: number;
  state: "yielded" | "reacquiring" | "completed" | "failed";
}
export interface CheckpointStore {
  create(record: YieldCheckpoint): Promise<void>;
  /** Atomic compare-and-transition. A missing, expired or already claimed record returns undefined. */
  claim(id: string, binding: string, now: number): Promise<YieldCheckpoint | undefined>;
  finish(id: string, state: "completed" | "failed"): Promise<void>;
}

/** Trusted in-process implementation. Durable hosts inject an atomic persistent store. */
export function memoryCheckpointStore(): CheckpointStore {
  const records = new Map<string, YieldCheckpoint>();
  return {
    async create(record) {
      if (records.has(record.id)) throw new Error("checkpoint_conflict");
      records.set(record.id, structuredClone(record));
    },
    async claim(id, binding, now) {
      const record = records.get(id);
      if (
        !record ||
        record.binding !== binding ||
        record.state !== "yielded" ||
        record.expiresAt <= now
      )
        return undefined;
      record.state = "reacquiring";
      return structuredClone(record);
    },
    async finish(id, state) {
      const record = records.get(id);
      if (!record || record.state === "completed" || record.state === "failed")
        throw new Error("checkpoint_terminal");
      record.state = state;
    },
  };
}

export interface YieldHost {
  store: CheckpointStore;
  /** Durable caller/input-reference binding. Never use a raw secret or its unkeyed hash. */
  binding: string;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
  currentIdentity(): Promise<YieldIdentity>;
  releaseFlightplan(): Promise<void>;
  acquireHost(signal: AbortSignal): Promise<void>;
  perform(
    request: { checkpointId: string; task: string; deadline: number },
    signal: AbortSignal,
  ): Promise<{ pageIdentity: string }>;
  /** Must revoke queued host actions and drain in-flight inputs before releasing control. */
  releaseHost(): Promise<void>;
  acquireFlightplan(): Promise<YieldIdentity>;
  refresh(): Promise<void>;
  verifyReturn(
    checkpoint: Readonly<YieldCheckpoint>,
    returnedPageIdentity: string,
  ): Promise<boolean>;
}

async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("yield_interrupted"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
      Promise.resolve().then(operation),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** Consume only an opaque ID. Untrusted callers cannot supply receipts or weaken return policy. */
export async function resumeYield(
  host: YieldHost,
  checkpointId: string,
  binding: string,
  returnedPageIdentity: string,
): Promise<void> {
  const checkpoint = await host.store.claim(checkpointId, binding, Date.now());
  if (!checkpoint) throw new Error("checkpoint_unavailable");
  const signal = AbortSignal.any([
    AbortSignal.timeout(
      Math.max(1, Math.min(host.timeoutMs ?? 30000, checkpoint.expiresAt - Date.now())),
    ),
    ...(host.signal ? [host.signal] : []),
  ]);
  try {
    await bounded(() => host.releaseHost(), signal);
    const identity = await bounded(() => host.acquireFlightplan(), signal);
    if (
      identity.ownerEpoch !== checkpoint.identity.ownerEpoch ||
      identity.grantToken === checkpoint.identity.grantToken ||
      identity.pageIdentity !== returnedPageIdentity
    )
      throw new Error("yield_identity_changed");
    await bounded(() => host.refresh(), signal);
    if (!(await bounded(() => host.verifyReturn(checkpoint, returnedPageIdentity), signal)))
      throw new Error("yield_return_failed");
    await bounded(() => host.store.finish(checkpointId, "completed"), signal);
  } catch (error) {
    await bounded(
      () => host.store.finish(checkpointId, "failed"),
      AbortSignal.timeout(host.cleanupTimeoutMs ?? 1000),
    );
    throw error;
  }
}

export async function runYield(
  host: YieldHost,
  request: {
    task: string;
    stepId: string;
    recipeBinding: string;
    receipts: YieldCheckpoint["receipts"];
    timeoutMs?: number;
  },
): Promise<string> {
  const timeoutMs = request.timeoutMs ?? host.timeoutMs ?? 30000;
  const deadline = Date.now() + timeoutMs;
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(host.signal ? [host.signal] : []),
  ]);
  const binding = JSON.stringify([request.recipeBinding, host.binding, request.stepId]);
  const id = crypto.randomUUID();
  let hostControl = false;
  try {
    const identity = await bounded(() => host.currentIdentity(), signal);
    await bounded(
      () =>
        host.store.create({
          id,
          version: 1,
          binding,
          stepId: request.stepId,
          receipts: request.receipts,
          identity,
          expiresAt: deadline,
          state: "yielded",
        }),
      signal,
    );
    await bounded(() => host.releaseFlightplan(), signal);
    hostControl = true;
    await bounded(() => host.acquireHost(signal), signal);
    const result = await bounded(
      () => host.perform({ checkpointId: id, task: request.task, deadline }, signal),
      signal,
    );
    signal.throwIfAborted();
    await resumeYield({ ...host, signal }, id, binding, result.pageIdentity);
    hostControl = false;
    return id;
  } catch {
    if (hostControl) {
      try {
        await bounded(() => host.releaseHost(), AbortSignal.timeout(host.cleanupTimeoutMs ?? 1000));
      } catch {
        // Terminal failure does not authorize another controller while revocation is unconfirmed.
      }
    }
    try {
      await bounded(
        () => host.store.finish(id, "failed"),
        AbortSignal.timeout(host.cleanupTimeoutMs ?? 1000),
      );
    } catch {
      /* Already terminal or not created. */
    }
    throw new Error("yield_failed");
  }
}
