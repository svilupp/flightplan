import { expect, spyOn, test } from "bun:test";
import type { BorrowedBrowser, Page } from "browser-pilot/core";
import { memoryFileSystem } from "../adapters/memory.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import { ConnectHostedSchema, ConnectSessionSchema } from "../config/schema.ts";
import { runFlow } from "../runner/runner.ts";
import { acquireDriverLease, BrowserPilotDriver } from "./browser-pilot-driver.ts";

test("hosted/session configuration uses secret references and requires exact target identity", () => {
  expect(ConnectHostedSchema.parse({ mode: "hosted", provider: "cloudflare" }).api_token_env).toBe(
    "CLOUDFLARE_API_TOKEN",
  );
  expect(
    ConnectHostedSchema.safeParse({ mode: "hosted", provider: "cloudflare", apiKey: "secret" })
      .success,
  ).toBe(false);
  expect(
    ConnectSessionSchema.safeParse({ mode: "session", session_ref: "shop", target_policy: "exact" })
      .success,
  ).toBe(false);
});

test("two borrowed drivers select the same exact target and teardown only detaches", async () => {
  let detach = 0;
  let selected: unknown;
  const page = { targetId: "page", onDialog: async () => {} } as unknown as Page;
  const browser = {
    page: async (_name, options) => {
      selected = options;
      return page;
    },
    listTargets: async () => [],
  } satisfies BorrowedBrowser;
  const cfg = ConnectSessionSchema.parse({
    mode: "session",
    session_ref: "shop",
    target_policy: "exact",
    target_id: "page",
  });
  for (let i = 0; i < 2; i++) {
    const driver = new BrowserPilotDriver({
      acquire: async (config) =>
        acquireDriverLease(
          {
            handle: { id: "owner", provider: "generic", generation: "host" },
            browser,
            detach: async () => {
              detach++;
            },
          },
          config.mode === "session" ? config.target_id : undefined,
        ),
    });
    await driver.connect(cfg);
    expect(await driver.page()).toBe(page);
    await driver.teardown();
  }
  expect(selected).toEqual({ targetId: "page" });
  expect(detach).toBe(2);
});

test("failed driver setup detaches its acquired lease", async () => {
  let detach = 0;
  const driver = new BrowserPilotDriver({
    acquire: async () => ({
      browser: {
        page: async () => {
          throw Error("unused");
        },
        listTargets: async () => [],
      },
      page: {
        onDialog: async () => {
          throw Error("setup failed");
        },
      } as unknown as Page,
      detach: async () => {
        detach++;
      },
    }),
  });
  await expect(
    driver.connect(ConnectHostedSchema.parse({ mode: "hosted", provider: "cloudflare" })),
  ).rejects.toThrow("setup failed");
  expect(detach).toBe(1);
});

test("owned hosted teardown reports pending cleanup with the exact allocation", async () => {
  const page = { onDialog: async () => {} } as unknown as Page;
  const driver = new BrowserPilotDriver({ providerEnv: { ACCOUNT: "fixture", TOKEN: "fixture" } });
  const native = driver as unknown as {
    connectNative(): Promise<import("browser-pilot/core").Browser>;
  };
  native.connectNative = async () =>
    ({
      page: async () => page,
      close: async () => ({
        status: "cleanup_pending",
        sessionId: "allocation",
        providerStatus: "closing",
      }),
    }) as unknown as import("browser-pilot/core").Browser;
  await driver.connect({
    mode: "hosted",
    provider: "cloudflare",
    account_id_env: "ACCOUNT",
    api_token_env: "TOKEN",
  });
  await expect(driver.teardown()).rejects.toMatchObject({
    providerCleanup: { status: "cleanup_pending", sessionId: "allocation" },
  });
});

test("failed hosted page acquisition preserves pending provider cleanup and setup cause", async () => {
  const driver = new BrowserPilotDriver({ providerEnv: { ACCOUNT: "fixture", TOKEN: "fixture" } });
  const setupError = new Error("page setup failed");
  const native = driver as unknown as {
    connectNative(): Promise<import("browser-pilot/core").Browser>;
  };
  native.connectNative = async () =>
    ({
      page: async () => {
        throw setupError;
      },
      close: async () => ({ status: "cleanup_pending", sessionId: "setup-allocation" }),
    }) as unknown as import("browser-pilot/core").Browser;
  await expect(
    driver.connect({
      mode: "hosted",
      provider: "cloudflare",
      account_id_env: "ACCOUNT",
      api_token_env: "TOKEN",
    }),
  ).rejects.toMatchObject({
    cause: setupError,
    providerCleanup: { status: "cleanup_pending", sessionId: "setup-allocation" },
  });
});

for (const controlled of [false, true]) {
  test(`default hosted runner forwards explicit credentials${controlled ? " and cancellation context" : ""}`, async () => {
    const prototype = BrowserPilotDriver.prototype as unknown as {
      connectNative(
        options: Record<string, unknown>,
      ): Promise<import("browser-pilot/core").Browser>;
    };
    const connect = spyOn(prototype, "connectNative").mockRejectedValue(
      new Error("stop before allocation"),
    );
    try {
      const result = await runFlow({
        flowPath: "/virtual/hosted.toml",
        flowSource:
          'version=1\nkind="flow"\nid="hosted"\ndescription="hosted"\n[[steps]]\nid="open"\ndo="goto"\nurl="https://fixture.test/"',
        config: resolveConfigWithDefaults([
          {
            connect: {
              mode: "hosted",
              provider: "cloudflare",
              account_id_env: "TEST_ACCOUNT",
              api_token_env: "TEST_TOKEN",
            },
          },
        ]),
        fs: memoryFileSystem(),
        env: { TEST_ACCOUNT: "injected-account", TEST_TOKEN: "injected-token" },
        out: "/virtual/runs",
        ...(controlled ? { timeoutMs: 5000 } : {}),
      });
      expect(result.summary.verdict).toBe("error");
      expect(connect).toHaveBeenCalledTimes(1);
      const options = connect.mock.calls[0]![0];
      expect(options).toMatchObject({
        apiKey: "injected-token",
        cloudflare: { accountId: "injected-account" },
      });
      if (controlled) {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.timeout).toBeLessThanOrEqual(5000);
      }
    } finally {
      connect.mockRestore();
    }
  });
}
