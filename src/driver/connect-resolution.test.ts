// Tests for the Chrome-free connect-config interpretation logic.

import { describe, expect, test } from "bun:test";
import type { ConnectConfig } from "../config/types.ts";
import {
  attachWsResolutionSource,
  buildAttachConnectArgs,
  buildLaunchPlan,
  connectMode,
  DEFAULT_CHROME_FLAGS,
  normalizeBrowserUrl,
} from "./connect-resolution.ts";
import { clickStep, pressStep, resolveWaitForNavigation, submitOptions } from "./navigation.ts";

describe("connectMode", () => {
  test("derives attach vs launch from the discriminant", () => {
    expect(connectMode({ mode: "attach" })).toBe("attach");
    expect(connectMode({ mode: "launch" })).toBe("launch");
  });
});

describe("attachWsResolutionSource — precedence", () => {
  test("explicit wsUrl wins", () => {
    expect(
      attachWsResolutionSource({
        mode: "attach",
        wsUrl: "ws://x",
        browserURL: "127.0.0.1:9222",
      }),
    ).toBe("explicit-ws");
  });
  test("browserURL is next", () => {
    expect(attachWsResolutionSource({ mode: "attach", browserURL: "127.0.0.1:9222" })).toBe(
      "browser-url",
    );
  });
  test("autodiscover is the fallback", () => {
    expect(attachWsResolutionSource({ mode: "attach" })).toBe("autodiscover");
    expect(attachWsResolutionSource({ mode: "attach", autodiscover: { channel: "stable" } })).toBe(
      "autodiscover",
    );
  });
});

describe("buildAttachConnectArgs", () => {
  test("always uses the generic provider; passes a resolved wsUrl", () => {
    const args = buildAttachConnectArgs({ mode: "attach", wsUrl: "ws://a" }, "ws://a");
    expect(args).toEqual({ provider: "generic", wsUrl: "ws://a" });
  });

  test("omits wsUrl when none resolved (auto-discovery)", () => {
    const args = buildAttachConnectArgs({ mode: "attach" }, undefined);
    expect(args).toEqual({ provider: "generic" });
    expect("wsUrl" in args).toBe(false);
  });

  test("threads autodiscover channel + userDataDir", () => {
    const args = buildAttachConnectArgs(
      { mode: "attach", autodiscover: { channel: "beta", userDataDir: "/tmp/p" } },
      undefined,
    );
    expect(args).toEqual({ provider: "generic", channel: "beta", userDataDir: "/tmp/p" });
  });
});

describe("buildLaunchPlan — defaults", () => {
  test("headless defaults to true; flags default to DEFAULT_CHROME_FLAGS", () => {
    const plan = buildLaunchPlan({ mode: "launch" });
    expect(plan.headless).toBe(true);
    expect(plan.chromeFlags).toEqual([...DEFAULT_CHROME_FLAGS]);
    expect(plan.provider).toBe("generic");
  });

  test("headless:false strips --headless=new from the defaults", () => {
    const plan = buildLaunchPlan({ mode: "launch", headless: false });
    expect(plan.headless).toBe(false);
    expect(plan.chromeFlags).not.toContain("--headless=new");
    expect(plan.chromeFlags).toContain("--no-sandbox");
  });

  test("explicit chromeFlags are used verbatim", () => {
    const plan = buildLaunchPlan({ mode: "launch", chromeFlags: ["--foo", "--bar"] });
    expect(plan.chromeFlags).toEqual(["--foo", "--bar"]);
  });

  test("channel + userDataDir are carried through", () => {
    const plan = buildLaunchPlan({ mode: "launch", channel: "canary", userDataDir: "/d" });
    expect(plan.channel).toBe("canary");
    expect(plan.userDataDir).toBe("/d");
  });
});

describe("normalizeBrowserUrl", () => {
  test("strips scheme + path", () => {
    expect(normalizeBrowserUrl("http://127.0.0.1:9222/")).toBe("127.0.0.1:9222");
    expect(normalizeBrowserUrl("https://localhost:9333/json/version")).toBe("localhost:9333");
  });
  test("defaults the port to 9222 when absent", () => {
    expect(normalizeBrowserUrl("localhost")).toBe("localhost:9222");
    expect(normalizeBrowserUrl("http://example.test")).toBe("example.test:9222");
  });
  test("leaves a bare host:port intact", () => {
    expect(normalizeBrowserUrl("127.0.0.1:9222")).toBe("127.0.0.1:9222");
  });
});

describe("navigation defaults — the DRIVER DEFAULT (waitForNavigation=true)", () => {
  test("resolveWaitForNavigation defaults to true, overridable", () => {
    expect(resolveWaitForNavigation()).toBe(true);
    expect(resolveWaitForNavigation({})).toBe(true);
    expect(resolveWaitForNavigation({ waitForNavigation: false })).toBe(false);
    expect(resolveWaitForNavigation({ waitForNavigation: "auto" })).toBe("auto");
  });

  test("clickStep forces waitForNavigation:true by default", () => {
    const step = clickStep("#go");
    expect(step.action).toBe("click");
    expect(step.selector).toBe("#go");
    expect(step.waitForNavigation).toBe(true);
  });

  test("clickStep honours an explicit override + threads timeout/optional", () => {
    const step = clickStep("#go", { waitForNavigation: "auto", timeout: 5000, optional: true });
    expect(step.waitForNavigation).toBe("auto");
    expect(step.timeout).toBe(5000);
    expect(step.optional).toBe(true);
  });

  test("pressStep defaults to settling", () => {
    expect(pressStep("Enter").waitForNavigation).toBe(true);
    expect(pressStep("Tab", false).waitForNavigation).toBe(false);
  });

  test("submitOptions defaults waitForNavigation:true and threads method", () => {
    expect(submitOptions().waitForNavigation).toBe(true);
    const o = submitOptions({ method: "enter", waitForNavigation: false });
    expect(o.method).toBe("enter");
    expect(o.waitForNavigation).toBe(false);
  });
});

// A small compile-time/value sanity check that ConnectConfig is the shared shape.
describe("ConnectConfig shape (shared with config module)", () => {
  test("an attach config and a launch config both satisfy ConnectConfig", () => {
    const attach: ConnectConfig = { mode: "attach", wsUrl: "ws://x" };
    const launch: ConnectConfig = { mode: "launch", headless: true };
    expect(attach.mode).toBe("attach");
    expect(launch.mode).toBe("launch");
  });
});
