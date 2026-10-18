import { afterAll, beforeAll, expect, test } from "bun:test";
import { JEV_ROUTES, renderJevFixture } from "../../examples/fixtures/jev.ts";
import { jevOracle } from "../../examples/fixtures/jev-oracles.ts";
import { BrowserPilotDriver } from "./browser-pilot-driver.ts";

const enabled = process.env.FLIGHTPLAN_BROWSER_INTEGRATION === "1";
const browserTest = enabled ? test : test.skip;
let server: ReturnType<typeof Bun.serve>;
let driver: BrowserPilotDriver;
beforeAll(async () => {
  if (!enabled) return;
  server = Bun.serve({
    port: 0,
    fetch: (req) =>
      new Response(renderJevFixture(new URL(req.url)), {
        headers: { "Content-Type": "text/html" },
      }),
  });
  driver = new BrowserPilotDriver();
  await driver.connect({
    mode: "attach",
    browserURL: process.env.FLIGHTPLAN_BROWSER_URL ?? "localhost:9222",
  });
}, 30_000);
afterAll(async () => {
  await driver?.teardown();
  await server?.stop();
});

for (const route of JEV_ROUTES) {
  browserTest(
    `${route}: deterministic oracle, ledger and reset`,
    async () => {
      for (let repeat = 0; repeat < 3; repeat++) {
        await driver.goto(`http://127.0.0.1:${server.port}/jev/${route}`);
        const oracle = jevOracle(route);
        if (oracle.target) {
          const result = await driver.batch(
            [{ action: "click", selector: `#${oracle.target}`, waitForNavigation: false }],
            { timeout: 3000 },
          );
          expect(result.steps[0]?.success).toBe(true);
        }
        expect((await driver.elementState("#result")).text).toBe(oracle.result);
        expect((await driver.elementState("#count")).text).toBe(String(oracle.dispatches));
        expect(await driver.evaluateExpression?.("window.__jevFixture.reset()")).toBe(2);
        expect((await driver.elementState("#result")).text).toBe("");
        expect((await driver.elementState("#count")).text).toBe("0");
      }
    },
    60_000,
  );
}

browserTest(
  "delayed acknowledgement does not require another mutation",
  async () => {
    await driver.goto(`http://127.0.0.1:${server.port}/jev/mutation?variant=delayed`);
    await driver.batch([{ action: "click", selector: "#q1", waitForNavigation: false }]);
    expect((await driver.elementState("#result")).text).toBe("");
    await driver.evaluateExpression?.("window.__jevFixture.barrier('release')");
    expect((await driver.elementState("#count")).text).toBe("1");
    expect((await driver.elementState("#result")).text).toBe("selected:q1");
  },
  30_000,
);

browserTest(
  "cold JEV selection learns a durable lock; frozen warm replay avoids JEV",
  async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runFlow } = await import("../runner/runner.ts");
    const { createAiRuntime } = await import("../ai/runtime.ts");
    const { resolveConfigWithDefaults } = await import("../config/resolve.ts");
    const folder = await mkdtemp(join(tmpdir(), "jev-browser-replay-"));
    let calls = 0;
    try {
      const flowPath = join(folder, "flow.toml");
      const flow = (await Bun.file("examples/flows/jev/baseline.toml").text()).replace(
        "http://localhost:3000",
        `http://127.0.0.1:${server.port}`,
      );
      await Bun.write(flowPath, flow);
      const config = resolveConfigWithDefaults([
        {
          connect: {
            mode: "attach",
            browserURL: process.env.FLIGHTPLAN_BROWSER_URL ?? "localhost:9222",
          },
          ai: { classifier: "jev", jev: { profile: "text" } },
          run: { max_model_calls: 4, max_screenshots: 0, max_cost_usd: 0.01 },
        },
      ]);
      const fetchFn = (async (_url: unknown, init?: RequestInit) => {
        calls++;
        if (typeof init?.body !== "string") throw new Error("Expected JSON request");
        const req = JSON.parse(init.body);
        const criteria = req.questions.pick.criteria as Record<string, { name?: string }>;
        const selected = Object.keys(criteria).find((k) => criteria[k]?.name === "Continue");
        if (!selected) throw new Error("Expected Continue candidate");
        return new Response(
          JSON.stringify({
            model: req.model,
            answers: {
              pick: {
                type: "choice",
                choice: selected,
                confidence: 1,
                probabilities: Object.fromEntries(
                  Object.keys(criteria).map((k) => [k, k === selected ? 1 : 0]),
                ),
              },
            },
            usage: { input_tokens: 100, output_tokens: 0 },
          }),
        );
      }) as typeof fetch;
      const options = {
        flowPath,
        config,
        out: join(folder, "runs"),
        env: {},
        driverFactory: () => new BrowserPilotDriver(),
        aiRuntimeFactory: (deps: Parameters<typeof createAiRuntime>[0]) =>
          createAiRuntime({ ...deps, jevApiKey: "fake", fetchFn }),
      };
      const cold = await runFlow(options);
      expect(cold.exitCode).toBe(0);
      expect(calls).toBe(1);
      expect(cold.summary.steps.some((s) => s.tier === "L2")).toBe(true);
      const lockPath = join(folder, "flow.lock.toml");
      const lock = await readFile(lockPath, "utf8");
      expect(lock).not.toContain("ref:e");
      calls = 0;
      const warm = await runFlow({ ...options, frozen: true, noLockWrite: true });
      expect(warm.exitCode).toBe(0);
      expect(calls).toBe(0);
      expect(warm.summary.steps.some((s) => s.tier === "L0")).toBe(true);
      expect(await readFile(lockPath, "utf8")).toBe(lock);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
  60_000,
);

browserTest(
  "production capture proves geometry and rejects secret pixels",
  async () => {
    await driver.goto(`http://127.0.0.1:${server.port}/jev/baseline`);
    const snapshot = await driver.snapshot();
    const refs = snapshot.interactiveElements.filter((e) => e.role === "button").map((e) => e.ref);
    expect(refs.length).toBeGreaterThan(0);
    const evidence = await driver.captureJevEvidence({ refs });
    expect(evidence.pixelsSafe).toBe(true);
    expect(evidence.image.width).toBeGreaterThanOrEqual(280);
    expect(Object.keys(evidence.geometry).sort()).toEqual(refs.sort());
    await driver.goto(`http://127.0.0.1:${server.port}/jev/redaction`);
    await expect(driver.captureJevEvidence({ refs: [] })).rejects.toThrow();
  },
  30_000,
);

for (const scenario of [
  "icons",
  "context",
  "stale",
  "redaction",
  "mutation",
  "mutation_navigation",
  "diagnosis",
] as const) {
  browserTest(
    `active visual ${scenario}: exact action or local refusal`,
    async () => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { runFlow } = await import("../runner/runner.ts");
      const { createAiRuntime } = await import("../ai/runtime.ts");
      const { resolveConfigWithDefaults } = await import("../config/resolve.ts");
      const folder = await mkdtemp(join(tmpdir(), "jev-visual-browser-"));
      const active = new BrowserPilotDriver();
      const teardown = active.teardown.bind(active);
      active.teardown = async () => {};
      let calls = 0;
      try {
        const flowPath = join(folder, "flow.toml");
        let flow = await Bun.file("examples/flows/jev/icons.toml").text();
        flow = flow
          .replace("http://localhost:3000", `http://127.0.0.1:${server.port}`)
          .replace(
            "/jev/icons",
            `/jev/${scenario === "mutation_navigation" ? "mutation" : scenario}${scenario === "mutation" ? "?variant=delayed" : scenario === "mutation_navigation" ? "?variant=navigate" : scenario === "diagnosis" ? "?variant=wrong" : ""}`,
          )
          .replace(
            "the trash-can icon",
            scenario === "context" ? "the button in the Billing card" : "the Continue button",
          );
        if (scenario === "context") flow = flow.replace("selected:q1", "selected:q2");
        await Bun.write(flowPath, flow);
        const config = resolveConfigWithDefaults([
          {
            connect: {
              mode: "attach",
              browserURL: process.env.FLIGHTPLAN_BROWSER_URL ?? "localhost:9222",
            },
            ai: { classifier: "jev", jev: { profile: "visual", images: "allow" } },
            run: { max_model_calls: 2, max_screenshots: 1, max_cost_usd: 0.01 },
          },
        ]);
        const fetchFn = (async (_url: unknown, init?: RequestInit) => {
          calls++;
          if (typeof init?.body !== "string") throw new Error("Expected JSON request");
          const request = JSON.parse(init.body);
          const rectangles = Object.entries(request.state.rectangles) as Array<
            [string, { x: number }]
          >;
          rectangles.sort((a, b) => a[1].x - b[1].x);
          expect(rectangles).toHaveLength(
            scenario === "context" || scenario === "icons"
              ? 3
              : scenario === "mutation" ||
                  scenario === "mutation_navigation" ||
                  scenario === "diagnosis"
                ? 1
                : 2,
          );
          const selected = rectangles[scenario === "context" ? 1 : 0]![0];
          if (scenario === "stale")
            await active.evaluateExpression("window.__jevFixture.barrier('move')");
          return new Response(
            JSON.stringify({
              model: request.model,
              answers: {
                pick: {
                  type: "choice",
                  choice: selected,
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    Object.keys(request.questions.pick.criteria).map((k) => [
                      k,
                      k === selected ? 1 : 0,
                    ]),
                  ),
                },
                present: { type: "noul", noul: 1 },
              },
              usage: { input_tokens: 1000, output_tokens: 0 },
            }),
          );
        }) as typeof fetch;
        const result = await runFlow({
          flowPath,
          config,
          out: join(folder, "runs"),
          noLockWrite: true,
          env: {},
          startTier: "L3",
          driverFactory: () => active,
          aiRuntimeFactory: (deps) => createAiRuntime({ ...deps, jevApiKey: "fake", fetchFn }),
        });
        const allowed = scenario === "icons" || scenario === "context";
        expect(result.exitCode === 0).toBe(allowed);
        expect(calls).toBe(scenario === "redaction" ? 0 : 1);
        expect((await active.elementState("#count")).text).toBe(
          allowed ||
            scenario === "mutation" ||
            scenario === "mutation_navigation" ||
            scenario === "diagnosis"
            ? "1"
            : "0",
        );
        if (scenario === "mutation" || scenario === "mutation_navigation") {
          await active.evaluateExpression("window.__jevFixture.barrier('release')");
          expect((await active.elementState("#count")).text).toBe("1");
          expect((await active.elementState("#result")).text).toBe("selected:q1");
        }
        if (allowed)
          expect((await active.elementState("#result")).text).toBe(
            `selected:q${scenario === "context" ? 2 : 1}`,
          );
      } finally {
        await teardown();
        await rm(folder, { recursive: true, force: true });
      }
    },
    30_000,
  );
}

browserTest(
  "mobile DPR2 capture records actual transform and refuses oversized frames",
  async () => {
    const mobile = new BrowserPilotDriver();
    await mobile.connect({
      mode: "attach",
      browserURL: process.env.FLIGHTPLAN_BROWSER_URL ?? "localhost:9222",
    });
    const page = Reflect.get(mobile, "activePage") as {
      cdpClient: { send(method: string, params: Record<string, unknown>): Promise<unknown> };
    };
    try {
      await page.cdpClient.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 600,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await mobile.goto(`http://127.0.0.1:${server.port}/jev/geometry`);
      const snapshot = await mobile.snapshot();
      const evidence = await mobile.captureJevEvidence({
        refs: snapshot.interactiveElements.filter((e) => e.role === "button").map((e) => e.ref),
      });
      expect(evidence.image.width).toBe(780);
      expect(evidence.image.height).toBe(1200);
      expect(evidence.viewport.dpr).toBe(2);
      await page.cdpClient.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: false,
      });
      let reason: string | undefined;
      try {
        await mobile.captureJevEvidence({ refs: [] });
      } catch (error) {
        reason = error instanceof Error ? error.message : "unknown";
      }
      expect(reason).toBe("jev_result_invalid");
    } finally {
      await page.cdpClient.send("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
      await mobile.teardown();
    }
  },
  30_000,
);

browserTest(
  "iframe refuses capture; navigation invalidates prior identity",
  async () => {
    const local = new BrowserPilotDriver();
    await local.connect({
      mode: "attach",
      browserURL: process.env.FLIGHTPLAN_BROWSER_URL ?? "localhost:9222",
    });
    try {
      await local.goto(`http://127.0.0.1:${server.port}/jev/geometry?variant=iframe`);
      await expect(local.captureJevEvidence({ refs: [] })).rejects.toThrow("jev_pixels_unsafe");
      await local.goto(`http://127.0.0.1:${server.port}/jev/baseline`);
      const before = await local.captureJevEvidence({ refs: [] });
      await local.goto(`http://127.0.0.1:${server.port}/jev/baseline?variant=navigated`);
      expect(await local.validateJevEvidence(before)).toBe(false);
    } finally {
      await local.teardown();
    }
  },
  30_000,
);

browserTest(
  "zoom refuses unknown viewport transform",
  async () => {
    const local = new BrowserPilotDriver();
    await local.connect({
      mode: "attach",
      browserURL: process.env.FLIGHTPLAN_BROWSER_URL ?? "localhost:9222",
    });
    try {
      await local.goto(`http://127.0.0.1:${server.port}/jev/baseline`);
      const page = Reflect.get(local, "activePage") as {
        cdpClient: { send(method: string, params: Record<string, unknown>): Promise<unknown> };
      };
      try {
        await page.cdpClient.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.25 });
        let reason: string | undefined;
        try {
          await local.captureJevEvidence({ refs: [] });
        } catch (error) {
          reason = error instanceof Error ? error.message : "unknown";
        }
        expect(reason).toBe("jev_transform_unknown");
      } finally {
        await page.cdpClient
          .send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 })
          .catch(() => {});
      }
    } finally {
      await local.teardown();
    }
  },
  30_000,
);
