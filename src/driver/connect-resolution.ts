// Flightplan — pure connect-config interpretation logic.
//
// This is the Chrome-free, unit-testable core of the driver's connect handling: deriving
// mode, building browser-pilot `connect()` args, and resolving the attach ws URL. It is
// separated from `browser-pilot-driver.ts` so `bun test` can exercise the decision logic
// without launching a real browser (per the task's verification constraint).
//
// Canonical reference: PLAN.md §3 (connect-config union, resolution precedence, the
// in-process `ConnectOptions` has NO `browserURL` field — the driver resolves it itself).

import type { ConnectConfig } from "../config/types.ts";

/**
 * The browser-pilot `connect()` argument the driver will build for an ATTACH config once the
 * ws URL is known. Mirrors the subset of `ConnectOptions` the driver sets (always the
 * `generic` provider for attach). `wsUrl` may be undefined when the caller will rely on
 * browser-pilot's auto-discovery (no explicit wsUrl/browserURL given).
 */
export interface ResolvedAttachConnectArgs {
  provider: "generic";
  wsUrl?: string;
  /** From `autodiscover.channel` — narrows browser-pilot's local scan. */
  channel?: "stable" | "beta" | "dev" | "canary";
  /** From `autodiscover.userDataDir` — narrows browser-pilot's local scan. */
  userDataDir?: string;
}

/** chrome-launcher flags + the connect provider for a LAUNCH config. */
export interface ResolvedLaunchPlan {
  provider: "generic";
  headless: boolean;
  channel?: string;
  userDataDir?: string;
  chromeFlags: string[];
}

/** The default chrome-launcher flags for Mode B (PLAN.md §3 connect-config union). */
export const DEFAULT_CHROME_FLAGS: readonly string[] = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--window-size=1280,720",
] as const;

/** Whether a connect config is attach (Mode A) or launch (Mode B). */
export function connectMode(cfg: ConnectConfig): "attach" | "launch" {
  return cfg.mode;
}

/**
 * How the driver will obtain the attach ws URL, BEFORE doing any I/O. This makes the
 * resolution precedence (PLAN.md §3) explicit and testable:
 *   1. explicit `wsUrl`            → 'explicit-ws'  (passed straight to connect)
 *   2. `browserURL` (host:port)    → 'browser-url'  (resolved via getBrowserWebSocketUrl)
 *   3. otherwise                   → 'autodiscover' (browser-pilot scans local profiles)
 *
 * "Prefer explicit `wsUrl`" — autodiscover is the convenience fallback and can throw
 * `multiple-local-browsers` on multi-profile machines (FINDINGS §1 / PLAN §8 risk #3).
 */
export function attachWsResolutionSource(
  cfg: Extract<ConnectConfig, { mode: "attach" }>,
): "explicit-ws" | "browser-url" | "autodiscover" {
  if (cfg.wsUrl) return "explicit-ws";
  if (cfg.browserURL) return "browser-url";
  return "autodiscover";
}

/**
 * Build the browser-pilot `connect()` args for an ATTACH config, given an already-resolved
 * ws URL (or `undefined` to let browser-pilot auto-discover). Pure: does NO network I/O.
 * The `browserURL` → wsUrl resolution (via `getBrowserWebSocketUrl`) happens in the driver
 * (it requires a fetch) and is fed in here as `resolvedWsUrl`.
 */
export function buildAttachConnectArgs(
  cfg: Extract<ConnectConfig, { mode: "attach" }>,
  resolvedWsUrl: string | undefined,
): ResolvedAttachConnectArgs {
  const args: ResolvedAttachConnectArgs = { provider: "generic" };
  if (resolvedWsUrl) args.wsUrl = resolvedWsUrl;
  if (cfg.autodiscover?.channel) args.channel = cfg.autodiscover.channel;
  if (cfg.autodiscover?.userDataDir) args.userDataDir = cfg.autodiscover.userDataDir;
  return args;
}

/**
 * Build the chrome-launcher launch plan for a LAUNCH config. Applies the driver defaults:
 * `headless` defaults to `true`; `chromeFlags` defaults to `DEFAULT_CHROME_FLAGS`. When
 * `headless` is explicitly `false`, the `--headless=new` flag is stripped from the defaults
 * (an explicit `chromeFlags` array is used verbatim and is the caller's responsibility).
 */
export function buildLaunchPlan(
  cfg: Extract<ConnectConfig, { mode: "launch" }>,
): ResolvedLaunchPlan {
  const headless = cfg.headless ?? true;

  let chromeFlags: string[];
  if (cfg.chromeFlags && cfg.chromeFlags.length > 0) {
    chromeFlags = [...cfg.chromeFlags];
  } else {
    chromeFlags = headless
      ? [...DEFAULT_CHROME_FLAGS]
      : DEFAULT_CHROME_FLAGS.filter((f) => f !== "--headless=new");
  }

  const plan: ResolvedLaunchPlan = {
    provider: "generic",
    headless,
    chromeFlags,
  };
  if (cfg.channel) plan.channel = cfg.channel;
  if (cfg.userDataDir) plan.userDataDir = cfg.userDataDir;
  return plan;
}

/**
 * Normalise a `browserURL` value to the `host:port` form `getBrowserWebSocketUrl` expects.
 * Strips a leading scheme (`http://`/`https://`) and any trailing path/slash; if no port is
 * present, defaults to `:9222` (Chrome's conventional remote-debugging port).
 */
export function normalizeBrowserUrl(browserURL: string): string {
  let v = browserURL.trim();
  v = v.replace(/^https?:\/\//i, "");
  // drop any path/query/fragment
  const slash = v.indexOf("/");
  if (slash >= 0) v = v.slice(0, slash);
  if (!v.includes(":")) v = `${v}:9222`;
  return v;
}
