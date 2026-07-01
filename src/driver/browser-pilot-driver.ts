// Flightplan — the REAL browser-pilot adapter.
//
// `BrowserPilotDriver implements Driver`. This is the ONLY file (besides the type re-exports
// in `types.ts`/`index.ts`) that imports the browser-pilot runtime. It owns a Chrome
// CONNECTION lifecycle (not merely a page): Mode A attaches to a BYO/debug Chrome and
// detaches without killing it; Mode B launches its own Chrome via chrome-launcher and kills
// it on teardown. Canonical reference: PLAN.md §3 (lifecycle table, gotchas-as-defaults).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as ChromeLauncher from "chrome-launcher";
// The single allowed `import ... from 'browser-pilot'` in the whole codebase.
import {
  type BatchOptions,
  type BatchResult,
  type Browser,
  captureStateSignature as bpCaptureStateSignature,
  captureStructureSignature as bpCaptureStructureSignature,
  connect as bpConnect,
  type Dialog,
  getBrowserWebSocketUrl,
  type Page,
  type PageSnapshot,
  type Step,
} from "browser-pilot";
import type { ConnectConfig } from "../config/types.ts";
import {
  buildAttachConnectArgs,
  buildLaunchPlan,
  normalizeBrowserUrl,
  type ResolvedAttachConnectArgs,
} from "./connect-resolution.ts";
import { clickStep, pressStep, resolveWaitForNavigation, submitOptions } from "./navigation.ts";
import type {
  ActionOpts,
  Driver,
  FillOpts,
  GotoOpts,
  PageHandle,
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

/** Native-dialog policy: how the driver answers `alert`/`confirm`/`beforeunload` dialogs. */
export type DialogPolicy = "dismiss" | "accept";

/** Constructor options for `BrowserPilotDriver`. */
export interface BrowserPilotDriverOptions {
  /**
   * How to auto-respond to native dialogs so flows never hang (PLAN §8 risk #2). Default
   * `'dismiss'` (cancels confirms, rejects beforeunload — the safe choice for automation).
   * `'accept'` confirms/OKs them.
   */
  dialogPolicy?: DialogPolicy;
}

/** Internal record of how the connection was acquired (drives teardown semantics). */
interface AttachConnection {
  kind: "attach";
  /** Tab names we opened with `newPage` so teardown closes only those. */
  openedPages: string[];
}
interface LaunchConnection {
  kind: "launch";
  chrome: ChromeLauncher.LaunchedChrome;
}
type Connection = AttachConnection | LaunchConnection;

/**
 * The real driver. Construct with optional dialog policy, then `connect(cfg)` → `page()` →
 * page ops → `teardown()`.
 */
export class BrowserPilotDriver implements Driver {
  private readonly dialogPolicy: DialogPolicy;
  private browser: Browser | undefined;
  private activePage: Page | undefined;
  private connection: Connection | undefined;
  /** Active opt-in recording (set by `startRecording`, cleared by `stopRecording`). */
  private recording: RecordOpts | undefined;

  constructor(options: BrowserPilotDriverOptions = {}) {
    this.dialogPolicy = options.dialogPolicy ?? "dismiss";
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async connect(cfg: ConnectConfig): Promise<void> {
    if (this.browser) {
      throw new Error("BrowserPilotDriver.connect: already connected (call teardown first)");
    }
    if (cfg.mode === "attach") {
      await this.connectAttach(cfg);
    } else {
      await this.connectLaunch(cfg);
    }
  }

  /** Mode A — attach to an existing/BYO Chrome; open a fresh tab; never kill on teardown. */
  private async connectAttach(cfg: Extract<ConnectConfig, { mode: "attach" }>): Promise<void> {
    // Resolve the ws URL per precedence: explicit wsUrl → browserURL → autodiscover.
    let resolvedWsUrl: string | undefined;
    if (cfg.wsUrl) {
      resolvedWsUrl = cfg.wsUrl;
    } else if (cfg.browserURL) {
      resolvedWsUrl = await getBrowserWebSocketUrl(normalizeBrowserUrl(cfg.browserURL));
    } // else: leave undefined → browser-pilot auto-discovers (may throw multiple-local-browsers)

    const args: ResolvedAttachConnectArgs = buildAttachConnectArgs(cfg, resolvedWsUrl);
    this.browser = await bpConnect(args);
    this.connection = { kind: "attach", openedPages: [] };

    // Acquire a page. Never hijack the user's current tab: open a fresh one unless an
    // explicit targetUrl asks to reuse a matching tab.
    if (cfg.targetUrl) {
      this.activePage = await this.browser.page(undefined, { targetUrl: cfg.targetUrl });
    } else {
      const before = await this.listPageNames();
      this.activePage = await this.browser.newPage();
      const after = await this.listPageNames();
      const opened = after.filter((n) => !before.includes(n));
      (this.connection as AttachConnection).openedPages.push(...opened);
    }
    await this.installDialogHandler();
  }

  /** Mode B — launch our own Chrome, connect, own the full lifecycle (kill on teardown). */
  private async connectLaunch(cfg: Extract<ConnectConfig, { mode: "launch" }>): Promise<void> {
    const plan = buildLaunchPlan(cfg);
    const launchOpts: ChromeLauncher.Options = { chromeFlags: plan.chromeFlags };
    if (plan.userDataDir) launchOpts.userDataDir = plan.userDataDir;
    if (plan.channel) launchOpts.chromePath = plan.channel; // channel→path is best-effort

    const chrome = await ChromeLauncher.launch(launchOpts);
    const version = (await (
      await fetch(`http://127.0.0.1:${chrome.port}/json/version`)
    ).json()) as { webSocketDebuggerUrl: string };

    this.browser = await bpConnect({ provider: "generic", wsUrl: version.webSocketDebuggerUrl });
    this.connection = { kind: "launch", chrome };
    // Fresh launched Chrome → its single blank tab.
    this.activePage = await this.browser.page();
    await this.installDialogHandler();
  }

  /** Register the dialog handler so native alert/confirm/beforeunload never hang the flow. */
  private async installDialogHandler(): Promise<void> {
    if (!this.activePage) return;
    const policy = this.dialogPolicy;
    await this.activePage.onDialog(async (dialog: Dialog) => {
      if (policy === "accept") {
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    });
  }

  private async listPageNames(): Promise<string[]> {
    if (!this.browser) return [];
    const targets = await this.browser.listTargets();
    return targets.map((t) => (t as { name?: string }).name ?? "").filter(Boolean);
  }

  async page(): Promise<PageHandle> {
    return this.requirePage();
  }

  async teardown(): Promise<void> {
    const conn = this.connection;
    const browser = this.browser;
    try {
      if (conn?.kind === "attach" && browser) {
        // Close only the tabs we opened; never touch the user's tabs.
        for (const name of conn.openedPages) {
          try {
            await browser.closePage(name);
          } catch {
            // tab may already be gone; non-fatal
          }
        }
      }
      if (browser) {
        await browser.disconnect(); // drops our CDP socket
      }
      if (conn?.kind === "launch") {
        await conn.chrome.kill(); // we own the launched Chrome → kill it
      }
    } finally {
      this.browser = undefined;
      this.activePage = undefined;
      this.connection = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // navigation
  // -------------------------------------------------------------------------

  async goto(url: string, opts?: GotoOpts): Promise<void> {
    const page = this.requirePage();
    // browser-pilot's `goto` accepts only ActionOptions (timeout/optional); it awaits the load
    // event internally. Pass the timeout through when given.
    if (opts?.timeout !== undefined) {
      await page.goto(url, { timeout: opts.timeout });
    } else {
      await page.goto(url);
    }
    // DRIVER DEFAULT (PLAN §3): settle any follow-on client-side navigation so the page is
    // quiescent for the next snapshot/assertion. `optional:true` → never throws if nothing
    // navigates (the common case: bp's goto already settled the top-level load).
    if (opts?.waitForNavigation ?? true) {
      await page.waitForNavigation({ optional: true, timeout: opts?.timeout ?? 2000 });
    }
  }

  async currentUrl(): Promise<string> {
    return this.requirePage().url();
  }

  // -------------------------------------------------------------------------
  // page operations
  // -------------------------------------------------------------------------

  async snapshot(opts?: SnapshotOpts): Promise<PageSnapshot> {
    const page = this.requirePage();
    // Phase 7 Change 3a: `attributes` is now a REAL browser-pilot 0.1.0 `SnapshotOptions` field.
    // When set, bp enriches each `interactiveElements[]` with real DOM `attributes`
    // (data-testid/id/class/name/type/…). We forward only the options the caller asked for, so
    // the default path (no roles/attributes) is byte-identical to before the bump.
    const bpOpts: { roles?: string[]; attributes?: boolean } = {};
    if (opts?.roles) bpOpts.roles = opts.roles;
    if (opts?.attributes) bpOpts.attributes = true;
    return Object.keys(bpOpts).length > 0 ? page.snapshot(bpOpts) : page.snapshot();
  }

  async resolveAll(intent: string, opts?: ResolveAllOpts): Promise<RankedCandidate[]> {
    // Phase 7 Change 3: delegate to browser-pilot 0.1.0's native `page.resolveAll`. Options map
    // 1:1 to bp's (our `strategies` is the shared `Strategy` union = bp's `CandidateStrategy`;
    // our `snapshot` is the re-exported bp `PageSnapshot`), so we pass them straight through.
    const page = this.requirePage();
    const ranked = opts ? await page.resolveAll(intent, opts) : await page.resolveAll(intent);
    // Map bp's `RankedCandidate` into the driver boundary shape field-for-field so the boundary
    // never leaks bp's type identity (the `_RankedCandidateMatchesBp` guard keeps this total).
    return ranked.map((c) => ({
      ref: c.ref,
      role: c.role,
      name: c.name,
      selector: c.selector,
      strategy: c.strategy,
      score: c.score,
    }));
  }

  async batch(steps: Step[], opts?: BatchOptions): Promise<BatchResult> {
    const page = this.requirePage();
    // DRIVER DEFAULT: any navigating step (click/submit/press) that did not set
    // `waitForNavigation` is defaulted to `true` so browser-pilot's `'auto'` never leaks.
    const settled = steps.map((s) => withNavigationDefault(s));
    // OPT-IN RECORDING (Phase 5, Unit F): when a recording session is active, enable
    // browser-pilot's screenshot-frame `record` mode so per-step frames + a `recording.json`
    // manifest land in the recording dir. INERT when not recording (`this.recording`
    // undefined) → `effective === opts`, i.e. behaviour is byte-identical to before. A caller
    // that already passed an explicit `record` wins (we never override it).
    const effective: BatchOptions | undefined = this.recording
      ? { ...opts, record: opts?.record ?? { outputDir: this.recording.dir } }
      : opts;
    return effective ? page.batch(settled, effective) : page.batch(settled);
  }

  // --- single actions ---

  async click(sel: string | string[], opts?: ActionOpts): Promise<boolean> {
    // Route through a one-step batch so `waitForNavigation` (default true) is honoured —
    // single-action `page.click` has no such option (its ActionOptions lacks the field).
    const page = this.requirePage();
    const result = await page.batch([clickStep(sel, opts)]);
    return firstStepSucceeded(result);
  }

  async fill(sel: string | string[], value: string, opts?: FillOpts): Promise<boolean> {
    const page = this.requirePage();
    const fillOpts: { timeout?: number; optional?: boolean; blur?: boolean; verify?: boolean } =
      {};
    if (opts?.timeout !== undefined) fillOpts.timeout = opts.timeout;
    if (opts?.optional !== undefined) fillOpts.optional = opts.optional;
    if (opts?.blur !== undefined) fillOpts.blur = opts.blur;
    if (opts?.verify !== undefined) fillOpts.verify = opts.verify;
    return page.fill(sel, value, fillOpts);
  }

  async type(sel: string | string[], text: string, opts?: TypeOpts): Promise<boolean> {
    const page = this.requirePage();
    const typeOpts: { timeout?: number; optional?: boolean; blur?: boolean; delay?: number } = {};
    if (opts?.timeout !== undefined) typeOpts.timeout = opts.timeout;
    if (opts?.optional !== undefined) typeOpts.optional = opts.optional;
    if (opts?.blur !== undefined) typeOpts.blur = opts.blur;
    if (opts?.delay !== undefined) typeOpts.delay = opts.delay;
    return page.type(sel, text, typeOpts);
  }

  async select(
    sel: string | string[],
    value: string | string[],
    opts?: ActionOpts,
  ): Promise<boolean> {
    const page = this.requirePage();
    const actionOpts = passThroughActionOpts(opts);
    return page.select(sel, value, actionOpts);
  }

  async check(sel: string | string[], opts?: ActionOpts): Promise<boolean> {
    const page = this.requirePage();
    return page.check(sel, passThroughActionOpts(opts));
  }

  async hover(sel: string | string[], opts?: ActionOpts): Promise<boolean> {
    const page = this.requirePage();
    return page.hover(sel, passThroughActionOpts(opts));
  }

  async press(key: string, opts?: { modifiers?: Array<"Control" | "Shift" | "Alt" | "Meta"> }):
    Promise<boolean> {
    // Route through batch so navigation settles (Enter often submits). `page.press` returns
    // void and never settles navigation; the one-step batch gives us both a boolean and the
    // forced `waitForNavigation`. Modifiers (if any) are applied via the direct press first.
    const page = this.requirePage();
    if (opts?.modifiers && opts.modifiers.length > 0) {
      await page.press(key, { modifiers: opts.modifiers });
      // best-effort settle after a modified keypress
      await page.waitForNavigation({ optional: true, timeout: 2000 });
      return true;
    }
    const result = await page.batch([pressStep(key, true)]);
    return firstStepSucceeded(result);
  }

  async submit(sel?: string | string[], opts?: SubmitOpts): Promise<boolean> {
    const page = this.requirePage();
    const sopts = submitOptions(opts);
    // browser-pilot's submit signature requires a selector; when none is given, submit the
    // ambient form via the empty-string selector (browser-pilot resolves the active form).
    const selector = sel ?? "";
    return page.submit(selector, sopts);
  }

  // --- screenshot ---

  async screenshot(opts?: ScreenshotOpts): Promise<string> {
    const page = this.requirePage();
    return opts ? page.screenshot(opts) : page.screenshot();
  }

  // -------------------------------------------------------------------------
  // video / frame recording (opt-in; gated by `[browser] record` in the runner — Unit E)
  // -------------------------------------------------------------------------

  /**
   * Begin recording into `opts.dir`. Stores the dir; subsequent `batch()` calls then enable
   * browser-pilot's screenshot-frame `record` mode into it (see `batch`). Does NOT require a
   * live page or throw — recording only engages once batches run (post-connect). Video must
   * never break a run, so this is always safe to call.
   */
  async startRecording(opts: RecordOpts): Promise<void> {
    this.recording = { dir: opts.dir };
  }

  /**
   * Stop recording. browser-pilot v0.0.18 records per-step screenshot frames + a
   * `recording.json` manifest (`BatchResult.recordingManifest`) into the recording dir — it
   * does NOT emit a single webm video (Risk V1). We therefore return `null` (no video
   * artifact); the captured frames remain on disk. When bp gains real video export, resolve and
   * return the produced video path here. Never throws.
   */
  async stopRecording(): Promise<string | null> {
    this.recording = undefined;
    return null;
  }

  /**
   * Persist one screenshot frame to `path`. `page.screenshot()` returns base64 (FINDINGS §7);
   * we decode and write the bytes, creating parent dirs as needed. FAIL-SAFE: any error (no
   * active page, IO failure) returns `null` and never throws — a screenshot failure must not
   * break a run.
   */
  async saveScreenshot(path: string, opts?: ScreenshotOpts): Promise<string | null> {
    try {
      const page = this.requirePage();
      const b64 = opts ? await page.screenshot(opts) : await page.screenshot();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(b64, "base64"));
      return path;
    } catch {
      return null;
    }
  }

  // --- ref persistence ---

  exportRefMap(): RefMap {
    return this.requirePage().exportRefMap();
  }

  importRefMap(map: RefMap): void {
    this.requirePage().importRefMap(map);
  }

  // --- page signature ---

  async captureStateSignature(opts?: SignatureOpts): Promise<string> {
    // Phase 7 Change 4: `opts.mode` is now REAL against browser-pilot 0.1.0.
    //  - 'structure' → bp's role-tree `captureStructureSignature` ("{urlPath}|{hash}").
    //  - 'text' / absent → bp's text-hash `captureStateSignature` ("{url}|{hash}") — the
    //    baseline, byte-identical to before, so default behaviour is unchanged.
    const page = this.requirePage();
    if (opts?.mode === "structure") {
      return bpCaptureStructureSignature(page);
    }
    return bpCaptureStateSignature(page);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private requirePage(): Page {
    if (!this.activePage) {
      throw new Error("BrowserPilotDriver: no active page (call connect() first)");
    }
    return this.activePage;
  }
}

// ---------------------------------------------------------------------------
// pure helpers (module-private)
// ---------------------------------------------------------------------------

/** Build the `ActionOptions` (optional/timeout) browser-pilot single-actions accept. */
function passThroughActionOpts(opts?: ActionOpts): { timeout?: number; optional?: boolean } {
  const out: { timeout?: number; optional?: boolean } = {};
  if (opts?.timeout !== undefined) out.timeout = opts.timeout;
  if (opts?.optional !== undefined) out.optional = opts.optional;
  return out;
}

/** The action verbs that can trigger navigation and so get the settle default. */
const NAVIGATING_ACTIONS = new Set(["click", "submit", "press"]);

/**
 * Apply the driver's navigation-settling default to a BATCH step (the ladder-driven path):
 * if it is a navigating action that did not set `waitForNavigation`, default it to `'auto'`.
 *
 * Why `'auto'` here (and NOT the single-action `true` from `resolveWaitForNavigation`): the
 * `batch` path is fed ladder-built steps where the click MAY be a real top-level navigation OR a
 * purely client-side handler (e.g. a wizard "Next" that just toggles `[hidden]` — extremely
 * common in SPA-style fixtures). Forcing `waitForNavigation:true` on a non-navigating click
 * blocks until a navigation that never happens → a hard `Navigation timeout` failure (verified
 * empirically against the /wizard fixture: `true` → 30s timeout+fail, `'auto'` → 29ms success).
 * browser-pilot's `'auto'` is purpose-built for exactly this: it RACES navigation detection
 * against a short settle delay, so it settles real navigations yet returns promptly for
 * client-side ones. The single-action `click`/`press`/`submit` wrappers keep the stricter `true`
 * default (the caller there directly intends to navigate); the batch path — which the L1 ladder
 * uses — needs the robust race. (FINDINGS §5; PLAN §3 gotchas.)
 */
export function withNavigationDefault(step: Step): Step {
  if (!NAVIGATING_ACTIONS.has(step.action) || step.waitForNavigation !== undefined) {
    return step;
  }
  return { ...step, waitForNavigation: "auto" };
}

/** Whether the first (only) step of a one-step batch result succeeded. */
function firstStepSucceeded(result: BatchResult): boolean {
  const first = result.steps[0];
  return first ? first.success : result.success;
}
