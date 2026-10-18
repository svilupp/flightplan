import type { RunResult } from "../runner/types.ts";

export interface InvocationRecord {
  binding: string;
  state: "running" | "dispatch_pending" | "completed" | "needs_reconciliation";
  result?: RunResult;
}
export type InvocationClaim =
  | { status: "claimed"; token: string }
  | { status: "running" | "conflict" | "needs_reconciliation" }
  | { status: "completed"; result: RunResult };
export interface InvocationStore {
  claim(key: string, binding: string): Promise<InvocationClaim>;
  dispatchPending(key: string, token: string): Promise<void>;
  finish(key: string, token: string, result: RunResult): Promise<void>;
  fail(key: string, token: string): Promise<void>;
}
export class InvocationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "InvocationError";
  }
}
export function existingClaim(record: InvocationRecord, binding: string): InvocationClaim {
  if (record.binding !== binding) return { status: "conflict" };
  if (record.state === "completed" && record.result)
    return { status: "completed", result: record.result };
  return { status: record.state === "running" ? "running" : "needs_reconciliation" };
}
export class MemoryInvocationStore implements InvocationStore {
  private records = new Map<string, InvocationRecord & { token: string }>();
  private generation = 0;
  async claim(key: string, binding: string): Promise<InvocationClaim> {
    const record = this.records.get(key);
    if (record) return structuredClone(existingClaim(record, binding));
    const token = String(++this.generation);
    this.records.set(key, { binding, token, state: "running" });
    return { status: "claimed", token };
  }
  private owned(key: string, token: string) {
    const record = this.records.get(key);
    if (!record || record.token !== token || record.state === "completed")
      throw new InvocationError("INVOCATION_STALE_CLAIM");
    return record;
  }
  async dispatchPending(key: string, token: string) {
    this.owned(key, token).state = "dispatch_pending";
  }
  async finish(key: string, token: string, result: RunResult) {
    Object.assign(this.owned(key, token), { state: "completed", result: structuredClone(result) });
  }
  async fail(key: string, token: string) {
    this.owned(key, token).state = "needs_reconciliation";
  }
}
