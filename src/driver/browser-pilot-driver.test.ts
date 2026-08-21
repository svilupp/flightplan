import { describe, expect, test } from "bun:test";
import { TargetNotFoundError } from "browser-pilot";
import { BrowserPilotDriver, getBrowserPilotProvenance } from "./browser-pilot-driver.ts";
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
