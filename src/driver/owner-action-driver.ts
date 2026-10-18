import type { ActionGuardOptions } from "../guard/types.ts";
import type { DriverFactory } from "../runner/types.ts";
import type { ExtractionSpec } from "./extract.ts";
import { executeOwnerAction, OwnerActionError } from "./owner-actions.ts";
import type {
  OwnerAction,
  OwnerActionPort,
  OwnerActionReceipt,
  OwnerAssurance,
  OwnerObservation,
} from "./owner-contract.ts";
import { ownerRestrictions } from "./owner-restrictions.ts";
import type {
  ActionOpts,
  BatchOptions,
  BatchResult,
  BatchStep,
  ConnectConfig,
  Driver,
  ElementState,
  FillOpts,
  GotoOpts,
  PageSnapshot,
  PressOpts,
  RankedCandidate,
  RefMap,
  SignatureOpts,
  SnapshotOpts,
  SubmitOpts,
  TypeOpts,
} from "./types.ts";

export interface OwnerActionLease {
  port: OwnerActionPort;
  pageTargetId: string;
  ownerEpoch: string;
  grantToken: string;
  /** Owner freezes, drains, commits the page and invalidates observations before release. */
  handback(): Promise<void>;
  detach(): Promise<void>;
}
export interface OwnerActionDriverOptions {
  acquire(config: ConnectConfig): Promise<OwnerActionLease>;
  /** Trusted host policy. Flow fields cannot change this requirement. */
  requiredAssurance?: OwnerAssurance;
}

/** Restricted driver: all execution crosses the owner's typed policy boundary. No raw Page. */
export class OwnerActionDriver implements Driver {
  private lease?: OwnerActionLease;
  private refs = new Map<string, string>();
  private restriction?: ReturnType<typeof ownerRestrictions>;
  installActionGuard(options: ActionGuardOptions, redact: (text: string) => string) {
    if (this.restriction) throw new OwnerActionError("guard_already_installed");
    this.restriction = ownerRestrictions(options, redact);
    return this.restriction;
  }
  constructor(private readonly options: OwnerActionDriverOptions) {}
  private active(): OwnerActionLease {
    if (!this.lease) throw new OwnerActionError("not_connected");
    return this.lease;
  }
  private unsupported(): never {
    throw new OwnerActionError("operation_unsupported");
  }
  async connect(config: ConnectConfig): Promise<void> {
    if (this.lease) throw new OwnerActionError("already_connected");
    const lease = await this.options.acquire(config);
    try {
      const capabilities = await lease.port.capabilities();
      if (
        capabilities.version !== 1 ||
        capabilities.profile !== "strict" ||
        capabilities.assurance !== (this.options.requiredAssurance ?? "renderer-same-task-dom")
      )
        throw new OwnerActionError("capability_unavailable");
      this.lease = lease;
    } catch (error) {
      await lease.detach();
      throw error;
    }
  }
  async teardown(): Promise<void> {
    const lease = this.lease;
    this.lease = undefined;
    this.refs.clear();
    if (!lease) return;
    try {
      await lease.handback();
    } finally {
      await lease.detach();
    }
  }
  async page(): Promise<never> {
    return this.unsupported();
  }
  async clearBrowserState(): Promise<void> {
    return this.unsupported();
  }
  async switchToFrame(): Promise<boolean> {
    return this.unsupported();
  }
  async switchToMain(): Promise<void> {
    return this.unsupported();
  }
  currentFrame(): null {
    return null;
  }
  async evalInFrame(): Promise<never> {
    return this.unsupported();
  }
  async evaluateExpression(): Promise<never> {
    return this.unsupported();
  }
  async screenshot(): Promise<never> {
    return this.unsupported();
  }
  async resolveAll(): Promise<RankedCandidate[]> {
    // This restricted adapter supplies explicit-selector execution only. No opaque
    // browser ranker or semantic fallback can bypass owner preparation.
    return [];
  }
  exportRefMap(): RefMap {
    return {};
  }
  importRefMap(map: RefMap): void {
    if (Object.keys(map).length) this.unsupported();
  }
  async setDialogPolicy(policy: string): Promise<void> {
    if (policy !== "fail") this.unsupported();
  }
  private async observe(
    kind: "state" | "snapshot" | "element",
    selector?: string,
  ): Promise<OwnerObservation> {
    const lease = this.active();
    const result = await lease.port.observe({
      pageTargetId: lease.pageTargetId,
      kind,
      ...(selector ? { selector } : {}),
    });
    if (result.pageTargetId !== lease.pageTargetId || !result.documentId)
      throw new OwnerActionError("observation_invalid");
    return result;
  }
  async currentUrl(): Promise<string> {
    return (await this.observe("state")).url;
  }
  async documentIdentity(): Promise<string> {
    return (await this.observe("state")).documentId;
  }
  async pageState() {
    return { activeTargetId: this.active().pageTargetId };
  }
  async snapshot(options?: SnapshotOpts): Promise<PageSnapshot> {
    const observed = await this.observe("snapshot");
    if (!observed.nodes) throw new OwnerActionError("snapshot_unavailable");
    this.refs.clear();
    const nodes = observed.nodes.filter(
      (node) => !options?.roles || options.roles.includes(node.role),
    );
    const interactiveElements = nodes.map((node, index) => {
      const ref = `e${index + 1}`;
      this.refs.set(ref, node.selector);
      return {
        ref,
        selector: node.selector,
        role: node.role,
        name: node.name,
        disabled: !node.enabled,
        ...(options?.attributes && node.attributes ? { attributes: node.attributes } : {}),
      };
    });
    return {
      url: observed.url,
      title: observed.title,
      timestamp: new Date(observed.observedAt).toISOString(),
      text: observed.text,
      interactiveElements,
      accessibilityTree: interactiveElements.map(({ ref, role, name, disabled }) => ({
        ref,
        role,
        name,
        disabled,
      })),
    };
  }
  async elementState(selector: string): Promise<ElementState> {
    const observed = await this.observe("element", this.selector(selector));
    if (!observed.element) throw new OwnerActionError("element_probe_unavailable");
    return { ...observed.element, value: null };
  }
  private selector(value: string | string[]): string {
    const selector = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
    if (!selector) throw new OwnerActionError("selector_fallback_unsupported");
    if (selector.startsWith("ref:")) {
      const durable = this.refs.get(selector.slice(4));
      if (!durable) throw new OwnerActionError("ref_unavailable");
      return durable;
    }
    return selector;
  }
  async extract(spec: ExtractionSpec): Promise<unknown> {
    const lease = this.active();
    const capabilities = await lease.port.capabilities();
    if (!lease.port.extract || !capabilities.reads.includes("extract"))
      throw new OwnerActionError("extraction_unsupported");
    const fields: import("./owner-contract.ts").OwnerExtractRequest["fields"] = {};
    for (const [key, field] of Object.entries(spec.fields)) {
      if (field.selector === undefined)
        throw new OwnerActionError("semantic_extraction_unsupported");
      fields[key] = { ...field, selector: field.selector === "." ? "" : field.selector };
    }
    const before = await this.documentIdentity();
    const result = await lease.port.extract({
      pageTargetId: lease.pageTargetId,
      selector: spec.selector,
      maxRows: spec.max_rows,
      fields,
    });
    if (result.documentId !== before || (await this.documentIdentity()) !== before)
      throw new OwnerActionError("extraction_document_changed");
    if (result.secretFields.some((field) => spec.fields[field]?.secret !== true))
      throw new OwnerActionError("extraction_secret_contract_mismatch");
    return result.rows;
  }
  private async execute(action: OwnerAction) {
    const lease = this.active();
    this.refs.clear();
    return executeOwnerAction(
      lease.port,
      lease.pageTargetId,
      action,
      this.options.requiredAssurance,
      this.restriction ? (prepared) => this.restriction!.beforeAuthorize(prepared) : undefined,
    );
  }
  private async action(action: OwnerAction): Promise<boolean> {
    const receipt = await this.execute(action);
    if (receipt.dispatchState === "unknown")
      throw new OwnerActionError("dispatch_unknown", "uncertain");
    if (receipt.reason) throw new OwnerActionError(receipt.reason, receipt.dispatchState);
    return receipt.dispatchState === "dispatched";
  }
  private rejectOptions(options: object | undefined): void {
    if (options && Object.values(options).some((value) => value !== undefined))
      throw new OwnerActionError("action_options_unsupported");
  }
  async goto(url: string, options?: GotoOpts): Promise<void> {
    this.rejectOptions(options);
    if (!(await this.action({ kind: "goto", url })))
      throw new OwnerActionError("navigation_blocked");
  }
  async click(selector: string | string[], options?: ActionOpts) {
    this.rejectOptions(options);
    return this.action({ kind: "click", selector: this.selector(selector) });
  }
  async hover(selector: string | string[], options?: ActionOpts) {
    this.rejectOptions(options);
    return this.action({ kind: "hover", selector: this.selector(selector) });
  }
  async fill(selector: string | string[], value: string, options?: FillOpts) {
    const { verify, ...unsupported } = options ?? {};
    this.rejectOptions(unsupported);
    return this.action({
      kind: "fill",
      selector: this.selector(selector),
      value,
      verify: verify === false ? false : verify === "normalized" ? "normalized" : "exact",
    });
  }
  async type(selector: string | string[], value: string, options?: TypeOpts) {
    this.rejectOptions(options);
    return this.action({ kind: "type", selector: this.selector(selector), value });
  }
  async select(selector: string | string[], value: string | string[], options?: ActionOpts) {
    this.rejectOptions(options);
    if (Array.isArray(value)) return this.unsupported();
    return this.action({ kind: "select", selector: this.selector(selector), value });
  }
  async check(selector: string | string[], options?: ActionOpts) {
    this.rejectOptions(options);
    return this.action({ kind: "check", selector: this.selector(selector), checked: true });
  }
  async press(key: string, options?: PressOpts): Promise<boolean> {
    this.rejectOptions(options);
    return this.action({ kind: "press", selector: ":focus", key });
  }
  async submit(selector?: string | string[], options?: SubmitOpts): Promise<boolean> {
    this.rejectOptions(options);
    if (!selector) return this.unsupported();
    return this.action({ kind: "submit", selector: this.selector(selector) });
  }
  async batch(steps: BatchStep[], options?: BatchOptions): Promise<BatchResult> {
    if (
      options &&
      Object.entries(options).some(
        ([key, value]) => value !== undefined && !(key === "onFail" && value === "stop"),
      )
    )
      throw new OwnerActionError("batch_options_unsupported");
    if (steps.length !== 1) throw new OwnerActionError("multi_action_batch_unsupported");
    const step = steps[0]!;
    const accepted = new Set([
      "action",
      "selector",
      "value",
      "key",
      "url",
      "effect",
      "anchor",
      "verify",
      "dangerous",
    ]);
    if (Object.entries(step).some(([key, value]) => value !== undefined && !accepted.has(key)))
      throw new OwnerActionError("batch_step_options_unsupported");
    const selector = "selector" in step ? this.selector(step.selector ?? []) : undefined;
    let action: OwnerAction;
    switch (step.action) {
      case "click":
      case "hover":
      case "submit":
        if (!selector) return this.unsupported();
        action = { kind: step.action, selector };
        break;
      case "fill":
      case "type":
      case "select":
        if (!selector || typeof step.value !== "string") return this.unsupported();
        action =
          step.action === "fill"
            ? {
                kind: "fill",
                selector,
                value: step.value,
                verify:
                  step.verify === false ? false : step.verify === "exact" ? "exact" : "normalized",
              }
            : { kind: step.action, selector, value: step.value };
        break;
      case "check":
        if (!selector) return this.unsupported();
        action = { kind: "check", selector, checked: true };
        break;
      case "goto":
        action = { kind: "goto", url: step.url ?? "" };
        break;
      case "press":
        if (typeof step.key !== "string") return this.unsupported();
        action = { kind: "press", selector: selector ?? ":focus", key: step.key };
        break;
      default:
        return this.unsupported();
    }
    const started = Date.now();
    let receipt: OwnerActionReceipt;
    try {
      receipt = await this.execute(action);
    } catch (error) {
      if (!(error instanceof OwnerActionError)) throw error;
      return {
        success: false,
        totalDurationMs: Date.now() - started,
        steps: [
          {
            index: 0,
            action: step.action,
            success: false,
            durationMs: Date.now() - started,
            error: error.reason,
            dispatchState: error.dispatchState,
            retrySafe: false,
          },
        ],
      };
    }
    const dispatchState = receipt.dispatchState === "unknown" ? "uncertain" : receipt.dispatchState;
    const success = dispatchState === "dispatched" && receipt.reason === undefined;
    return {
      success,
      totalDurationMs: Date.now() - started,
      steps: [
        {
          index: 0,
          action: step.action,
          success,
          durationMs: Date.now() - started,
          ...(selector ? { selectorUsed: selector } : {}),
          ...(receipt.reason ? { error: receipt.reason } : {}),
          dispatchState,
          retrySafe: receipt.retrySafe,
          receipt: { ...receipt, dispatchState },
        },
      ],
    };
  }
  async captureStateSignature(options?: SignatureOpts): Promise<string> {
    if (options?.maskSelectors?.length) return this.unsupported();
    const state = await this.observe("snapshot");
    if (!state.nodes) throw new OwnerActionError("snapshot_unavailable");
    const value =
      options?.mode === "structure"
        ? state.nodes.map((node) => [node.selector, node.role])
        : [state.text, state.nodes];
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(value)),
    );
    return `${state.url}|owner-projection-v1:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
}
export function ownerActionDriverFactory(options: OwnerActionDriverOptions): DriverFactory {
  return () => new OwnerActionDriver(options);
}
