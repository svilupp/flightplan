import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TargetNotFoundError } from "browser-pilot";
import { CookieStateError } from "browser-pilot/core";
import { BrowserPilotDriver, getBrowserPilotProvenance } from "./browser-pilot-driver.ts";
import { AuthStateUnavailableError } from "./connect-resolution.ts";
import type { Page } from "./index.ts";

interface TestPage {
  targetId: string;
  getTargetProvenance(): {
    openerTargetId?: string;
    type?: string;
    url?: string;
    title?: string;
  };
  onDialog(handler: () => Promise<void>): Promise<void>;
}

function testPage(
  targetId: string,
  provenance: TestPage["getTargetProvenance"] extends () => infer T ? T : never,
): Page {
  const page: TestPage = {
    targetId,
    getTargetProvenance: () => provenance,
    onDialog: async () => {},
  };
  return page as unknown as Page;
}

function seedDriver(driver: BrowserPilotDriver, browser: unknown, activePage: Page): void {
  const internals = driver as unknown as { browser: unknown; activePage: Page };
  internals.browser = browser;
  internals.activePage = activePage;
}

describe("BrowserPilotDriver popup integration", () => {
  test("passes opener and target filters, then switches to the pinned popup once", async () => {
    const driver = new BrowserPilotDriver();
    const opener = testPage("launcher", {});
    const popup = testPage("wanted", {
      openerTargetId: "launcher",
      type: "page",
      url: "https://example.test/ready",
      title: "Expected popup",
    });
    let actionCalls = 0;
    let observedOptions: unknown;

    const browser = {
      expectNewPage: async (trigger: () => Promise<unknown>, options: unknown): Promise<Page> => {
        observedOptions = options;
        await trigger();
        // The dependency keeps an about:blank target pending, ignores unrelated targets, and
        // resolves this final target only after its URL/title metadata is available.
        return popup;
      },
    };
    seedDriver(driver, browser, opener);

    const result = await driver.expectNewPage(
      {
        openerTargetId: "launcher",
        type: "page",
        url: "https://example.test",
        title: "Expected popup",
        timeoutMs: 750,
      },
      async () => {
        actionCalls += 1;
      },
    );

    expect(observedOptions).toEqual({
      openerTargetId: "launcher",
      type: "page",
      url: "https://example.test",
      title: "Expected popup",
      timeout: 750,
    });
    expect(actionCalls).toBe(1);
    expect(result).toEqual({
      matched: true,
      targetId: "wanted",
      type: "page",
      url: "https://example.test/ready",
      title: "Expected popup",
      opener: "launcher",
      openerTargetId: "launcher",
    });
    expect(await driver.page()).toBe(popup);
  });

  test("does not redispatch when unrelated/new about:blank targets never satisfy the expectation", async () => {
    const driver = new BrowserPilotDriver();
    const opener = testPage("launcher", {});
    let actionCalls = 0;
    const browser = {
      expectNewPage: async (trigger: () => Promise<unknown>): Promise<Page> => {
        await trigger();
        throw new TargetNotFoundError({
          targetUrl: "https://example.test/ready",
          reason: "only an unrelated popup and a delayed about:blank target were observed",
        });
      },
    };
    seedDriver(driver, browser, opener);

    const result = await driver.expectNewPage(
      {
        openerTargetId: "launcher",
        url: "https://example.test/ready",
        timeoutMs: 25,
      },
      async () => {
        actionCalls += 1;
      },
    );

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("unrelated popup");
    expect(actionCalls).toBe(1);
    expect(await driver.page()).toBe(opener);
  });
});

describe("BrowserPilotDriver WebMCP integration", () => {
  function webmcpPage(evaluate: (expression: string) => Promise<unknown>): Page {
    return { evaluate } as unknown as Page;
  }

  test("discovers and invokes an exact read-only tool through browser-pilot", async () => {
    const evaluations: string[] = [];
    const page = webmcpPage(async (expression) => {
      evaluations.push(expression);
      if (expression.includes("rawResult")) {
        return {
          rawResult: { order: { status: "ready" } },
          tool: {
            name: "orders.lookup",
            origin: "https://shop.example",
            annotations: { readOnlyHint: true },
          },
        };
      }
      return {
        status: {
          available: true,
          url: "https://shop.example/orders",
          secureContext: true,
          originAgentCluster: true,
          crossOriginIsolated: false,
          toolsPolicy: true,
        },
        tools: [
          {
            name: "orders.lookup",
            origin: "https://shop.example",
            annotations: { readOnlyHint: true },
          },
        ],
      };
    });
    const driver = new BrowserPilotDriver();
    seedDriver(driver, {}, page);
    const result = await driver.webmcpCall({
      tool: "orders.lookup",
      input: { order_id: "42" },
      origin: "https://shop.example",
      allowMutation: false,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ order: { status: "ready" } });
    expect(result.dispatchState).toBe("dispatched");
    // Driver preflight plus browser-pilot's own race-safe re-discovery and invocation.
    expect(evaluations.length).toBe(3);
  });

  test("rejects an unavailable page or mutating tool before invocation", async () => {
    let evaluations = 0;
    const page = webmcpPage(async (expression) => {
      evaluations += 1;
      if (expression.includes("rawResult")) throw new Error("must not invoke");
      return {
        status: {
          available: false,
          url: "http://insecure.example",
          secureContext: false,
          originAgentCluster: null,
          crossOriginIsolated: false,
          toolsPolicy: null,
          reason: "WebMCP requires HTTPS",
        },
        tools: [],
      };
    });
    const driver = new BrowserPilotDriver();
    seedDriver(driver, {}, page);
    const result = await driver.webmcpCall({
      tool: "orders.create",
      input: {},
      allowMutation: false,
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("preflight");
    expect(result.dispatchState).toBe("not_dispatched");
    expect(result.error).toContain("HTTPS");
    expect(evaluations).toBe(1);
  });

  test("requires an explicit mutation acknowledgement for non-read-only tools", async () => {
    let invocationEvaluations = 0;
    const page = webmcpPage(async (expression) => {
      if (expression.includes("rawResult")) invocationEvaluations += 1;
      return {
        status: {
          available: true,
          url: "https://shop.example/orders",
          secureContext: true,
          originAgentCluster: true,
          crossOriginIsolated: false,
          toolsPolicy: true,
        },
        tools: [{ name: "orders.create", annotations: { readOnlyHint: false } }],
      };
    });
    const driver = new BrowserPilotDriver();
    seedDriver(driver, {}, page);
    const result = await driver.webmcpCall({
      tool: "orders.create",
      input: {},
      allowMutation: false,
    });
    expect(result.ok).toBe(false);
    expect(result.phase).toBe("preflight");
    expect(result.dispatchState).toBe("not_dispatched");
    expect(result.error).toContain("at_most_once");
    expect(invocationEvaluations).toBe(0);
  });
});

describe("browser-pilot provenance", () => {
  test("exposes the runtime package/source/build identity", () => {
    expect(getBrowserPilotProvenance()).toEqual({
      packageVersion: expect.any(String),
      gitSourceHash: expect.any(String),
      buildHash: expect.any(String),
    });
  });
});

// ---------------------------------------------------------------------------
// applyAuth — [config.auth] application (browser-pilot cloudflare-access-auth proposal,
// Slice 6). Offline: a fake page records setExtraHTTPHeaders/setCookie calls; no real Chrome,
// no network (the cf_access mint itself is exercised at the pure resolveAuthPlan level and in
// browser-pilot's own test suite, not here).
// ---------------------------------------------------------------------------

interface AuthTestPage {
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  setCookie(options: Record<string, unknown>): Promise<boolean>;
}

function authTestPage(): AuthTestPage & {
  headerCalls: Record<string, string>[];
  cookieCalls: Record<string, unknown>[];
} {
  const headerCalls: Record<string, string>[] = [];
  const cookieCalls: Record<string, unknown>[] = [];
  return {
    headerCalls,
    cookieCalls,
    setExtraHTTPHeaders: async (headers) => {
      headerCalls.push(headers);
    },
    setCookie: async (options) => {
      cookieCalls.push(options);
      return true;
    },
  };
}

function seedDriverPage(driver: BrowserPilotDriver, page: unknown): void {
  const internals = driver as unknown as { activePage: unknown };
  internals.activePage = page;
}

describe("BrowserPilotDriver.applyAuth", () => {
  test("undefined auth is a no-op — no page calls at all", async () => {
    const driver = new BrowserPilotDriver();
    const page = authTestPage();
    seedDriverPage(driver, page);
    await driver.applyAuth(undefined, {});
    expect(page.headerCalls).toHaveLength(0);
    expect(page.cookieCalls).toHaveLength(0);
  });

  test("extra_headers.from_env resolves against env and calls setExtraHTTPHeaders once", async () => {
    const driver = new BrowserPilotDriver();
    const page = authTestPage();
    seedDriverPage(driver, page);
    await driver.applyAuth(
      { extra_headers: { from_env: { "X-Api-Key": "MY_API_KEY" } } },
      { MY_API_KEY: "resolved-key" },
    );
    expect(page.headerCalls).toEqual([{ "X-Api-Key": "resolved-key" }]);
    expect(page.cookieCalls).toHaveLength(0);
  });

  test("cf_access mode 'headers' resolves CF-Access-* headers without minting", async () => {
    const driver = new BrowserPilotDriver();
    const page = authTestPage();
    seedDriverPage(driver, page);
    await driver.applyAuth(
      {
        cf_access: {
          url: "https://x.test",
          client_id_env: "CF_ID",
          client_secret_env: "CF_SECRET",
          mode: "headers",
        },
      },
      { CF_ID: "the-id", CF_SECRET: "the-secret" },
    );
    expect(page.headerCalls).toEqual([
      { "CF-Access-Client-Id": "the-id", "CF-Access-Client-Secret": "the-secret" },
    ]);
    expect(page.cookieCalls).toHaveLength(0);
  });

  test("[[cookies]] with a literal value calls setCookie with the resolved payload", async () => {
    const driver = new BrowserPilotDriver();
    const page = authTestPage();
    seedDriverPage(driver, page);
    await driver.applyAuth(
      { cookies: [{ name: "session", value: "literal-value", domain: "example.test" }] },
      {},
    );
    expect(page.cookieCalls).toEqual([
      { name: "session", value: "literal-value", domain: "example.test" },
    ]);
    expect(page.headerCalls).toHaveLength(0);
  });

  test("[[cookies]] value_from_env resolves against the run env, not process.env", async () => {
    const driver = new BrowserPilotDriver();
    const page = authTestPage();
    seedDriverPage(driver, page);
    await driver.applyAuth(
      { cookies: [{ name: "CF_Authorization", value_from_env: "CF_ACCESS_JWT" }] },
      { CF_ACCESS_JWT: "hermetic-fake-jwt" },
    );
    expect(page.cookieCalls).toEqual([{ name: "CF_Authorization", value: "hermetic-fake-jwt" }]);
  });

  test("an unset *_env name throws before any setExtraHTTPHeaders/setCookie call", async () => {
    const driver = new BrowserPilotDriver();
    const page = authTestPage();
    seedDriverPage(driver, page);
    await expect(
      driver.applyAuth({ extra_headers: { from_env: { "X-Api-Key": "UNSET_ENV" } } }, {}),
    ).rejects.toThrow(/UNSET_ENV/);
    expect(page.headerCalls).toHaveLength(0);
    expect(page.cookieCalls).toHaveLength(0);
  });
});

/** A raw (untyped) test double combining the popup-integration TestPage shape + AuthTestPage. */
function authAndPopupTestPage(
  targetId: string,
  provenance: TestPage["getTargetProvenance"] extends () => infer T ? T : never,
): { raw: TestPage & AuthTestPage & { headerCalls: Record<string, string>[] }; page: Page } {
  const headerCalls: Record<string, string>[] = [];
  const raw = {
    targetId,
    getTargetProvenance: () => provenance,
    onDialog: async () => {},
    headerCalls,
    cookieCalls: [] as Record<string, unknown>[],
    setExtraHTTPHeaders: async (headers: Record<string, string>) => {
      headerCalls.push(headers);
    },
    setCookie: async () => true,
  };
  return { raw, page: raw as unknown as Page };
}

describe("BrowserPilotDriver popup header reapplication (applyAuth + expectNewPage)", () => {
  test("reapplies the last-applied auth headers onto a newly-switched-to popup", async () => {
    const driver = new BrowserPilotDriver();
    const opener = authAndPopupTestPage("launcher", {});
    seedDriverPage(driver, opener.page);
    await driver.applyAuth(
      { extra_headers: { from_env: { "X-Api-Key": "MY_API_KEY" } } },
      { MY_API_KEY: "resolved-key" },
    );

    const popup = authAndPopupTestPage("wanted", { openerTargetId: "launcher" });
    const browser = {
      expectNewPage: async (trigger: () => Promise<unknown>): Promise<Page> => {
        await trigger();
        return popup.page;
      },
    };
    seedDriver(driver, browser, opener.page);

    const result = await driver.expectNewPage({ openerTargetId: "launcher" }, async () => {});

    expect(result.matched).toBe(true);
    expect(popup.raw.headerCalls).toEqual([{ "X-Api-Key": "resolved-key" }]);
  });
});

// ---------------------------------------------------------------------------
// applyAuth cookie_file / saveAuthState — saved-auth-state cookie-snapshot round-trip against
// the REAL installed browser-pilot 0.6.0 (`restoreCookieState`/`captureCookieState` +
// `browser-pilot/adapters/node`'s file helpers). Only the CDP transport (`cdpClient.send`) is
// faked; the cookie-state parse/serialize/capture/restore logic itself is real bp code, so this
// is an integration test of the driver's wiring, not a reimplementation of bp's cookie rules.
// ---------------------------------------------------------------------------

interface FakeCdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires: number;
  priority?: "Low" | "Medium" | "High";
  sourceScheme?: "Unset" | "NonSecure" | "Secure";
  sourcePort?: number;
}

/**
 * A minimal fake `CookieStatePage` + `AuthTestPage` combined double. Implements exactly the CDP
 * methods `captureCookieState`/`restoreCookieState` issue (per browser-pilot's
 * `src/auth/cookie-state.ts`): `Target.getTargets`, `Target.getBrowserContexts`,
 * `Storage.getCookies`, `Storage.setCookies`. Cookies live in an in-memory store shared across
 * calls so a capture-then-restore(-then-verify) round-trip behaves like a real browser context.
 */
interface CdpSendCall {
  method: string;
  params?: Record<string, unknown>;
}

function cookieCdpPage(url: string, targetId = "cookie-target") {
  let cookies: FakeCdpCookie[] = [];
  const headerCalls: Record<string, string>[] = [];
  const cookieCalls: Record<string, unknown>[] = [];
  const sendLog: CdpSendCall[] = [];
  const page = {
    targetId,
    url: async () => url,
    setExtraHTTPHeaders: async (headers: Record<string, string>) => {
      headerCalls.push(headers);
    },
    setCookie: async (options: Record<string, unknown>) => {
      cookieCalls.push(options);
      return true;
    },
    __sendLog: sendLog,
    cdpClient: {
      send: async (method: string, params?: Record<string, unknown>) => {
        sendLog.push({ method, params });
        switch (method) {
          case "Target.getTargets":
            return { targetInfos: [{ targetId }] };
          case "Target.getBrowserContexts":
            return { browserContextIds: [] };
          case "Storage.getCookies":
            return { cookies };
          case "Storage.setCookies": {
            const incoming = (params?.cookies ?? []) as Array<Record<string, unknown>>;
            cookies = incoming.map((c) => ({
              name: c.name as string,
              value: c.value as string,
              domain:
                c.domain !== undefined ? (c.domain as string) : new URL(c.url as string).hostname,
              path: c.path as string,
              secure: c.secure as boolean,
              httpOnly: c.httpOnly as boolean,
              ...(c.sameSite !== undefined
                ? { sameSite: c.sameSite as "Strict" | "Lax" | "None" }
                : {}),
              expires: (c.expires as number | undefined) ?? -1,
              priority: c.priority as "Low" | "Medium" | "High",
              sourceScheme: c.sourceScheme as "Unset" | "NonSecure" | "Secure",
              sourcePort: c.sourcePort as number,
            }));
            return {};
          }
          default:
            throw new Error(`cookieCdpPage: unexpected CDP method ${method}`);
        }
      },
    },
  };
  return { page: page as unknown as Page, headerCalls, cookieCalls };
}

/** Read back the CDP `send()` call log recorded by {@link cookieCdpPage}. */
function getSendLog(fakePage: Page): CdpSendCall[] {
  return (fakePage as unknown as { __sendLog: CdpSendCall[] }).__sendLog;
}

/** Issue a raw CDP `send()` directly against a {@link cookieCdpPage} fake, to seed its cookie
 * store the same way `restoreCookieState`'s `Storage.setCookies` call would. */
async function sendRaw(
  fakePage: Page,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return (
    fakePage as unknown as {
      cdpClient: {
        send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      };
    }
  ).cdpClient.send(method, params);
}

describe("BrowserPilotDriver saveAuthState + applyAuth cookie_file (real browser-pilot cookie-state)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fp-cookie-state-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("saveAuthState captures cookies and writes a real bp cookie-state file, then applyAuth cookie_file restores it BEFORE literal cookies", async () => {
    const filePath = join(dir, "auth.json");

    // 1) A page with a session cookie already set (simulating a logged-in session captured for
    //    saveAuthState). Set it via the fake page's own Storage.setCookies path so the round trip
    //    exercises the same CDP shape bp itself would see.
    const capturePage = cookieCdpPage("https://example.test/");
    await sendRaw(capturePage.page, "Storage.setCookies", {
      cookies: [
        {
          name: "session",
          value: "snapshot-value",
          domain: ".example.test",
          path: "/",
          secure: true,
          httpOnly: true,
          expires: Math.floor(Date.now() / 1000) + 3600,
        },
      ],
    });

    const driver = new BrowserPilotDriver();
    seedDriverPage(driver, capturePage.page);
    const saved = await driver.saveAuthState(filePath);
    expect(saved.path).toBe(filePath);
    expect(saved.cookieCount).toBe(1);

    // 2) A FRESH page/driver restores the saved snapshot via applyAuth's cookie_file path, then
    //    applies a literal `[[cookies]]` entry — the snapshot restore must happen first, so a
    //    literal cookie for the same name still lands (and would win on read, per real cookie
    //    jar semantics: last write wins for an identical name/domain/path).
    const restorePage = cookieCdpPage("https://example.test/");
    const driver2 = new BrowserPilotDriver();
    seedDriverPage(driver2, restorePage.page);
    await driver2.applyAuth(
      {
        cookie_file: filePath,
        cookies: [{ name: "literal", value: "literal-value", domain: "example.test" }],
      },
      {},
      { flowDir: dir },
    );

    // The restore path goes through bp's restoreCookieState -> Storage.setCookies (observed via
    // the CDP fake), and happens before the literal-cookie setCookie call.
    const sendCalls = getSendLog(restorePage.page);
    const restoreIndex = sendCalls.findIndex((c) => c.method === "Storage.setCookies");
    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    const restoredCookies = sendCalls[restoreIndex]?.params?.cookies as Array<{ name: string }>;
    expect(restoredCookies.some((c) => c.name === "session")).toBe(true);
    expect(restorePage.cookieCalls).toEqual([
      { name: "literal", value: "literal-value", domain: "example.test" },
    ]);
  });

  test("missing cookie_file throws AuthStateUnavailableError with code not_found and the resolved path", async () => {
    const missingPath = join(dir, "does-not-exist.json");
    const driver = new BrowserPilotDriver();
    const page = cookieCdpPage("https://example.test/");
    seedDriverPage(driver, page.page);

    let caught: unknown;
    try {
      await driver.applyAuth({ cookie_file: missingPath }, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthStateUnavailableError);
    expect((caught as AuthStateUnavailableError).code).toBe("not_found");
    expect((caught as AuthStateUnavailableError).path).toBe(missingPath);
  });

  test("missing cookie_file + cookie_save=true still applies extra_headers before throwing", async () => {
    const missingPath = join(dir, "still-does-not-exist.json");
    const driver = new BrowserPilotDriver();
    const page = cookieCdpPage("https://example.test/");
    seedDriverPage(driver, page.page);

    let caught: unknown;
    try {
      await driver.applyAuth(
        {
          cookie_file: missingPath,
          cookie_save: true,
          extra_headers: { from_env: { "X-Test": "TEST_HEADER_ENV" } },
        },
        { TEST_HEADER_ENV: "1" },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthStateUnavailableError);
    expect((caught as AuthStateUnavailableError).code).toBe("not_found");
    expect(page.headerCalls).toEqual([{ "X-Test": "1" }]);
  });

  test("missing cookie_file + cookie_save=false throws immediately without applying extra_headers", async () => {
    const missingPath = join(dir, "also-does-not-exist.json");
    const driver = new BrowserPilotDriver();
    const page = cookieCdpPage("https://example.test/");
    seedDriverPage(driver, page.page);

    let caught: unknown;
    try {
      await driver.applyAuth(
        {
          cookie_file: missingPath,
          cookie_save: false,
          extra_headers: { from_env: { "X-Test": "TEST_HEADER_ENV" } },
        },
        { TEST_HEADER_ENV: "1" },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthStateUnavailableError);
    expect(page.headerCalls).toEqual([]);
  });

  test("garbage-JSON snapshot + cookie_save=true throws a wrapped error naming the file, with CookieStateError as cause", async () => {
    const filePath = join(dir, "garbage.json");
    await writeFile(filePath, "{ not valid json", "utf8");
    const driver = new BrowserPilotDriver();
    const page = cookieCdpPage("https://example.test/");
    seedDriverPage(driver, page.page);

    let caught: unknown;
    try {
      await driver.applyAuth({ cookie_file: filePath, cookie_save: true }, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(AuthStateUnavailableError);
    expect(caught).not.toBeInstanceOf(CookieStateError);
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).toContain(filePath);
    expect(err.message).toContain("[config.auth] saved auth state at");
    expect(err.cause).toBeInstanceOf(CookieStateError);
  });

  test("paths.flowDir resolves a relative cookie_file", async () => {
    const filePath = join(dir, "nested", "auth.json");
    const capturePage = cookieCdpPage("https://example.test/");
    await sendRaw(capturePage.page, "Storage.setCookies", {
      cookies: [
        {
          name: "session",
          value: "v",
          domain: ".example.test",
          path: "/",
          secure: true,
          httpOnly: true,
          expires: Math.floor(Date.now() / 1000) + 3600,
        },
      ],
    });
    const saveDriver = new BrowserPilotDriver();
    seedDriverPage(saveDriver, capturePage.page);
    await saveDriver.saveAuthState(filePath);

    const restorePage = cookieCdpPage("https://example.test/");
    const driver = new BrowserPilotDriver();
    seedDriverPage(driver, restorePage.page);
    // Relative to flowDir; must resolve to the same absolute path as `filePath`.
    await driver.applyAuth({ cookie_file: join("nested", "auth.json") }, {}, { flowDir: dir });
    const sendCalls = getSendLog(restorePage.page);
    expect(sendCalls.some((c) => c.method === "Storage.setCookies")).toBe(true);
  });

  test("a thrown auth error never contains cookie values", async () => {
    const missingPath = join(dir, "missing.json");
    const driver = new BrowserPilotDriver();
    const page = cookieCdpPage("https://example.test/");
    seedDriverPage(driver, page.page);
    let message = "";
    try {
      await driver.applyAuth({ cookie_file: missingPath }, {});
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain("snapshot-value");
    expect(message).not.toContain("literal-value");
  });

  test("applyAuth without cookie_file behaves exactly as before (no CDP cookie-state calls)", async () => {
    const driver = new BrowserPilotDriver();
    const page = cookieCdpPage("https://example.test/");
    seedDriverPage(driver, page.page);
    await driver.applyAuth(
      { cookies: [{ name: "session", value: "literal-value", domain: "example.test" }] },
      {},
    );
    const sendCalls = getSendLog(page.page);
    expect(sendCalls).toHaveLength(0);
    expect(page.cookieCalls).toEqual([
      { name: "session", value: "literal-value", domain: "example.test" },
    ]);
  });
});
