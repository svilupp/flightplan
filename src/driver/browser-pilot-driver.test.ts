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
