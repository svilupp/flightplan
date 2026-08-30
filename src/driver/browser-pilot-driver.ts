// Flightplan — the REAL browser-pilot adapter.
//
// `BrowserPilotDriver implements Driver`. This is the ONLY file (besides the type re-exports
// in `types.ts`/`index.ts`) that imports the browser-pilot runtime. It owns a Chrome
// CONNECTION lifecycle (not merely a page): Mode A attaches to a BYO/debug Chrome and
// detaches without killing it; Mode B launches its own Chrome via chrome-launcher and kills
// it on teardown. Canonical reference: PLAN.md §3 (lifecycle table, gotchas-as-defaults).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
// The single allowed `import ... from 'browser-pilot'` in the whole codebase.
import {
  type EmitWsOptions as BpEmitWsOptions,
  type Browser,
  captureStateSignature as bpCaptureStateSignature,
  captureStructureSignature as bpCaptureStructureSignature,
  connect as bpConnect,
  webmcpCall as bpWebmcpCall,
  webmcpList as bpWebmcpList,
  type Dialog,
  type ExpectNewPageOptions,
  getBrowserWebSocketUrl,
  getBuildProvenance,
  // `mintCfAccessJwt` is a newer browser-pilot export (the `cloudflare-access-auth` proposal's
  // Slice 6 requirement). Imported normally since the pinned browser-pilot build carries it, but
  // `applyAuth` still feature-detects it at the call site (`typeof mintCfAccessJwt === "function"`)
  // so a driver built against an older browser-pilot that predates this export degrades to a clear
  // error instead of a hard import-time crash.
  mintCfAccessJwt,
  type Page,
  type PageSnapshot,
  type Step,
  TargetNotFoundError,
} from "browser-pilot";
import * as ChromeLauncher from "chrome-launcher";
import type { AuthConfig, ConnectConfig } from "../config/types.ts";
import {
  buildAttachConnectArgs,
  buildLaunchPlan,
  normalizeBrowserUrl,
  type ResolvedAttachConnectArgs,
  resolveAuthPlan,
} from "./connect-resolution.ts";
import { normalizeBatchResult } from "./dispatch-metadata.ts";
import { clickStep, pressStep, submitOptions } from "./navigation.ts";
import { normalizeSelectorArg } from "./normalize-selector.ts";
import type {
  ActionOpts,
  BatchOptions,
  BatchResult,
  BrowserPilotProvenance,
  Driver,
  ElementState,
  EmitCommandOptions,
  EmitCommandResult,
  EvalOptions,
  EvalResult,
  FillOpts,
  GotoOpts,
  NativeDialogPolicy,
  NewPageExpectation,
  NewPageResult,
  PageHandle,
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
  WebMcpCallOptions,
  WebMcpCallResult,
  WebMcpListResult,
} from "./types.ts";

/** Native-dialog policy: how the driver answers `alert`/`confirm`/`beforeunload` dialogs. */
export type DialogPolicy = NativeDialogPolicy;

/**
 * Default actionability/click ceiling (ms) applied to every batch + single action when the
 * caller/step sets none. It BOUNDS browser-pilot's own ~30s actionability default so a
 * disabled/wrong leading selector fails fast (≈5s) and escalates instead of dead-hanging (the
 * measured admin-crud 30s L0 stall). Overridable per driver via `BrowserPilotDriverOptions`
 * (`[timeouts] action_ms`) and per action via a per-step `Step.timeout` (browser-pilot honors a
 * step's own timeout over the batch-level default).
 */
export const DEFAULT_ACTION_TIMEOUT_MS = 5000;
/**
 * Default client-side navigation-SETTLE ceiling (ms) for the post-`goto`/`press`
 * `waitForNavigation({ optional:true })` wait (`[timeouts] nav_ms`).
 */
export const DEFAULT_NAV_TIMEOUT_MS = 2000;

/** Read the browser-pilot package/source/build identity without opening a browser connection. */
export function getBrowserPilotProvenance(): BrowserPilotProvenance {
  return getBuildProvenance();
}

/** Constructor options for `BrowserPilotDriver`. */
export interface BrowserPilotDriverOptions {
  /**
   * How to auto-respond to native dialogs so flows never hang (PLAN §8 risk #2). Default
   * `'dismiss'` (cancels confirms, rejects beforeunload — the safe choice for automation).
   * `'accept'` confirms/OKs them.
   */
  dialogPolicy?: DialogPolicy;
  /**
   * Default actionability/click timeout (ms) applied to every `batch()` + single action when the
   * caller/step sets none — the resolved `[timeouts] action_ms` (default
   * {@link DEFAULT_ACTION_TIMEOUT_MS} = 5000). It becomes the batch-level `BatchOptions.timeout`,
   * so it BOUNDS browser-pilot's ~30s actionability default (the measured 30s L0/click hang) while
   * a per-step `Step.timeout` still overrides it. The runner passes `config.timeouts.action_ms`.
   */
  actionTimeoutMs?: number;
  /**
   * Default client-side navigation-settle timeout (ms) for the post-`goto`/`press`
   * `waitForNavigation({ optional:true })` wait — the resolved `[timeouts] nav_ms` (default
   * {@link DEFAULT_NAV_TIMEOUT_MS} = 2000). The runner passes `config.timeouts.nav_ms`.
   */
  navTimeoutMs?: number;
  /**
   * Author-declared EXTRA attribute names (`[resolve] attributes`, e.g. `data-cmd`) the deterministic
   * resolver may use as selector hooks (Fix 2 BONUS). The driver merges these into EVERY enriched
   * `snapshot({ attributes:true })` (as `attributeNames`) and every `resolveAll` (as `testIdAttributes`),
   * so a site-specific hook is surfaced + ranked WITHOUT any caller (L0/L1/AI) having to thread it.
   * Empty/absent → behaviour identical to before (only the built-in testid attributes). The runner
   * passes `config.resolve.attributes`.
   */
  resolveAttributes?: readonly string[];
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
  private dialogPolicy: DialogPolicy;
  private dialogFailure: string | undefined;
  /**
   * Default actionability/click ceiling (ms) for batches + single actions (`[timeouts] action_ms`).
   * Public + readonly so callers/diagnostics can observe the EFFECTIVE ceiling the runner threaded
   * (an author's `[timeouts] action_ms` override, or {@link DEFAULT_ACTION_TIMEOUT_MS}).
   */
  readonly actionTimeoutMs: number;
  /**
   * Default client-side navigation-settle ceiling (ms) after goto/press (`[timeouts] nav_ms`).
   * Public + readonly for the same reason as {@link actionTimeoutMs}.
   */
  readonly navTimeoutMs: number;
  /**
   * Author-declared extra selector-hook attributes (`[resolve] attributes`), merged into every
   * enriched snapshot + resolveAll (Fix 2 BONUS). Readonly for diagnostics; empty by default.
   */
  readonly resolveAttributes: readonly string[];
  private browser: Browser | undefined;
  private activePage: Page | undefined;
  private connection: Connection | undefined;
  /** Active opt-in recording (set by `startRecording`, cleared by `stopRecording`). */
  private recording: RecordOpts | undefined;
  /**
   * The selector last passed to {@link switchToFrame} while we remain switched into a frame, or
   * `undefined` on the top document. Used to faithfully RE-ENTER the frame after a `snapshot()`
   * (browser-pilot's top-document snapshot invalidates the frame root). Cleared by
   * {@link switchToMain}, {@link goto} (navigation resets frame state) and {@link teardown}.
   */
  private frameSelector: string | string[] | undefined;
  /**
   * The extra HTTP headers most recently applied by {@link applyAuth}, if any. Headers are
   * per-CDP-session (unlike cookies, which are browser-wide), so a new page/popup target
   * (`expectNewPage`) does not inherit them — this cache lets the driver reapply them onto the
   * newly-switched-to page automatically, without the caller re-invoking `applyAuth`.
   */
  private lastAuthHeaders: Record<string, string> | undefined;

  constructor(options: BrowserPilotDriverOptions = {}) {
    this.dialogPolicy = options.dialogPolicy ?? "dismiss";
    this.actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.navTimeoutMs = options.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
    this.resolveAttributes = options.resolveAttributes ?? [];
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
      // Flightplan owns the page it drives; browser-pilot preserves DOM click effects in a
      // background target without foregrounding the browser window.
      this.activePage = await this.browser.newPage();
      const after = await this.listPageNames();
      const opened = after.filter((n) => !before.includes(n));
      this.connection.openedPages.push(...opened);
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
    await this.activePage.onDialog(async (dialog: Dialog) => {
      const policy = this.dialogPolicy;
      if (policy === "accept") {
        await dialog.accept();
      } else if (policy === "dismiss") {
        await dialog.dismiss();
      } else {
        this.dialogFailure = `native ${dialog.type} dialog requires manual handling: ${dialog.message}`;
        // The pinned browser-pilot handler must settle the CDP dialog. Dismissing after recording
        // the failure preserves fail-closed behavior without leaving the browser hung.
        await dialog.dismiss();
      }
    });
  }

  setDialogPolicy(policy: NativeDialogPolicy): void {
    this.dialogPolicy = policy;
    this.dialogFailure = undefined;
  }

  /**
   * Apply `[config.auth]` (Cloudflare Access wiring — `cloudflare-access-auth` proposal, Slice 6)
   * to the active page. Resolves every `*_env` name against `env` via the pure
   * {@link resolveAuthPlan} (throws {@link AuthEnvVarMissingError} naming the var, never a value,
   * on an unset one), then applies the result: `page.setExtraHTTPHeaders()` for any literal/
   * `cf_access` headers-mode headers, and `page.setCookie()` for any literal cookies plus — for
   * `cf_access` in the default `"cookie"` mode — the cookie minted by browser-pilot's
   * `mintCfAccessJwt`. A rejected mint surfaces its error unchanged (it already omits secret
   * values). Applying an empty/undefined `auth` is a no-op (no CDP calls at all).
   */
  async applyAuth(
    auth: AuthConfig | undefined,
    env: Record<string, string | undefined>,
  ): Promise<void> {
    if (!auth) return;
    const page = this.requirePage();
    const plan = resolveAuthPlan(auth, env);

    if (plan.cfAccessMint) {
      if (typeof mintCfAccessJwt !== "function") {
        throw new Error(
          '[config.auth.cf_access] mode "cookie" requires browser-pilot\'s mintCfAccessJwt export, ' +
            "which the connected browser-pilot build does not provide. Upgrade browser-pilot, or set " +
            '`mode = "headers"` to use the header-only path instead.',
        );
      }
      const { cookie } = await mintCfAccessJwt(plan.cfAccessMint);
      plan.cookies.push(cookie);
    }

    if (Object.keys(plan.headers).length > 0) {
      await page.setExtraHTTPHeaders(plan.headers);
      this.lastAuthHeaders = plan.headers;
    }
    for (const cookie of plan.cookies) {
      await page.setCookie(cookie);
    }
  }

  async expectNewPage(
    expectation: NewPageExpectation,
    action: () => Promise<unknown>,
  ): Promise<NewPageResult> {
    const browser = this.browser;
    const active = this.activePage;
    if (!browser || !active) {
      return { matched: false, reason: "browser is not connected" };
    }

    // browser-pilot owns the target-created/info-changed race. It arms listeners before the
    // trigger, rejects pre-existing targets, keeps delayed about:blank candidates pending, and
    // returns a separately pinned Page. The callback is the sole dispatch owner: this method never
    // invokes it again after an observation failure.
    const openerTargetId = expectation.openerTargetId ?? expectation.opener ?? active.targetId;
    const options: ExpectNewPageOptions = {
      ...(openerTargetId !== undefined ? { openerTargetId } : {}),
      type: expectation.type ?? "page",
      ...(expectation.url !== undefined ? { url: expectation.url } : {}),
      ...(expectation.title !== undefined ? { title: expectation.title } : {}),
      ...(expectation.timeoutMs !== undefined ? { timeout: expectation.timeoutMs } : {}),
    };

    try {
      const popup = await browser.expectNewPage(action, options);
      const targetProvenance = popup.getTargetProvenance();
      if (expectation.targetId !== undefined && popup.targetId !== expectation.targetId) {
        return {
          matched: false,
          targetId: popup.targetId,
          ...(targetProvenance.type !== undefined ? { type: targetProvenance.type } : {}),
          opener: targetProvenance.openerTargetId ?? openerTargetId,
          openerTargetId: targetProvenance.openerTargetId ?? openerTargetId,
          ...(targetProvenance.url !== undefined ? { url: targetProvenance.url } : {}),
          ...(targetProvenance.title !== undefined ? { title: targetProvenance.title } : {}),
          reason:
            `new page ${JSON.stringify(popup.targetId)} did not match targetId ` +
            JSON.stringify(expectation.targetId),
        };
      }

      // Switch only after the dependency has attached and initialized the pinned popup. All
      // subsequent Driver operations therefore target the matched popup, while the opener's page
      // session remains intact inside browser-pilot.
      this.activePage = popup;
      await this.installDialogHandler();
      // Headers are per-CDP-session: the popup's fresh page session does not inherit the opener's
      // `Network.setExtraHTTPHeaders`, so reapply the last-applied auth headers here (cookies are
      // browser-wide and need no reapplication). Best-effort: an auth-header reapply failure must
      // not turn an otherwise-successful popup observation into a hard error.
      if (this.lastAuthHeaders) {
        try {
          await popup.setExtraHTTPHeaders(this.lastAuthHeaders);
        } catch {
          // non-fatal — the popup is still usable without the reapplied headers.
        }
      }
      const matchedOpener = targetProvenance.openerTargetId ?? openerTargetId;
      return {
        matched: true,
        targetId: popup.targetId,
        ...(targetProvenance.type !== undefined ? { type: targetProvenance.type } : {}),
        ...(targetProvenance.url !== undefined ? { url: targetProvenance.url } : {}),
        ...(targetProvenance.title !== undefined ? { title: targetProvenance.title } : {}),
        ...(matchedOpener !== undefined
          ? { opener: matchedOpener, openerTargetId: matchedOpener }
          : {}),
      };
    } catch (error) {
      // A declared popup that was not observed is an observation failure, not a second chance to
      // dispatch. Preserve genuine trigger/harness errors for the runner's existing error path.
      if (!(error instanceof TargetNotFoundError)) throw error;
      return {
        matched: false,
        ...(openerTargetId !== undefined ? { opener: openerTargetId, openerTargetId } : {}),
        reason: error.message,
      };
    }
  }

  provenance(): BrowserPilotProvenance {
    return this.browser?.provenance ?? getBrowserPilotProvenance();
  }

  async pageState(): Promise<PageStateObservation> {
    const browser = this.browser;
    const active = this.activePage;
    if (!browser || !active) return {};
    const targets = await browser.listTargets();
    return {
      activeTargetId: active.targetId,
      popupCount: targets.filter((target) => target.targetId !== active.targetId).length,
      ...(this.dialogFailure ? { dialogOpen: true } : {}),
    };
  }

  private async listPageNames(): Promise<string[]> {
    if (!this.browser) return [];
    const targets = await this.browser.listTargets();
    return targets.map((t) => (t as { name?: string }).name ?? "").filter(Boolean);
  }

  async page(): Promise<PageHandle> {
    return this.requirePage();
  }

  /**
   * Clear the current origin's client-side state (localStorage + sessionStorage + cookies) for
   * per-run/per-scenario ISOLATION. Best-effort and defensive: each clear is attempted independently
   * and a failure of one (or no active page) never throws — isolation must not break a run. Uses
   * browser-pilot's `clearLocalStorage`/`clearSessionStorage`/`clearCookies`.
   */
  async clearBrowserState(): Promise<void> {
    const page = this.activePage;
    if (!page) return;
    try {
      await page.clearLocalStorage();
    } catch {
      /* origin may deny storage access; non-fatal */
    }
    try {
      await page.clearSessionStorage();
    } catch {
      /* non-fatal */
    }
    try {
      await page.clearCookies();
    } catch {
      /* non-fatal */
    }
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
        try {
          await browser.disconnect(); // drops our CDP socket
        } catch {
          // socket may already be dead (Chrome crashed); non-fatal — chrome.kill() must still run
        }
      }
      if (conn?.kind === "launch") {
        try {
          conn.chrome.kill(); // we own the launched Chrome → kill it (synchronous)
        } catch {
          // process may already be gone; non-fatal
        }
      }
    } finally {
      this.browser = undefined;
      this.activePage = undefined;
      this.connection = undefined;
      this.frameSelector = undefined;
      this.lastAuthHeaders = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // navigation
  // -------------------------------------------------------------------------

  async goto(url: string, opts?: GotoOpts): Promise<void> {
    const page = this.requirePage();
    // browser-pilot's `goto` accepts only ActionOptions (timeout/optional); it awaits the load
    // event internally. Always pass the driver's navigation ceiling so the raw CDP
    // Page.navigate command is bounded by `[timeouts].nav_ms` even when the runner calls
    // driver.goto(url) without per-step options.
    await page.goto(url, { timeout: opts?.timeout ?? this.navTimeoutMs });
    // DRIVER DEFAULT (PLAN §3): settle any follow-on client-side navigation so the page is
    // quiescent for the next snapshot/assertion. `optional:true` → never throws if nothing
    // navigates (the common case: bp's goto already settled the top-level load).
    if (opts?.waitForNavigation ?? true) {
      // Bound the client-side settle to the configured nav ceiling (default 2000), not bp's ~30s.
      await page.waitForNavigation({ optional: true, timeout: opts?.timeout ?? this.navTimeoutMs });
    }
    // A top-level navigation resets any frame context (browser-pilot resets its own frame state on
    // navigation); drop our re-entry selector so a later snapshot never tries to re-enter a frame
    // that no longer exists (PLAN frame-scoping: goto returns to the top document).
    this.frameSelector = undefined;
  }

  async currentUrl(): Promise<string> {
    return this.requirePage().url();
  }

  // -------------------------------------------------------------------------
  // frame switching (same-origin iframe / OOPIF context)
  // -------------------------------------------------------------------------

  /**
   * Enter the `<iframe>` identified by `selector`, delegating to browser-pilot's
   * `Page.switchToFrame`. Passed `{ optional: true }` so a missing/unattachable frame returns
   * `false` (a clean step failure) instead of throwing (which would surface as an infra `error`
   * verdict). Records the selector for the snapshot re-entry dance only on success.
   */
  async switchToFrame(selector: string | string[]): Promise<boolean> {
    const page = this.requirePage();
    selector = normalizeSelectorArg(selector);
    const entered = await page.switchToFrame(selector, { optional: true });
    this.frameSelector = entered ? selector : undefined;
    return entered;
  }

  /** Return to the top document (browser-pilot's `Page.switchToMain`). */
  async switchToMain(): Promise<void> {
    const page = this.requirePage();
    await page.switchToMain();
    this.frameSelector = undefined;
  }

  /** The active frame selector, or `null` on the top document (browser-pilot's `getCurrentFrame`). */
  currentFrame(): string | null {
    return this.activePage ? this.activePage.getCurrentFrame() : null;
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
    const bpOpts: { roles?: string[]; attributes?: boolean; attributeNames?: string[] } = {};
    if (opts?.roles) bpOpts.roles = opts.roles;
    if (opts?.attributes) bpOpts.attributes = true;
    // Merge author-declared `[resolve] attributes` with any caller-supplied `attributeNames` so a
    // hook like `data-cmd` is surfaced on EVERY enriched snapshot (L0/L1/AI) without the caller
    // threading it (Fix 2 BONUS). Only forwarded when attribute enrichment is on.
    if (bpOpts.attributes) {
      const names = dedupeAttributeNames(this.resolveAttributes, opts?.attributeNames);
      if (names.length > 0) bpOpts.attributeNames = names;
    }
    const takeSnapshot = (): Promise<PageSnapshot> =>
      Object.keys(bpOpts).length > 0 ? page.snapshot(bpOpts) : page.snapshot();

    // FRAME-SAFE SNAPSHOT. browser-pilot's `snapshot()` reads the TOP-document accessibility tree
    // and, as a side effect, invalidates the active frame root — leaving the NEXT in-frame action
    // to silently mis-resolve against the parent document (verified against browser-pilot 0.1.0:
    // switch → snapshot → in-frame click FAILS; switch → click succeeds). When switched into a
    // frame we therefore bracket the (inherently top-document) snapshot with switchToMain / re-enter
    // so the frame root is re-established afterwards and later in-frame ops keep resolving inside it.
    // Gated on the AUTHORITATIVE `getCurrentFrame()` so a navigation that reset the frame is a no-op.
    const activeFrame = page.getCurrentFrame();
    if (activeFrame !== null) {
      const reenter = this.frameSelector ?? activeFrame;
      await page.switchToMain();
      const snap = await takeSnapshot();
      await page.switchToFrame(reenter, { optional: true });
      return snap;
    }
    return takeSnapshot();
  }

  async resolveAll(intent: string, opts?: ResolveAllOpts): Promise<RankedCandidate[]> {
    // Phase 7 Change 3: delegate to browser-pilot 0.1.0's native `page.resolveAll`. Options map
    // 1:1 to bp's (our `strategies` is the shared `Strategy` union = bp's `CandidateStrategy`;
    // our `snapshot` is the re-exported bp `PageSnapshot`), so we pass them straight through.
    const page = this.requirePage();
    // Merge author-declared `[resolve] attributes` into `testIdAttributes` so the native ranker
    // turns a unique hook value (`data-cmd="c2"`) into a high-confidence deterministic candidate,
    // again without any caller threading it (Fix 2 BONUS).
    const mergedNames = dedupeAttributeNames(this.resolveAttributes, opts?.testIdAttributes);
    const effectiveOpts =
      mergedNames.length > 0 ? { ...opts, testIdAttributes: mergedNames } : opts;
    const ranked = effectiveOpts
      ? await page.resolveAll(intent, effectiveOpts)
      : await page.resolveAll(intent);
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

  /**
   * Inspect the live-DOM state of an arbitrary `selector`, delegating straight to
   * browser-pilot's `Page.elementState`. The returned `ElementState` is the re-exported bp
   * shape (`exists`/`visible`/`count`/`text`/`boundingBox`), so it passes through 1:1 — the
   * assertion engine reads it to resolve synthetic/CSS selectors the AX snapshot can't surface.
   */
  async elementState(selector: string): Promise<ElementState> {
    const page = this.requirePage();
    return page.elementState(normalizeSelectorArg(selector));
  }

  /**
   * Probe which browsing context a plain CSS `selector` matches in (main document vs a same-origin
   * iframe vs nowhere reachable), delegating to browser-pilot's `Page.locateSelectorFrame`. Used by
   * L1's iframe mis-resolution guard on the failure path only (one `Runtime.evaluate`). Any bp shape
   * that predates the method degrades to `'none'` (defensive) so the guard never throws.
   */
  async locateSelectorFrame(selector: string): Promise<"main" | "iframe" | "none"> {
    const page = this.requirePage() as Page & {
      locateSelectorFrame?(sel: string): Promise<"main" | "iframe" | "none">;
    };
    if (typeof page.locateSelectorFrame !== "function") return "none";
    return page.locateSelectorFrame(normalizeSelectorArg(selector));
  }

  async batch(steps: Step[], opts?: BatchOptions): Promise<BatchResult> {
    const page = this.requirePage();
    // DRIVER DEFAULT: any navigating step (click/submit/press) that did not set
    // `waitForNavigation` is defaulted to `true` so browser-pilot's `'auto'` never leaks.
    // Also normalize each step's `selector` (strip Flightplan's `css:` authoring prefix) so a
    // batch authored with Flightplan selector conventions reaches browser-pilot in a form it
    // understands — the same rewrite the single-action methods apply. Native role bracket syntax
    // is preserved because browser-pilot 0.1.0 supports it directly.
    const settled = steps.map((s) => {
      const step = withNavigationDefault(s);
      return step.selector === undefined
        ? step
        : { ...step, selector: normalizeSelectorArg(step.selector) };
    });
    // BOUND THE ACTIONABILITY WAIT (fixes the measured 30s L0/L1 hang): default the batch-level
    // `timeout` to the configured action ceiling (5000) so browser-pilot's ~30s default never
    // applies to the L0 replay / L1 race / any batch. A per-step `Step.timeout` still WINS (bp
    // reads `step.timeout ?? batchTimeout`), so a slow step's own `timeout_ms` overrides this.
    // OPT-IN RECORDING (Phase 5, Unit F): when a recording session is active, enable
    // browser-pilot's screenshot-frame `record` mode so per-step frames + a `recording.json`
    // manifest land in the recording dir. A caller that already passed an explicit `record`/
    // `timeout` wins (we only fill the gaps).
    const effective: BatchOptions = { ...opts };
    if (effective.timeout === undefined) effective.timeout = this.actionTimeoutMs;
    if (this.recording && effective.record === undefined) {
      effective.record = { outputDir: this.recording.dir };
    }
    const result = await page.batch(settled, effective);
    const normalized = normalizeBatchResult(result);
    if (this.dialogFailure) {
      const failure = this.dialogFailure;
      this.dialogFailure = undefined;
      return {
        ...normalized,
        success: false,
        steps: normalized.steps.map((step) => ({
          ...step,
          success: false,
          outcomeStatus: "failed",
          retrySafe: false,
          retryReason: failure,
        })),
      };
    }
    return normalized;
  }

  // --- single actions ---

  async click(sel: string | string[], opts?: ActionOpts): Promise<boolean> {
    // Route through a one-step batch so `waitForNavigation` (default true) is honoured —
    // single-action `page.click` has no such option (its ActionOptions lacks the field). The
    // batch-level `timeout` bounds the actionability wait to the action ceiling (5000, not bp's
    // ~30s); `clickStep` still sets a per-step `Step.timeout` from `opts.timeout`, which wins.
    const page = this.requirePage();
    sel = normalizeSelectorArg(sel);
    const result = await page.batch([clickStep(sel, opts)], { timeout: this.actionTimeoutMs });
    return firstStepSucceeded(result);
  }

  async fill(sel: string | string[], value: string, opts?: FillOpts): Promise<boolean> {
    const page = this.requirePage();
    const fillOpts: {
      timeout?: number;
      optional?: boolean;
      blur?: boolean;
      verify?: boolean | "exact" | "normalized";
    } = {
      timeout: opts?.timeout ?? this.actionTimeoutMs,
    };
    if (opts?.optional !== undefined) fillOpts.optional = opts.optional;
    if (opts?.blur !== undefined) fillOpts.blur = opts.blur;
    if (opts?.verify !== undefined) fillOpts.verify = opts.verify;
    return page.fill(normalizeSelectorArg(sel), value, fillOpts);
  }

  async type(sel: string | string[], text: string, opts?: TypeOpts): Promise<boolean> {
    const page = this.requirePage();
    const typeOpts: { timeout?: number; optional?: boolean; blur?: boolean; delay?: number } = {
      timeout: opts?.timeout ?? this.actionTimeoutMs,
    };
    if (opts?.optional !== undefined) typeOpts.optional = opts.optional;
    if (opts?.blur !== undefined) typeOpts.blur = opts.blur;
    if (opts?.delay !== undefined) typeOpts.delay = opts.delay;
    return page.type(normalizeSelectorArg(sel), text, typeOpts);
  }

  async select(
    sel: string | string[],
    value: string | string[],
    opts?: ActionOpts,
  ): Promise<boolean> {
    const page = this.requirePage();
    const actionOpts = passThroughActionOpts(opts, this.actionTimeoutMs);
    return page.select(normalizeSelectorArg(sel), value, actionOpts);
  }

  async check(sel: string | string[], opts?: ActionOpts): Promise<boolean> {
    const page = this.requirePage();
    return page.check(normalizeSelectorArg(sel), passThroughActionOpts(opts, this.actionTimeoutMs));
  }

  async hover(sel: string | string[], opts?: ActionOpts): Promise<boolean> {
    const page = this.requirePage();
    return page.hover(normalizeSelectorArg(sel), passThroughActionOpts(opts, this.actionTimeoutMs));
  }

  async press(
    key: string,
    opts?: { modifiers?: Array<"Control" | "Shift" | "Alt" | "Meta"> },
  ): Promise<boolean> {
    // Route through batch so navigation settles (Enter often submits). `page.press` returns
    // void and never settles navigation; the one-step batch gives us both a boolean and the
    // forced `waitForNavigation`. Modifiers (if any) are applied via the direct press first.
    const page = this.requirePage();
    if (opts?.modifiers && opts.modifiers.length > 0) {
      await page.press(key, { modifiers: opts.modifiers });
      // best-effort settle after a modified keypress, bounded by the nav ceiling (not bp's ~30s)
      await page.waitForNavigation({ optional: true, timeout: this.navTimeoutMs });
      return true;
    }
    const result = await page.batch([pressStep(key, true)], { timeout: this.actionTimeoutMs });
    return firstStepSucceeded(result);
  }

  async submit(sel?: string | string[], opts?: SubmitOpts): Promise<boolean> {
    const page = this.requirePage();
    const sopts = submitOptions(opts);
    // Bound submit's actionability wait to the action ceiling (5000) when the caller set none.
    if (sopts.timeout === undefined) sopts.timeout = this.actionTimeoutMs;
    // browser-pilot's submit signature requires a selector; when none is given, submit the
    // ambient form via the empty-string selector (browser-pilot resolves the active form).
    const selector = sel === undefined ? "" : normalizeSelectorArg(sel);
    return page.submit(selector, sopts);
  }

  // --- emit (WebSocket command injection) ---

  /**
   * Delegate to browser-pilot's `page.emitMessage` (>=0.2.0). Feature-detected: a `Page` from an
   * older browser-pilot lacks `emitMessage`, and this throws a clear upgrade error rather than
   * silently misbehaving — the pin's `TODO` marks where this stops being purely defensive. Any bp
   * throw (ambiguous-socket `EmitTargetError`, an `awaitReply` timeout) propagates as-is; the
   * runner's `emit` case catches it and maps it to a normal step failure, not an infra error.
   */
  async emitCommand(opts: EmitCommandOptions): Promise<EmitCommandResult> {
    const page = this.requirePage() as Page & {
      emitMessage?(payload: string, options?: BpEmitWsOptions): Promise<EmitCommandResult>;
    };
    if (typeof page.emitMessage !== "function") {
      throw new Error(
        "emit step requires browser-pilot >=0.2.0 (page.emitMessage is not available on the " +
          "connected browser-pilot Page) — upgrade the pinned browser-pilot dependency.",
      );
    }
    const { channel: _channel, payload, ...wsOpts } = opts;
    return page.emitMessage(payload, wsOpts);
  }

  // --- WebMCP tool invocation ---

  /**
   * Discover and invoke one exact WebMCP tool on the active page. Discovery is performed here
   * before delegating to browser-pilot's call helper so a missing/ambiguous/unapproved tool is
   * classified as a clean preflight failure. Once the helper is entered, any rejection is
   * conservatively classified as uncertain because the page may already have started executing
   * the tool and WebMCP exposes no dispatch receipt.
   */
  async webmcpCall(opts: WebMcpCallOptions): Promise<WebMcpCallResult> {
    const page = this.requirePage();
    const fromOrigins = [
      ...new Set([...(opts.fromOrigins ?? []), ...(opts.origin ? [opts.origin] : [])]),
    ];
    let listed: WebMcpListResult;
    try {
      listed = await bpWebmcpList(page, fromOrigins);
    } catch (error) {
      return {
        ok: false,
        phase: "preflight",
        dispatchState: "not_dispatched",
        retrySafe: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!listed.status.available) {
      return {
        ok: false,
        phase: "preflight",
        dispatchState: "not_dispatched",
        retrySafe: true,
        status: listed.status,
        error: `WebMCP is unavailable on ${listed.status.url}${
          listed.status.reason ? `: ${listed.status.reason}` : "."
        }`,
      };
    }
    const matching = listed.tools.filter(
      (tool) =>
        tool.name === opts.tool && (opts.origin === undefined || tool.origin === opts.origin),
    );
    if (matching.length === 0) {
      return {
        ok: false,
        phase: "preflight",
        dispatchState: "not_dispatched",
        retrySafe: true,
        status: listed.status,
        error:
          "WebMCP tool " +
          JSON.stringify(opts.tool) +
          " was not found on " +
          listed.status.url +
          ".",
      };
    }
    if (matching.length > 1 && opts.origin === undefined) {
      return {
        ok: false,
        phase: "preflight",
        dispatchState: "not_dispatched",
        retrySafe: true,
        status: listed.status,
        error:
          "WebMCP tool " +
          JSON.stringify(opts.tool) +
          " is exposed by multiple origins; set origin to select one exactly.",
      };
    }
    const tool = matching[0]!;
    if (!opts.allowMutation && tool.annotations?.readOnlyHint !== true) {
      return {
        ok: false,
        phase: "preflight",
        dispatchState: "not_dispatched",
        retrySafe: true,
        status: listed.status,
        tool,
        error:
          "WebMCP tool " +
          JSON.stringify(opts.tool) +
          ' is not marked read-only; set effect = "idempotent" or "at_most_once" to acknowledge mutation.',
      };
    }
    try {
      const called = await bpWebmcpCall(page, opts.tool, opts.input, {
        ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
        ...(fromOrigins.length > 0 ? { fromOrigins } : {}),
        allowMutation: opts.allowMutation,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      return {
        ok: true,
        phase: "invoke",
        dispatchState: "dispatched",
        retrySafe: false,
        tool: called.tool,
        result: called.result,
        status: listed.status,
      };
    } catch (error) {
      return {
        ok: false,
        phase: "invoke",
        dispatchState: "uncertain",
        retrySafe: false,
        status: listed.status,
        tool,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // --- eval (escape-hatch JS execution) ---

  /**
   * Enter `opts.frame` (if given), run `opts.script` via browser-pilot's `Page.evaluate` — which
   * routes to the active OOPIF child session when one is switched into, unlike the element verbs
   * that cannot yet resolve a SELECTOR inside a real cross-origin child session — then restore
   * whatever frame context was active before the call (this is a one-shot escape hatch, not a
   * stateful switch like {@link switchToFrame}). `args` is JSON-serialized and spliced into an
   * async-function-call wrapper around `script` rather than string-interpolated into it. Never
   * throws: an unresolvable frame or a thrown evaluation exception both become `{ ok: false, error }`.
   */
  async evalInFrame(opts: EvalOptions): Promise<EvalResult> {
    const page = this.requirePage() as Page & {
      evaluate<T = unknown>(expression: string): Promise<T>;
    };
    const previousFrame = this.frameSelector;
    if (opts.frame !== undefined) {
      const entered = await page.switchToFrame(opts.frame, { optional: true });
      if (!entered) {
        return {
          ok: false,
          error: `evalInFrame: could not enter frame (${opts.frame})`,
          phase: "frame",
        };
      }
      this.frameSelector = opts.frame;
    }
    try {
      const argsJson = JSON.stringify(opts.args ?? {});
      const wrapped = `(async function (args) {\n${opts.script}\n})(${argsJson})`;
      const value = await page.evaluate(wrapped);
      return { ok: true, value };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        phase: "script",
      };
    } finally {
      if (opts.frame !== undefined) {
        if (previousFrame !== undefined) {
          await page.switchToFrame(previousFrame, { optional: true });
          this.frameSelector = previousFrame;
        } else {
          await page.switchToMain();
          this.frameSelector = undefined;
        }
      }
    }
  }

  // --- evaluate (bare escape-hatch JS expression) ---

  /**
   * Delegate directly to browser-pilot's `page.evaluate` — no frame targeting, no args/expect
   * wrapper. browser-pilot's `page.evaluate` already routes into whatever OOPIF child session a
   * prior `switch_frame` step entered, so this needs no extra frame handling of its own.
   */
  async evaluateExpression(expression: string): Promise<unknown> {
    const page = this.requirePage() as Page & {
      evaluate<T = unknown>(expression: string): Promise<T>;
    };
    return page.evaluate(expression);
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
      // Layer 2: forward `[cache] ignore_regions` as browser-pilot's structural `maskSelectors`,
      // so a masked subtree is excluded from the struct hash too (matches the masked-text side).
      return opts.maskSelectors && opts.maskSelectors.length > 0
        ? bpCaptureStructureSignature(page, { maskSelectors: opts.maskSelectors })
        : bpCaptureStructureSignature(page);
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

/**
 * Build the `ActionOptions` (optional/timeout) browser-pilot single-actions accept. The action
 * `timeout` defaults to `defaultTimeoutMs` (the driver's `[timeouts] action_ms`) so a missing/
 * non-actionable target fails fast (≈5s) instead of at bp's ~30s default; a caller-supplied
 * `opts.timeout` (per-step override) still wins.
 */
function passThroughActionOpts(
  opts: ActionOpts | undefined,
  defaultTimeoutMs: number,
): { timeout?: number; optional?: boolean } {
  const out: { timeout?: number; optional?: boolean } = {
    timeout: opts?.timeout ?? defaultTimeoutMs,
  };
  if (opts?.optional !== undefined) out.optional = opts.optional;
  return out;
}

/**
 * Merge the driver's construction-time `resolveAttributes` with a caller's per-call attribute names
 * into a de-duplicated list (first-seen order, non-empty entries only). Returns `[]` when both are
 * empty so callers can skip forwarding the option entirely (byte-identical default behaviour).
 */
function dedupeAttributeNames(
  base: readonly string[],
  extra: readonly string[] | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [...base, ...(extra ?? [])]) {
    if (n.length === 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
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
