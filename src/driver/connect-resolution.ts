// Flightplan — pure connect-config interpretation logic.
//
// This is the Chrome-free, unit-testable core of the driver's connect handling: deriving
// mode, building browser-pilot `connect()` args, and resolving the attach ws URL. It is
// separated from `browser-pilot-driver.ts` so `bun test` can exercise the decision logic
// without launching a real browser (per the task's verification constraint).
//
// Canonical reference: PLAN.md §3 (connect-config union, resolution precedence, the
// in-process `ConnectOptions` has NO `browserURL` field — the driver resolves it itself).

import type { AuthConfig, ConnectConfig } from "../config/types.ts";

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

// ---------------------------------------------------------------------------
// [config.auth] resolution — Chrome-free, unit-testable core of `applyAuth` (browser-pilot
// `cloudflare-access-auth` proposal, Slice 6). Decides cookie-vs-headers mode and resolves
// every `*_env` name against the run's env map, WITHOUT doing any CDP/network I/O itself
// (the `cf_access` mint is the one exception left to the driver, since it needs `fetch`).
// ---------------------------------------------------------------------------

/** A literal cookie payload ready for `Page.setCookie()`, resolved from `[[config.auth.cookies]]`. */
export interface ResolvedAuthCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number | Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  url?: string;
}

/** The plan `applyAuth` executes: literal headers to set, literal cookies to set, and —
 * when `cf_access` is configured in `"cookie"` mode — the resolved mint request. */
export interface ResolvedAuthPlan {
  headers: Record<string, string>;
  cookies: ResolvedAuthCookie[];
  cfAccessMint?: {
    url: string;
    clientId: string;
    clientSecret: string;
  };
}

/**
 * Thrown when an `[config.auth]` `*_env` name is not set in the run's env map. Never carries
 * the (absent) value — only the env var NAME — so it is safe to surface verbatim in run
 * errors/logs (the names-not-values rule).
 */
export class AuthEnvVarMissingError extends Error {
  constructor(public readonly envVarName: string) {
    super(`[config.auth]: environment variable "${envVarName}" is not set`);
    this.name = "AuthEnvVarMissingError";
  }
}

function requireEnvVar(name: string, env: Record<string, string | undefined>): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new AuthEnvVarMissingError(name);
  }
  return value;
}

/**
 * Resolve `[config.auth]` into a concrete {@link ResolvedAuthPlan} against `env`. Pure and
 * Chrome-free: no fetch, no CDP. Throws {@link AuthEnvVarMissingError} (naming the var, never
 * a value) the moment an `*_env` name is unset — matching `${env.*}` templating semantics
 * (fail before any navigation, not mid-flow).
 *
 *  - `cf_access` in `"cookie"` mode (default) resolves the client id/secret and returns them as
 *    `cfAccessMint` for the driver to exchange via browser-pilot's `mintCfAccessJwt`; the caller
 *    applies the resulting cookie.
 *  - `cf_access` in `"headers"` mode resolves the client id/secret directly into the
 *    `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers (Method A) — no mint call.
 *  - `extra_headers.from_env` resolves each header name -> env var NAME into a literal header.
 *  - `cookies[]` resolves each `value` / `value_from_env` entry into a literal cookie.
 */
export function resolveAuthPlan(
  auth: AuthConfig | undefined,
  env: Record<string, string | undefined>,
): ResolvedAuthPlan {
  const plan: ResolvedAuthPlan = { headers: {}, cookies: [] };
  if (!auth) return plan;

  if (auth.cf_access) {
    const { url, client_id_env, client_secret_env, mode } = auth.cf_access;
    const clientId = requireEnvVar(client_id_env, env);
    const clientSecret = requireEnvVar(client_secret_env, env);
    if (mode === "headers") {
      plan.headers["CF-Access-Client-Id"] = clientId;
      plan.headers["CF-Access-Client-Secret"] = clientSecret;
    } else {
      plan.cfAccessMint = { url, clientId, clientSecret };
    }
  }

  if (auth.extra_headers?.from_env) {
    for (const [header, envVarName] of Object.entries(auth.extra_headers.from_env)) {
      plan.headers[header] = requireEnvVar(envVarName, env);
    }
  }

  for (const cookie of auth.cookies ?? []) {
    const value =
      cookie.value !== undefined
        ? cookie.value
        : requireEnvVar(cookie.value_from_env as string, env);
    const resolved: ResolvedAuthCookie = { name: cookie.name, value };
    if (cookie.domain !== undefined) resolved.domain = cookie.domain;
    if (cookie.path !== undefined) resolved.path = cookie.path;
    if (cookie.expires !== undefined) resolved.expires = cookie.expires;
    if (cookie.http_only !== undefined) resolved.httpOnly = cookie.http_only;
    if (cookie.secure !== undefined) resolved.secure = cookie.secure;
    if (cookie.same_site !== undefined) resolved.sameSite = cookie.same_site;
    if (cookie.url !== undefined) resolved.url = cookie.url;
    plan.cookies.push(resolved);
  }

  return plan;
}
