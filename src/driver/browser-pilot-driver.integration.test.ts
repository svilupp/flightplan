import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BrowserPilotDriver } from "./browser-pilot-driver.ts";

const runIntegration = process.env.FLIGHTPLAN_BROWSER_INTEGRATION === "1";
const integrationTest = runIntegration ? test : test.skip;

const PAGE = `<!doctype html>
<html><body>
  <button data-testid="async-load" onclick="document.body.insertAdjacentHTML('beforeend', '<p data-testid=result>clicked</p>')">Load data</button>
</body></html>`;

let server: ReturnType<typeof Bun.serve> | undefined;
let driver: BrowserPilotDriver | undefined;

describe("BrowserPilotDriver background automation page", () => {
  beforeAll(async () => {
    if (!runIntegration) return;

    server = Bun.serve({
      port: 0,
      fetch: () => new Response(PAGE, { headers: { "Content-Type": "text/html" } }),
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

  integrationTest(
    "clicks a CSS-resolved button and observes its DOM side effect",
    async () => {
      const active = driver!;
      await active.goto(`http://127.0.0.1:${server!.port}/async`);

      const result = await active.batch(
        [{ action: "click", selector: "[data-testid='async-load']", waitForNavigation: false }],
        { timeout: 5_000 },
      );
      expect(result.steps[0]?.success).toBe(true);
      expect((await active.elementState("[data-testid='result']")).text).toBe("clicked");
    },
    30_000,
  );
});
