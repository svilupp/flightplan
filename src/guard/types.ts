import type { Driver } from "../driver/types.ts";
import type { Step } from "../flow/types.ts";

export type GuardVerdict =
  | { decision: "allow"; reason: string }
  | { decision: "deny"; reason: string }
  | { decision: "unknown"; reason: string };

export interface GuardIdentity {
  documentId: string;
  targetId: string;
  resourceId: string;
  ownerEpoch: string;
  grantToken: string;
}

export interface ActionProposal {
  version: 1;
  id: string;
  policyVersion: string;
  operation: string;
  action: string;
  tool?: string;
  key?: string;
  navigationUrl?: string;
  stepId?: string;
  intent?: string;
  effect?: string;
  selectors: string[];
  payload: "none" | "redacted";
  evidence: {
    url: string;
    frame: string | null;
    text: string;
    observedAt: number;
    identity?: GuardIdentity;
  };
}

export interface GuardObservation {
  proposalId: string;
  policyVersion: string;
  operation: string;
  stepId?: string;
  mode: "shadow" | "enforce";
  verdict: GuardVerdict;
  dispatched: boolean | "unknown";
}

export interface GuardInvocation {
  operation: string;
  args: readonly unknown[];
  driver: Driver;
  signal?: AbortSignal;
}

/** Controller serialization is distinct from renderer-atomic DOM execution. */
export type DispatchAssurance = "owner-serialized-prechecked-native" | "renderer-same-task-dom";

export interface ActionGuardOptions {
  mode: "shadow" | "enforce";
  policyVersion: string;
  evaluate(proposal: Readonly<ActionProposal>, signal: AbortSignal): Promise<GuardVerdict>;
  timeoutMs?: number;
  maxEvaluations?: number;
  signal?: AbortSignal;
  /** Defaults to renderer-same-task-dom. Native input requires explicit trusted host opt-in. */
  requiredAssurance?: DispatchAssurance;
  /** Negotiated per operation; a callback is authority supplied by the trusted host, not a proof. */
  dispatchAssurance?(invocation: GuardInvocation): DispatchAssurance | undefined;
  /** Must bind dispatch to the approved document and element, with no unapproved selector fallback. */
  identify?(invocation: GuardInvocation): Promise<GuardIdentity>;
  dispatch?(proposal: Readonly<ActionProposal>, invocation: GuardInvocation): Promise<unknown>;
  onObservation?(observation: GuardObservation): void | Promise<void>;
}

export interface GuardStepContext {
  id: string;
  intent?: string;
  effect?: string;
}

export type GuardStep = Pick<Step, "id" | "do" | "effect"> & { target?: unknown };
