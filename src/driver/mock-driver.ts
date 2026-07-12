// Flightplan — MockDriver, the in-memory testing seam.
//
// `MockDriver implements Driver` with ZERO browser-pilot / Chrome / network dependency. It
// is THE contract that the ladder, lock, and assert agents depend on for unit tests: a fully
// scriptable driver whose snapshots, batch results, per-action outcomes, signatures, and
// screenshots are all configured by the test, with a recorded call log to assert what was
// invoked.
//
// =========================================================================================
// SCRIPTING API (read this before writing a test)
// =========================================================================================
//
// Construct: `const d = new MockDriver()` (optionally with `new MockDriver({ ...defaults })`).
//
// DEFAULTS (returned whenever no queued value is pending):
//   d.setSnapshot(snapshot)                  // PageSnapshot returned by snapshot()
//   d.setBatchResult(batchResult)            // BatchResult returned by batch()
//   d.setSignature("https://x|abc123")       // string from captureStateSignature() (text mode)
//   d.setStructureSignature("x|struct")       // string from captureStateSignature({mode:'structure'})
//   d.setResolveAll([cand1, cand2])           // RankedCandidate[] returned by resolveAll()
//   d.setElementState({exists,visible,count,text,boundingBox}) // ElementState from elementState()
//   d.setScreenshot("<base64>")               // string returned by screenshot()
//   d.setActionOutcome(true|false)            // boolean returned by every single action
//   d.setActionOutcome(false, "click")        // ...or scope the default to one action verb
//
// QUEUES (one-shot, consumed FIFO before falling back to the default):
//   d.enqueueSnapshot(s1); d.enqueueSnapshot(s2)   // snapshot() returns s1 then s2 then default
//   d.enqueueBatchResult(r1)                        // batch() returns r1 once, then default
//   d.enqueueSignature("u|h")                       // captureStateSignature() (text) one-shot
//   d.enqueueStructureSignature("u|s")              // captureStateSignature({mode:'structure'}) one-shot
//   d.enqueueResolveAll([cand])                     // resolveAll() one-shot
//   d.enqueueElementState(state)                    // elementState() one-shot
//   d.enqueueScreenshot("b64")                      // screenshot() one-shot
//   d.enqueueActionOutcome(true, "click")           // next click() returns true (verb optional)
//
// BY-SELECTOR / BY-INTENT OUTCOMES (most specific wins; checked before queues/defaults):
//   d.setOutcomeForSelector("[data-testid='x']", true)   // matches the action's selector
//   These let ladder tests simulate "L1 strategy testid wins" / "all strategies fail".
//
// DYNAMIC SCRIPTING (full control):
//   d.onBatch((steps, opts, callIndex) => BatchResult)    // compute a BatchResult per call
//   d.onSnapshot((opts, callIndex) => PageSnapshot)
//   d.onResolveAll((intent, opts, callIndex) => RankedCandidate[])
//   d.onElementState((selector, callIndex) => ElementState)  // compute per selector per call
//   A function provider takes precedence over queues and defaults.
//
// CALL LOG (assert what happened):
//   d.calls                       // ordered DriverCall[] of every method invoked
//   d.callsTo("click")            // filtered to one method
//   d.lastCall                    // the most recent call
//   d.reset()                     // clear the call log + queues + providers (keeps defaults)
//
// LIFECYCLE:
//   d.connect(cfg) / d.page() / d.teardown() are recorded; connect stores the config as
//   d.lastConnectConfig. `page()` returns an opaque sentinel handle (tests rarely need it).
//
// Helper FIXTURE FACTORIES (convenience for building canned data) live in
// `./mock-fixtures.ts`.

import type { ConnectConfig } from "../config/types.ts";
import type {
  ActionOpts,
  BatchOptions,
  BatchResult,
  BatchStep,
  Driver,
  ElementState,
  FillOpts,
  GotoOpts,
  NativeDialogPolicy,
  NewPageExpectation,
  NewPageResult,
  PageHandle,
  PageSnapshot,
  PageStateObservation,
  RankedCandidate,
  RecordOpts,
  RefMap,
  ResolveAllOpts,
  ScreenshotOpts,
  SignatureOpts,
  SnapshotOpts,
  SubmitOpts,
  TypeOpts,
} from "./types.ts";

/** A single recorded driver method invocation. */
export interface DriverCall {
  /** The driver method name. */
  method:
    | "connect"
    | "page"
    | "teardown"
    | "setDialogPolicy"
    | "expectNewPage"
    | "pageState"
    | "clearBrowserState"
    | "goto"
    | "currentUrl"
    | "switchToFrame"
    | "switchToMain"
    | "snapshot"
    | "batch"
    | "resolveAll"
    | "elementState"
    | "locateSelectorFrame"
    | "click"
    | "fill"
    | "type"
    | "select"
    | "check"
    | "hover"
    | "press"
    | "submit"
    | "screenshot"
    | "startRecording"
    | "stopRecording"
    | "saveScreenshot"
    | "exportRefMap"
    | "importRefMap"
    | "captureStateSignature";
  /** Positional arguments the method was called with (best-effort, shallow). */
  args: unknown[];
  /** Monotonic call index (0-based) across ALL methods. */
  index: number;
}

/** The single-action verbs (each returns `Promise<boolean>`). */
type ActionVerb = "click" | "fill" | "type" | "select" | "check" | "hover" | "press" | "submit";

/** Initial defaults a `MockDriver` can be constructed with. */
export interface MockDriverDefaults {
  snapshot?: PageSnapshot;
  batchResult?: BatchResult;
  signature?: string;
  /** Default returned by `captureStateSignature({ mode: 'structure' })` (Phase 7 Change 4). */
  structureSignature?: string;
  screenshot?: string;
  /** Default returned by `resolveAll()` (Phase 7 Change 3). Defaults to `[]`. */
  resolveAll?: RankedCandidate[];
  /**
   * Default returned by `elementState()`. Defaults to the "no such element" state
   * `{ exists:false, visible:false, count:0, text:"", boundingBox:null }`.
   */
  elementState?: ElementState;
  /** Default boolean for every single action. Defaults to `true`. */
  actionOutcome?: boolean;
}

/** A sentinel page handle the mock returns from `page()`. */
export const MOCK_PAGE_HANDLE: PageHandle = Object.freeze({ __mockPage: true });

const EMPTY_SNAPSHOT: PageSnapshot = {
  url: "about:blank",
  title: "",
  timestamp: new Date(0).toISOString(),
  accessibilityTree: [],
  interactiveElements: [],
  text: "",
};

const EMPTY_BATCH_RESULT: BatchResult = {
  steps: [],
  success: true,
  totalDurationMs: 0,
};

/** The "no such element" default `elementState()` returns when nothing is scripted. */
const ABSENT_ELEMENT_STATE: ElementState = {
  exists: false,
  visible: false,
  count: 0,
  text: "",
  value: null,
  boundingBox: null,
};

/**
 * A fully-scriptable, dependency-free `Driver` for unit tests. See the file header for the
 * complete scripting API.
 */
export class MockDriver implements Driver {
  // --- call log ---
  readonly calls: DriverCall[] = [];
  private callCounter = 0;

  // --- lifecycle state ---
  lastConnectConfig: ConnectConfig | undefined;
  connected = false;

  // --- defaults ---
  private defaultSnapshot: PageSnapshot;
  private defaultBatchResult: BatchResult;
  private defaultSignature: string;
  private defaultStructureSignature: string;
  private defaultScreenshot: string;
  private defaultResolveAll: RankedCandidate[];
  private defaultElementState: ElementState;
  private defaultActionOutcome: boolean;
  private defaultActionOutcomeByVerb = new Map<ActionVerb, boolean>();

  // --- queues (FIFO, one-shot) ---
  private snapshotQueue: PageSnapshot[] = [];
  private batchQueue: BatchResult[] = [];
  private signatureQueue: string[] = [];
  private structureSignatureQueue: string[] = [];
  private screenshotQueue: string[] = [];
  private resolveAllQueue: RankedCandidate[][] = [];
  private elementStateQueue: ElementState[] = [];
  private actionQueue: Array<{ verb?: ActionVerb; outcome: boolean }> = [];

  // --- by-selector outcomes ---
  private outcomeBySelector = new Map<string, boolean>();

  // --- iframe-context probing (locateSelectorFrame) ---
  /** Scripted `locateSelectorFrame` verdicts by selector; presence installs the method (lazily). */
  private selectorFrameMap?: Map<string, "main" | "iframe" | "none">;

  // --- navigation state ---
  /** The URL returned by `currentUrl()`; updated by `goto()` and `setCurrentUrl()`. */
  private currentUrlValue = "about:blank";
  /** One-shot URLs returned by `currentUrl()` (consumed FIFO before the default). */
  private currentUrlQueue: string[] = [];

  // --- frame-switch state ---
  /**
   * The mock "current frame" selector — `null` on the top document, set by `switchToFrame()`, and
   * reset to `null` by `switchToMain()`, `goto()` (navigation) and `teardown()`. Tests read it via
   * `currentFrame()` to assert the driver was switched into (and back out of) a frame.
   */
  private currentFrameValue: string | null = null;
  private pageStateValue: PageStateObservation = {};
  private newPageResultValue: NewPageResult = { matched: true, targetId: "mock-popup" };
  /** What `switchToFrame()` returns (default `true` = frame entered). Override via `setSwitchFrameOutcome`. */
  private switchFrameOutcome = true;

  // --- dynamic providers ---
  private snapshotProvider?: (opts: SnapshotOpts | undefined, callIndex: number) => PageSnapshot;
  private batchProvider?: (
    steps: BatchStep[],
    opts: BatchOptions | undefined,
    callIndex: number,
  ) => BatchResult;
  private resolveAllProvider?: (
    intent: string,
    opts: ResolveAllOpts | undefined,
    callIndex: number,
  ) => RankedCandidate[];
  private elementStateProvider?: (selector: string, callIndex: number) => ElementState;

  // --- ref map (round-trips through export/import) ---
  private refMap: RefMap = {};

  // --- video / recording state (Phase 5, Unit F) ---
  /** What `stopRecording()` returns. Default `null` = graceful "no video produced". */
  private videoPath: string | null = null;
  /** The dir most recently passed to `startRecording()` (exposed via `lastRecordingDir`). */
  private recordingDir: string | undefined;
  /** Override for `saveScreenshot()`'s return; when unset it echoes the requested `path`. */
  private savedScreenshotPath: string | null = null;
  private savedScreenshotPathSet = false;

  constructor(defaults: MockDriverDefaults = {}) {
    this.defaultSnapshot = defaults.snapshot ?? structuredClone(EMPTY_SNAPSHOT);
    this.defaultBatchResult = defaults.batchResult ?? structuredClone(EMPTY_BATCH_RESULT);
    this.defaultSignature = defaults.signature ?? "about:blank|0";
    this.defaultStructureSignature = defaults.structureSignature ?? "about:blank|struct0";
    this.defaultScreenshot = defaults.screenshot ?? "";
    this.defaultResolveAll = defaults.resolveAll ?? [];
    this.defaultElementState = defaults.elementState ?? structuredClone(ABSENT_ELEMENT_STATE);
    this.defaultActionOutcome = defaults.actionOutcome ?? true;
  }

  // =========================================================================
  // scripting API — defaults
  // =========================================================================

  setSnapshot(snapshot: PageSnapshot): this {
    this.defaultSnapshot = snapshot;
    return this;
  }
  setBatchResult(result: BatchResult): this {
    this.defaultBatchResult = result;
    return this;
  }
  setSignature(signature: string): this {
    this.defaultSignature = signature;
    return this;
  }
  /**
   * Set the default returned by `captureStateSignature({ mode: 'structure' })` (Phase 7
   * Change 4). Text-mode signatures are unaffected (they still use `setSignature`).
   */
  setStructureSignature(signature: string): this {
    this.defaultStructureSignature = signature;
    return this;
  }
  setScreenshot(screenshot: string): this {
    this.defaultScreenshot = screenshot;
    return this;
  }
  /** Set the default ranked-candidate list returned by `resolveAll()` (Phase 7 Change 3). */
  setResolveAll(candidates: RankedCandidate[]): this {
    this.defaultResolveAll = candidates;
    return this;
  }
  /** Set the default {@link ElementState} returned by `elementState()`. */
  setElementState(state: ElementState): this {
    this.defaultElementState = state;
    return this;
  }
  /**
   * Configure the fake video path `stopRecording()` returns. Pass `null` (the default) to
   * simulate browser-pilot's graceful "no webm produced" degrade (Risk V1).
   */
  setVideoPath(path: string | null): this {
    this.videoPath = path;
    return this;
  }
  /**
   * Configure what `saveScreenshot()` returns. When unset, `saveScreenshot(path)` echoes the
   * requested `path` (the "frame persisted" happy path). Pass `null` to simulate a failed
   * persist (graceful degrade).
   */
  setSavedScreenshotPath(path: string | null): this {
    this.savedScreenshotPath = path;
    this.savedScreenshotPathSet = true;
    return this;
  }
  /** Set the URL returned by `currentUrl()` (also what `goto()` sets the page to). */
  setCurrentUrl(url: string): this {
    this.currentUrlValue = url;
    return this;
  }
  setDialogPolicyValue(policy: NativeDialogPolicy): this {
    void policy;
    return this;
  }
  setPageState(state: PageStateObservation): this {
    this.pageStateValue = state;
    return this;
  }
  setNewPageResult(result: NewPageResult): this {
    this.newPageResultValue = result;
    return this;
  }
  /** Set the boolean `switchToFrame()` returns (default `true`; `false` simulates an unfound frame). */
  setSwitchFrameOutcome(outcome: boolean): this {
    this.switchFrameOutcome = outcome;
    return this;
  }
  /** Set the default action boolean (optionally scoped to one verb). */
  setActionOutcome(outcome: boolean, verb?: ActionVerb): this {
    if (verb) {
      this.defaultActionOutcomeByVerb.set(verb, outcome);
    } else {
      this.defaultActionOutcome = outcome;
    }
    return this;
  }

  // =========================================================================
  // scripting API — queues
  // =========================================================================

  enqueueSnapshot(...snapshots: PageSnapshot[]): this {
    this.snapshotQueue.push(...snapshots);
    return this;
  }
  enqueueBatchResult(...results: BatchResult[]): this {
    this.batchQueue.push(...results);
    return this;
  }
  enqueueSignature(...signatures: string[]): this {
    this.signatureQueue.push(...signatures);
    return this;
  }
  /** Queue one-shot `mode:'structure'` signatures (FIFO, before the structure default). */
  enqueueStructureSignature(...signatures: string[]): this {
    this.structureSignatureQueue.push(...signatures);
    return this;
  }
  enqueueScreenshot(...screenshots: string[]): this {
    this.screenshotQueue.push(...screenshots);
    return this;
  }
  /** Queue one-shot `resolveAll()` results (FIFO, consumed before the default). */
  enqueueResolveAll(...results: RankedCandidate[][]): this {
    this.resolveAllQueue.push(...results);
    return this;
  }
  /** Queue one-shot `elementState()` results (FIFO, consumed before the default). */
  enqueueElementState(...states: ElementState[]): this {
    this.elementStateQueue.push(...states);
    return this;
  }
  /** Queue one-shot URLs returned by `currentUrl()` (FIFO, before the default). */
  enqueueCurrentUrl(...urls: string[]): this {
    this.currentUrlQueue.push(...urls);
    return this;
  }
  enqueueActionOutcome(outcome: boolean, verb?: ActionVerb): this {
    this.actionQueue.push(verb ? { verb, outcome } : { outcome });
    return this;
  }

  // =========================================================================
  // scripting API — by-selector + dynamic providers
  // =========================================================================

  /**
   * Script `locateSelectorFrame(selector)` to return `verdict`. The FIRST call INSTALLS the method
   * on this instance — until then `driver.locateSelectorFrame` is `undefined`, so L1's iframe guard
   * feature-detects it as absent and every test that does not opt in is unaffected. Once installed,
   * an unscripted selector returns `'none'`. Calls are recorded in the call log (`callsTo`).
   */
  setSelectorFrame(selector: string, verdict: "main" | "iframe" | "none"): this {
    if (!this.selectorFrameMap) {
      const map = new Map<string, "main" | "iframe" | "none">();
      this.selectorFrameMap = map;
      (this as Driver).locateSelectorFrame = async (sel: string) => {
        this.record("locateSelectorFrame", [sel]);
        return map.get(sel) ?? "none";
      };
    }
    this.selectorFrameMap.set(selector, verdict);
    return this;
  }

  /** Force an action's outcome when its selector exactly matches `selector`. */
  setOutcomeForSelector(selector: string, outcome: boolean): this {
    this.outcomeBySelector.set(selector, outcome);
    return this;
  }
  /** Provide a function that computes the `snapshot()` return per call. Highest precedence. */
  onSnapshot(fn: (opts: SnapshotOpts | undefined, callIndex: number) => PageSnapshot): this {
    this.snapshotProvider = fn;
    return this;
  }
  /** Provide a function that computes the `batch()` return per call. Highest precedence. */
  onBatch(
    fn: (steps: BatchStep[], opts: BatchOptions | undefined, callIndex: number) => BatchResult,
  ): this {
    this.batchProvider = fn;
    return this;
  }
  /** Provide a function that computes the `resolveAll()` return per call. Highest precedence. */
  onResolveAll(
    fn: (intent: string, opts: ResolveAllOpts | undefined, callIndex: number) => RankedCandidate[],
  ): this {
    this.resolveAllProvider = fn;
    return this;
  }
  /**
   * Provide a function that computes the `elementState()` return per call (keyed on the queried
   * `selector`). Highest precedence — takes priority over the queue and the default.
   */
  onElementState(fn: (selector: string, callIndex: number) => ElementState): this {
    this.elementStateProvider = fn;
    return this;
  }

  // =========================================================================
  // call-log helpers
  // =========================================================================

  get lastCall(): DriverCall | undefined {
    return this.calls[this.calls.length - 1];
  }
  /** The dir most recently passed to `startRecording()` (or `undefined` if never started). */
  get lastRecordingDir(): string | undefined {
    return this.recordingDir;
  }
  callsTo(method: DriverCall["method"]): DriverCall[] {
    return this.calls.filter((c) => c.method === method);
  }
  /** Clear the call log, queues, and dynamic providers. Keeps the configured defaults. */
  reset(): this {
    this.calls.length = 0;
    this.callCounter = 0;
    this.snapshotQueue = [];
    this.batchQueue = [];
    this.signatureQueue = [];
    this.structureSignatureQueue = [];
    this.screenshotQueue = [];
    this.resolveAllQueue = [];
    this.elementStateQueue = [];
    this.actionQueue = [];
    this.currentUrlQueue = [];
    this.outcomeBySelector.clear();
    this.snapshotProvider = undefined;
    this.batchProvider = undefined;
    this.resolveAllProvider = undefined;
    this.elementStateProvider = undefined;
    this.recordingDir = undefined;
    return this;
  }

  private record(method: DriverCall["method"], args: unknown[]): void {
    this.calls.push({ method, args, index: this.callCounter++ });
  }

  // =========================================================================
  // Driver — lifecycle
  // =========================================================================

  async connect(cfg: ConnectConfig): Promise<void> {
    this.record("connect", [cfg]);
    this.lastConnectConfig = cfg;
    this.connected = true;
  }

  async page(): Promise<PageHandle> {
    this.record("page", []);
    return MOCK_PAGE_HANDLE;
  }

  async teardown(): Promise<void> {
    this.record("teardown", []);
    this.connected = false;
    this.currentFrameValue = null;
  }

  setDialogPolicy(policy: NativeDialogPolicy): void {
    this.record("setDialogPolicy", [policy]);
  }

  async expectNewPage(
    expectation: NewPageExpectation,
    action: () => Promise<unknown>,
  ): Promise<NewPageResult> {
    this.record("expectNewPage", [expectation]);
    await action();
    return this.newPageResultValue;
  }

  async pageState(): Promise<PageStateObservation> {
    this.record("pageState", []);
    return this.pageStateValue;
  }

  /** Recorded no-op — there is no real browser state to clear in the mock (isolation seam). */
  async clearBrowserState(): Promise<void> {
    this.record("clearBrowserState", []);
  }

  // =========================================================================
  // Driver — navigation
  // =========================================================================

  async goto(url: string, opts?: GotoOpts): Promise<void> {
    this.record("goto", [url, opts]);
    // Record the nav by advancing the page URL; tests read it back via currentUrl() or the
    // call log, and may override the resulting snapshot via enqueueSnapshot/onSnapshot.
    this.currentUrlValue = url;
    // A navigation resets the frame context to the top document (mirrors browser-pilot + the real
    // driver): a target that follows a `goto` resolves against the top document, never a stale frame.
    this.currentFrameValue = null;
  }

  async currentUrl(): Promise<string> {
    this.record("currentUrl", []);
    const queued = this.currentUrlQueue.shift();
    return queued ?? this.currentUrlValue;
  }

  // =========================================================================
  // Driver — frame switching
  // =========================================================================

  /** Record the switch and advance the mock current-frame; returns the configured outcome. */
  async switchToFrame(selector: string | string[]): Promise<boolean> {
    this.record("switchToFrame", [selector]);
    if (this.switchFrameOutcome) {
      this.currentFrameValue = Array.isArray(selector) ? (selector[0] ?? null) : selector;
    }
    return this.switchFrameOutcome;
  }

  /** Record the return to the top document and clear the mock current-frame. */
  async switchToMain(): Promise<void> {
    this.record("switchToMain", []);
    this.currentFrameValue = null;
  }

  /** The mock "current frame" selector (`null` on the top document). */
  currentFrame(): string | null {
    return this.currentFrameValue;
  }

  // =========================================================================
  // Driver — page operations
  // =========================================================================

  async snapshot(opts?: SnapshotOpts): Promise<PageSnapshot> {
    const callIndex = this.callCounter;
    this.record("snapshot", [opts]);
    const snap = this.snapshotProvider
      ? this.snapshotProvider(opts, callIndex)
      : (this.snapshotQueue.shift() ?? this.defaultSnapshot);
    return applyAttributesPolicy(snap, opts);
  }

  async batch(steps: BatchStep[], opts?: BatchOptions): Promise<BatchResult> {
    const callIndex = this.callCounter;
    this.record("batch", [steps, opts]);
    if (this.batchProvider) return this.batchProvider(steps, opts, callIndex);
    const queued = this.batchQueue.shift();
    return queued ?? this.defaultBatchResult;
  }

  async resolveAll(intent: string, opts?: ResolveAllOpts): Promise<RankedCandidate[]> {
    const callIndex = this.callCounter;
    this.record("resolveAll", [intent, opts]);
    if (this.resolveAllProvider) return this.resolveAllProvider(intent, opts, callIndex);
    const queued = this.resolveAllQueue.shift();
    return queued ?? this.defaultResolveAll;
  }

  async elementState(selector: string): Promise<ElementState> {
    const callIndex = this.callCounter;
    this.record("elementState", [selector]);
    // Precedence mirrors resolveAll/snapshot: dynamic provider → one-shot queue → default.
    if (this.elementStateProvider) return this.elementStateProvider(selector, callIndex);
    const queued = this.elementStateQueue.shift();
    return queued ?? this.defaultElementState;
  }

  // =========================================================================
  // Driver — single actions
  // =========================================================================

  async click(sel: string | string[], opts?: ActionOpts): Promise<boolean> {
    this.record("click", [sel, opts]);
    return this.actionOutcome("click", sel);
  }
  async fill(sel: string | string[], value: string, opts?: FillOpts): Promise<boolean> {
    this.record("fill", [sel, value, opts]);
    return this.actionOutcome("fill", sel);
  }
  async type(sel: string | string[], text: string, opts?: TypeOpts): Promise<boolean> {
    this.record("type", [sel, text, opts]);
    return this.actionOutcome("type", sel);
  }
  async select(
    sel: string | string[],
    value: string | string[],
    opts?: ActionOpts,
  ): Promise<boolean> {
    this.record("select", [sel, value, opts]);
    return this.actionOutcome("select", sel);
  }
  async check(sel: string | string[], opts?: ActionOpts): Promise<boolean> {
    this.record("check", [sel, opts]);
    return this.actionOutcome("check", sel);
  }
  async hover(sel: string | string[], opts?: ActionOpts): Promise<boolean> {
    this.record("hover", [sel, opts]);
    return this.actionOutcome("hover", sel);
  }
  async press(key: string, opts?: unknown): Promise<boolean> {
    this.record("press", [key, opts]);
    return this.actionOutcome("press", undefined);
  }
  async submit(sel?: string | string[], opts?: SubmitOpts): Promise<boolean> {
    this.record("submit", [sel, opts]);
    return this.actionOutcome("submit", sel);
  }

  // =========================================================================
  // Driver — screenshot / refs / signature
  // =========================================================================

  async screenshot(opts?: ScreenshotOpts): Promise<string> {
    this.record("screenshot", [opts]);
    const queued = this.screenshotQueue.shift();
    return queued ?? this.defaultScreenshot;
  }

  // =========================================================================
  // Driver — video / frame recording (Phase 5, Unit F)
  // =========================================================================

  /** Record the start of a recording session into `opts.dir` (no real capture). */
  async startRecording(opts: RecordOpts): Promise<void> {
    this.record("startRecording", [opts]);
    this.recordingDir = opts.dir;
  }

  /** Return the configured fake video path (default `null` = graceful no-video). */
  async stopRecording(): Promise<string | null> {
    this.record("stopRecording", []);
    return this.videoPath;
  }

  /**
   * Record a frame-persist to `path` and return a fake artifact path: the configured override
   * (via `setSavedScreenshotPath`), else the requested `path` echoed back.
   */
  async saveScreenshot(path: string, opts?: ScreenshotOpts): Promise<string | null> {
    this.record("saveScreenshot", [path, opts]);
    return this.savedScreenshotPathSet ? this.savedScreenshotPath : path;
  }

  exportRefMap(): RefMap {
    this.record("exportRefMap", []);
    return { ...this.refMap };
  }
  importRefMap(map: RefMap): void {
    this.record("importRefMap", [map]);
    this.refMap = { ...map };
  }

  async captureStateSignature(opts?: SignatureOpts): Promise<string> {
    this.record("captureStateSignature", [opts]);
    // Phase 7 Change 4: `mode:'structure'` draws from a SEPARATE structure signature
    // queue/default so tests can exercise both modes deterministically. Text mode (default/
    // absent) is unchanged — it still consumes the text signature queue/default.
    if (opts?.mode === "structure") {
      const queued = this.structureSignatureQueue.shift();
      return queued ?? this.defaultStructureSignature;
    }
    const queued = this.signatureQueue.shift();
    return queued ?? this.defaultSignature;
  }

  // =========================================================================
  // outcome resolution (most specific → least)
  //   1. by-selector (any matching selector string)
  //   2. queued outcome (verb-scoped queue entry matches; unscoped matches any)
  //   3. verb default → 4. global default
  // =========================================================================

  private actionOutcome(verb: ActionVerb, sel: string | string[] | undefined): boolean {
    // 1. by-selector
    if (sel !== undefined) {
      const selectors = Array.isArray(sel) ? sel : [sel];
      for (const s of selectors) {
        const hit = this.outcomeBySelector.get(s);
        if (hit !== undefined) return hit;
      }
    }
    // 2. queued (skip-and-keep entries scoped to a different verb)
    for (let i = 0; i < this.actionQueue.length; i++) {
      const entry = this.actionQueue[i]!;
      if (entry.verb === undefined || entry.verb === verb) {
        this.actionQueue.splice(i, 1);
        return entry.outcome;
      }
    }
    // 3. verb default
    const verbDefault = this.defaultActionOutcomeByVerb.get(verb);
    if (verbDefault !== undefined) return verbDefault;
    // 4. global default
    return this.defaultActionOutcome;
  }
}

// ---------------------------------------------------------------------------
// pure helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Mirror the real driver's attribute policy (Phase 7 Change 3a): browser-pilot only populates
 * `interactiveElements[].attributes` when the snapshot is taken with `attributes: true`. So the
 * mock RETURNS attributes only when the caller requested them; otherwise it strips any the
 * fixture carried, so a test that omits `attributes:true` sees the lean default shape exactly
 * as the real driver would produce it. Object identity is preserved when there is nothing to
 * strip (no element carries `attributes`), so existing snapshot fixtures round-trip untouched.
 */
function applyAttributesPolicy(snap: PageSnapshot, opts?: SnapshotOpts): PageSnapshot {
  if (opts?.attributes) return snap; // requested → attributes pass through as-is
  const hasAttrs = snap.interactiveElements.some((el) => el.attributes !== undefined);
  if (!hasAttrs) return snap; // nothing to strip → preserve identity (byte-identical behaviour)
  return {
    ...snap,
    interactiveElements: snap.interactiveElements.map((el) => {
      const { attributes: _dropped, ...rest } = el;
      return rest;
    }),
  };
}
