import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, connect, getBrowserWebSocketUrl } from "browser-pilot";
import { type LaunchedChrome, launch } from "chrome-launcher";
import { runAssertion } from "../assert/engine.ts";
import { BrowserPilotDriver } from "./browser-pilot-driver.ts";
import { NavigationFailure } from "./navigation.ts";

const enabled = process.env.FLIGHTPLAN_BROWSER_INTEGRATION === "1";
const headed = process.env.FLIGHTPLAN_BROWSER_HEADED === "1";
const browserTest = enabled ? test : test.skip;
let chrome: LaunchedChrome | undefined;
let browser: Browser | undefined;

beforeAll(async () => {
  if (!enabled) return;
  // A disposable profile prevents these regressions from touching a signed-in browser.
  chrome = await launch({
    chromeFlags: [
      ...(headed ? [] : ["--headless=new"]),
      "--no-first-run",
      "--disable-popup-blocking",
    ],
  });
  browser = await connect({
    provider: "generic",
    wsUrl: await getBrowserWebSocketUrl(`http://127.0.0.1:${chrome.port}`),
  });
}, 30_000);

afterAll(async () => {
  try {
    await browser?.disconnect();
  } finally {
    await chrome?.kill();
  }
});

browserTest(
  "default document navigation permits a response slower than the settle limit",
  async () => {
    if (!chrome) throw new Error("isolated browser was not initialized");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await Bun.sleep(2200);
        return new Response("<h1>Ready</h1>", { headers: { "Content-Type": "text/html" } });
      },
    });
    const driver = new BrowserPilotDriver();
    try {
      await driver.connect({ mode: "attach", browserURL: `http://127.0.0.1:${chrome.port}` });
      await driver.goto(`http://127.0.0.1:${server.port}`, { waitForNavigation: false });
      expect((await driver.elementState("css:h1")).text).toBe("Ready");
    } finally {
      await driver.teardown();
      await server.stop(true);
    }
  },
  30_000,
);

(enabled && headed ? test : test.skip)(
  "headed attach verifies focus and Escape delivery on its selected tab",
  async () => {
    if (!chrome || !browser) throw new Error("isolated browser was not initialized");
    const html =
      '<button id="close">Close</button><div id="dialog">Open</div><script>document.addEventListener("keydown", e => { if(e.key === "Escape") document.getElementById("dialog").remove(); });</script>';
    const driver = new BrowserPilotDriver();
    const foreground = new BrowserPilotDriver();
    try {
      await driver.connect({ mode: "attach", browserURL: `http://127.0.0.1:${chrome.port}` });
      await driver.goto(`data:text/html,${encodeURIComponent(html)}`, { waitForNavigation: false });
      const sentinel = await browser.newPage("data:text/html,keyboard-sentinel");
      await sentinel.cdpClient.send("Page.bringToFront");
      await Bun.sleep(250);
      expect(
        await sentinel.evaluate<boolean>(
          'document.visibilityState === "visible" && document.hasFocus()',
        ),
      ).toBe(true);
      await expect(driver.press("Escape")).rejects.toMatchObject({
        code: "KEYBOARD_NOT_READY",
        dispatchState: "not_dispatched",
      });
      expect((await driver.elementState("css:#dialog")).exists).toBe(true);
      expect(await sentinel.evaluate<boolean>("document.hasFocus()")).toBe(true);
      await foreground.connect({
        mode: "attach",
        browserURL: `http://127.0.0.1:${chrome.port}`,
        foreground: true,
      });
      await foreground.goto(`data:text/html,${encodeURIComponent(html)}`, {
        waitForNavigation: false,
      });
      await sentinel.cdpClient.send("Page.bringToFront");
      await Bun.sleep(250);
      expect(await foreground.press("Escape")).toBe(true);
      expect((await foreground.elementState("css:#dialog")).exists).toBe(false);
    } finally {
      await foreground.teardown();
      await driver.teardown();
    }
  },
  30_000,
);

browserTest(
  "invalid selectors fail, missing elements pass absence, and owned tabs close",
  async () => {
    if (!chrome || !browser) throw new Error("isolated browser was not initialized");
    const before = (await browser.listTargets()).map((target) => target.targetId).sort();
    const driver = new BrowserPilotDriver();
    try {
      await driver.connect({ mode: "attach", browserURL: `http://127.0.0.1:${chrome.port}` });
      await driver.goto(
        `data:text/html,${encodeURIComponent('<h1>Tasks</h1><nav aria-label="Main navigation">Home</nav><form><input id="draft"><button>Save</button></form><img class="hero" src="data:,x">')}`,
        { timeout: 5000, waitForNavigation: false },
      );
      const ctx = { driver, defaultTimeoutMs: 1, mode: "eager", failOnAssertion: true } as const;
      for (const selector of [
        "css:[",
        "h1",
        "nav[aria-label='Main navigation']",
        "form input",
        "input + button",
        "button, input",
        "img.hero",
        "button:first-of-type",
      ]) {
        expect((await runAssertion({ type: "hidden", selector }, ctx)).pass).toBe(false);
        expect((await runAssertion({ type: "count", selector, count: 0 }, ctx)).pass).toBe(false);
      }
      expect((await runAssertion({ type: "hidden", selector: "css:#missing" }, ctx)).pass).toBe(
        true,
      );
      expect(
        (await runAssertion({ type: "count", selector: "role:heading:Tasks", count: 0 }, ctx)).pass,
      ).toBe(false);
      expect(
        (await runAssertion({ type: "count", selector: "role:heading:Tasks", count: 1 }, ctx)).pass,
      ).toBe(true);
      expect(
        (await runAssertion({ type: "value", selector: "css:#draft", value: "" }, ctx)).pass,
      ).toBe(true);
    } finally {
      await driver.teardown();
    }
    expect((await browser.listTargets()).map((target) => target.targetId).sort()).toEqual(before);
  },
  30_000,
);

browserTest(
  "navigation honors an override and reports the default limit on timeout",
  async () => {
    if (!chrome || !browser) throw new Error("isolated browser was not initialized");
    const before = (await browser.listTargets()).map((target) => target.targetId).sort();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await Bun.sleep(400);
        return new Response("ready", { headers: { "Content-Type": "text/html" } });
      },
    });
    const driver = new BrowserPilotDriver({ navTimeoutMs: 100 });
    try {
      await driver.connect({ mode: "attach", browserURL: `http://127.0.0.1:${chrome.port}` });
      const url = `http://127.0.0.1:${server.port}/slow`;
      await driver.goto(url, { timeout: 2000, waitForNavigation: false });
      let failure: unknown;
      try {
        await driver.goto(`${url}?timeout`, { waitForNavigation: false });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(NavigationFailure);
      expect(failure).toMatchObject({ timeoutMs: 100, code: "NAVIGATION_FAILED" });
    } finally {
      await driver.teardown();
      await server.stop(true);
    }
    expect((await browser.listTargets()).map((target) => target.targetId).sort()).toEqual(before);
  },
  30_000,
);

browserTest(
  "teardown preserves an explicitly reused tab",
  async () => {
    if (!chrome || !browser) throw new Error("isolated browser was not initialized");
    const sentinel = await browser.newPage("data:text/html,flightplan-owner-sentinel");
    const driver = new BrowserPilotDriver();
    try {
      await driver.connect({
        mode: "attach",
        browserURL: `http://127.0.0.1:${chrome.port}`,
        targetUrl: "flightplan-owner-sentinel",
      });
    } finally {
      await driver.teardown();
    }
    expect(
      (await browser.listTargets()).some((target) => target.targetId === sentinel.targetId),
    ).toBe(true);
  },
  30_000,
);

browserTest(
  "teardown closes a popup even when its expectation does not match",
  async () => {
    if (!chrome || !browser) throw new Error("isolated browser was not initialized");
    const before = (await browser.listTargets()).map((target) => target.targetId).sort();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new Response(
          new URL(request.url).pathname === "/popup"
            ? "Popup"
            : "<button id=\"open\" onclick=\"window.open('/popup','_blank')\">Open</button>",
          { headers: { "Content-Type": "text/html" } },
        ),
    });
    const driver = new BrowserPilotDriver();
    try {
      await driver.connect({ mode: "attach", browserURL: `http://127.0.0.1:${chrome.port}` });
      await driver.goto(`http://127.0.0.1:${server.port}`, { waitForNavigation: false });
      const result = await driver.expectNewPage({ url: "/never-matches", timeoutMs: 500 }, () =>
        driver.click("#open", { waitForNavigation: false }),
      );
      expect(result.matched).toBe(false);
      expect((await browser.listTargets()).some((target) => target.url.includes("/popup"))).toBe(
        true,
      );
    } finally {
      await driver.teardown();
      await server.stop(true);
    }
    expect((await browser.listTargets()).map((target) => target.targetId).sort()).toEqual(before);
  },
  30_000,
);

browserTest(
  "semantic counts do not count a control's accessibility text children twice",
  async () => {
    if (!chrome) throw new Error("isolated browser was not initialized");
    const driver = new BrowserPilotDriver();
    try {
      await driver.connect({ mode: "attach", browserURL: `http://127.0.0.1:${chrome.port}` });
      await driver.goto("data:text/html,<button>Save</button>", { waitForNavigation: false });
      const ctx = { driver, defaultTimeoutMs: 1, mode: "eager", failOnAssertion: true } as const;
      for (const selector of ["text:Save", "Save", "role:button:Save"])
        expect((await runAssertion({ type: "count", selector, count: 1 }, ctx)).pass).toBe(true);
    } finally {
      await driver.teardown();
    }
  },
  30_000,
);
