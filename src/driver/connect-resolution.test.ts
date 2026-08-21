// Tests for the Chrome-free connect-config interpretation logic.

import { describe, expect, test } from "bun:test";
import type { AuthConfig, ConnectConfig } from "../config/types.ts";
import {
  AuthEnvVarMissingError,
  attachWsResolutionSource,
  buildAttachConnectArgs,
  buildLaunchPlan,
  connectMode,
  DEFAULT_CHROME_FLAGS,
  normalizeBrowserUrl,
  resolveAuthPlan,
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

// ---------------------------------------------------------------------------
// resolveAuthPlan — [config.auth] resolution (browser-pilot cloudflare-access-auth
// proposal, Slice 6). Chrome-free/network-free: no fetch, no CDP.
// ---------------------------------------------------------------------------

describe("resolveAuthPlan", () => {
  const env = {
    CF_ACCESS_CLIENT_ID: "id-123.access",
    CF_ACCESS_CLIENT_SECRET: "secret-abc",
    CF_ACCESS_JWT: "jwt-value",
    MY_API_KEY: "key-value",
  };

  test("undefined auth resolves to an empty, no-op plan", () => {
    const plan = resolveAuthPlan(undefined, env);
    expect(plan.headers).toEqual({});
    expect(plan.cookies).toEqual([]);
    expect(plan.cfAccessMint).toBeUndefined();
  });

  test("cf_access mode 'cookie' (default) resolves a mint request, not headers", () => {
    const auth: AuthConfig = {
      cf_access: {
        url: "https://prodej.wikov.app",
        client_id_env: "CF_ACCESS_CLIENT_ID",
        client_secret_env: "CF_ACCESS_CLIENT_SECRET",
        mode: "cookie",
      },
    };
    const plan = resolveAuthPlan(auth, env);
    expect(plan.cfAccessMint).toEqual({
      url: "https://prodej.wikov.app",
      clientId: "id-123.access",
      clientSecret: "secret-abc",
    });
    expect(plan.headers).toEqual({});
    expect(plan.cookies).toEqual([]);
  });

  test("cf_access mode 'headers' resolves literal CF-Access-* headers, no mint", () => {
    const auth: AuthConfig = {
      cf_access: {
        url: "https://prodej.wikov.app",
        client_id_env: "CF_ACCESS_CLIENT_ID",
        client_secret_env: "CF_ACCESS_CLIENT_SECRET",
        mode: "headers",
      },
    };
    const plan = resolveAuthPlan(auth, env);
    expect(plan.cfAccessMint).toBeUndefined();
    expect(plan.headers).toEqual({
      "CF-Access-Client-Id": "id-123.access",
      "CF-Access-Client-Secret": "secret-abc",
    });
  });

  test("extra_headers.from_env resolves each header name -> env var value", () => {
    const auth: AuthConfig = {
      extra_headers: { from_env: { "X-Api-Key": "MY_API_KEY" } },
    };
    const plan = resolveAuthPlan(auth, env);
    expect(plan.headers).toEqual({ "X-Api-Key": "key-value" });
  });

  test("cookies[] resolves value_from_env and passes through literal fields", () => {
    const auth: AuthConfig = {
      cookies: [
        {
          name: "CF_Authorization",
          value_from_env: "CF_ACCESS_JWT",
          domain: "prodej.wikov.app",
          path: "/",
          secure: true,
        },
      ],
    };
    const plan = resolveAuthPlan(auth, env);
    expect(plan.cookies).toEqual([
      {
        name: "CF_Authorization",
        value: "jwt-value",
        domain: "prodej.wikov.app",
        path: "/",
        secure: true,
      },
    ]);
  });

  test("cookies[] resolves a literal value verbatim (no env lookup)", () => {
    const auth: AuthConfig = { cookies: [{ name: "session", value: "literal-value" }] };
    const plan = resolveAuthPlan(auth, env);
    expect(plan.cookies).toEqual([{ name: "session", value: "literal-value" }]);
  });

  test("an unset *_env name throws AuthEnvVarMissingError naming the var, never a value", () => {
    const auth: AuthConfig = {
      extra_headers: { from_env: { "X-Api-Key": "UNSET_ENV_VAR" } },
    };
    expect(() => resolveAuthPlan(auth, env)).toThrow(AuthEnvVarMissingError);
    try {
      resolveAuthPlan(auth, env);
      throw new Error("expected resolveAuthPlan to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthEnvVarMissingError);
      expect((err as AuthEnvVarMissingError).envVarName).toBe("UNSET_ENV_VAR");
      expect((err as Error).message).toContain("UNSET_ENV_VAR");
      // never leaks any env value into the error message.
      for (const v of Object.values(env)) {
        expect((err as Error).message).not.toContain(v);
      }
    }
  });

  test("an unset cf_access client_id_env/client_secret_env throws before any headers/cookies apply", () => {
    const auth: AuthConfig = {
      cf_access: {
        url: "https://x.test",
        client_id_env: "UNSET_ID_ENV",
        client_secret_env: "CF_ACCESS_CLIENT_SECRET",
        mode: "cookie",
      },
      cookies: [{ name: "unrelated", value: "x" }],
    };
    expect(() => resolveAuthPlan(auth, env)).toThrow(AuthEnvVarMissingError);
  });

  test("an unset cookies[].value_from_env throws naming the var", () => {
    const auth: AuthConfig = {
      cookies: [{ name: "session", value_from_env: "UNSET_SESSION_ENV" }],
    };
    expect(() => resolveAuthPlan(auth, env)).toThrow(AuthEnvVarMissingError);
  });

  test("cf_access + extra_headers + cookies combine into one plan", () => {
    const auth: AuthConfig = {
      cf_access: {
        url: "https://x.test",
        client_id_env: "CF_ACCESS_CLIENT_ID",
        client_secret_env: "CF_ACCESS_CLIENT_SECRET",
        mode: "headers",
      },
      extra_headers: { from_env: { "X-Api-Key": "MY_API_KEY" } },
      cookies: [{ name: "session", value: "literal" }],
    };
    const plan = resolveAuthPlan(auth, env);
    expect(plan.headers).toEqual({
      "CF-Access-Client-Id": "id-123.access",
      "CF-Access-Client-Secret": "secret-abc",
      "X-Api-Key": "key-value",
    });
    expect(plan.cookies).toEqual([{ name: "session", value: "literal" }]);
  });
});
