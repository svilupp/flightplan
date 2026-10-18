/** Versioned structural boundary for BP's additive owner API. Older BP installs still build;
 * capability checks reject unsupported execution. Packed-consumer tests prove assignability. */
export type OwnerAction =
  | { kind: "goto"; url: string }
  | { kind: "click" | "hover" | "submit"; selector: string }
  | { kind: "fill"; selector: string; value: string; verify?: "exact" | "normalized" | false }
  | { kind: "type" | "select"; selector: string; value: string }
  | { kind: "check"; selector: string; checked: boolean }
  | { kind: "press"; selector: string; key: string };
export type OwnerAssurance = "owner-serialized-prechecked-native" | "renderer-same-task-dom";
export interface OwnerActionCapabilities {
  version: 1;
  profile: "strict";
  assurance: OwnerAssurance;
  actions: readonly OwnerAction["kind"][];
  reads: readonly string[];
  images: false;
}
export interface OwnerObservation {
  pageTargetId: string;
  documentId: string;
  url: string;
  title: string;
  text: string;
  observedAt: number;
  nodes?: readonly {
    selector: string;
    role: string;
    name: string;
    text: string;
    visible: boolean;
    enabled: boolean;
    attributes?: Record<string, string>;
  }[];
  element?: {
    exists: boolean;
    visible: boolean;
    count: number;
    text: string;
    boundingBox: { x: number; y: number; width: number; height: number } | null;
  };
}
export interface OwnerPreparedAction {
  preparedId: string;
  pageTargetId: string;
  documentId: string;
  elementIdentity?: string;
  policyVersion: string;
  assurance: OwnerAssurance;
  evidence: OwnerObservation & {
    action: OwnerAction["kind"];
    target?: string;
    destination?: string;
  };
}
export interface OwnerApproval {
  approvalId?: string;
  verdict: "allow" | "deny" | "unknown";
  reason: string;
}
export interface OwnerActionReceipt {
  dispatchState: "not_dispatched" | "dispatched" | "unknown";
  retrySafe: boolean;
  inputEventsSent: string[];
  reason?: string;
  assurance: OwnerAssurance;
}
export interface OwnerActionPort {
  capabilities(): Promise<OwnerActionCapabilities>;
  extract?(request: OwnerExtractRequest): Promise<OwnerExtractResult>;
  observe(request: {
    pageTargetId: string;
    kind: "state" | "snapshot" | "element";
    selector?: string;
  }): Promise<OwnerObservation>;
  prepare(request: { pageTargetId: string; action: OwnerAction }): Promise<OwnerPreparedAction>;
  authorize(request: { preparedId: string }): Promise<OwnerApproval>;
  dispatch(request: { approvalId: string }): Promise<OwnerActionReceipt>;
}

export interface OwnerExtractRequest {
  pageTargetId: string;
  selector: string;
  maxRows: number;
  fields: Record<
    string,
    {
      selector: string;
      source: "text" | "value" | "attribute";
      attribute?: string;
      type: "string" | "number" | "boolean";
      required?: boolean;
      secret?: boolean;
    }
  >;
}
export interface OwnerExtractResult {
  documentId: string;
  rows: Record<string, string | number | boolean>[];
  secretFields: string[];
}
