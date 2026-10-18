import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { renderRecipeFixture } from "../../examples/fixtures/recipes.ts";
import { BrowserPilotDriver } from "./browser-pilot-driver.ts";
import type { ExtractionSpec } from "./extract.ts";

const enabled = process.env.FLIGHTPLAN_RECIPE_BROWSER === "1";
const browserTest = enabled ? test : test.skip;
let server: ReturnType<typeof Bun.serve>;
let driver: BrowserPilotDriver;
beforeAll(async () => {
  if (!enabled) return;
  server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new Response(renderRecipeFixture(new URL(request.url)), {
        headers: { "content-type": "text/html" },
      }),
  });
}, 30000);
beforeEach(async () => {
  if (!enabled) return;
  driver = new BrowserPilotDriver();
  await driver.connect({ mode: "launch", headless: true });
}, 30000);
afterEach(async () => {
  await driver?.teardown();
});
afterAll(async () => {
  await driver?.teardown();
  await server?.stop();
});
const spec: ExtractionSpec = {
  selector: ".product",
  max_rows: 10,
  fields: {
    price: { selector: '[data-testid="price"]', source: "text", type: "number", required: true },
    currency: {
      selector: '[data-testid="currency"]',
      source: "text",
      type: "string",
      required: true,
    },
  },
};
browserTest(
  "real DOM projection reads typed records and fresh reordered values",
  async () => {
    await driver.goto(`http://127.0.0.1:${server.port}/recipes`, { waitForNavigation: false });
    expect(await driver.extract(spec)).toEqual([
      { price: 101, currency: "USD" },
      { price: 205, currency: "USD" },
    ]);
    const candidates = await driver.extractionCandidates(".product");
    expect(candidates.some((candidate) => candidate.selector === '[data-testid="price"]')).toBe(
      true,
    );
    await driver.evaluateExpression("window.__recipeFixture.reorder()");
    expect(await driver.extract(spec)).toEqual([
      { price: 307, currency: "USD" },
      { price: 101, currency: "USD" },
    ]);
    expect((await driver.elementState("#ledger")).text).toBe("0");
  },
  30000,
);
for (const variant of ["missing", "duplicate", "malformed", "nonfinite"])
  browserTest(
    `real DOM rejects ${variant} field`,
    async () => {
      await driver.goto(`http://127.0.0.1:${server.port}/recipes?variant=${variant}`, {
        waitForNavigation: false,
      });
      const failure = await driver.extract(spec).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        variant === "missing"
          ? "required field missing"
          : variant === "duplicate"
            ? "ambiguous"
            : "invalid number",
      );
    },
    30000,
  );
browserTest(
  "real DOM optional fields, row bounds and empty collection",
  async () => {
    await driver.goto(`http://127.0.0.1:${server.port}/recipes?variant=missing`, {
      waitForNavigation: false,
    });
    expect(
      await driver.extract({
        ...spec,
        fields: { ...spec.fields, price: { ...spec.fields.price!, required: false } },
      }),
    ).toEqual([{ currency: "USD" }, { price: 205, currency: "USD" }]);
    const overflow = await driver.extract({ ...spec, max_rows: 1 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((overflow as Error).message).toContain("row limit");
    await driver.goto(`http://127.0.0.1:${server.port}/recipes?variant=empty`, {
      waitForNavigation: false,
    });
    expect(await driver.extract(spec)).toEqual([]);
  },
  30000,
);
browserTest(
  "candidate evidence excludes sensitive descendants and ancestor aggregate text",
  async () => {
    await driver.goto(`http://127.0.0.1:${server.port}/recipes?variant=sensitive`, {
      waitForNavigation: false,
    });
    const candidates = await driver.extractionCandidates(".product");
    const evidence = JSON.stringify(candidates);
    expect(evidence).not.toContain("fixture-secret-canary");
    expect(evidence).not.toContain("fixture-nested-canary");
    expect(candidates.some((candidate) => candidate.selector === ".")).toBe(true);
    expect(candidates.some((candidate) => candidate.selector.includes("token"))).toBe(false);
  },
  30000,
);
browserTest(
  "published recipe runs against real DOM with typed input/output conditions",
  async () => {
    const { launch } = await import("chrome-launcher");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runFlow } = await import("../runner/runner.ts");
    const { resolveConfigWithDefaults } = await import("../config/resolve.ts");
    const chrome = await launch({
      chromeFlags: ["--headless=new", "--no-first-run", "--disable-save-password-bubble"],
    });
    const owner = new BrowserPilotDriver();
    const folder = await mkdtemp(join(tmpdir(), "fp-recipe-browser-run-"));
    const browserURL = `http://127.0.0.1:${chrome.port}`;
    const base = `http://127.0.0.1:${server.port}`;
    try {
      await owner.connect({ mode: "attach", browserURL });
      await owner.goto(`${base}/recipes`, { waitForNavigation: false });
      const config = resolveConfigWithDefaults([
        { connect: { mode: "attach", browserURL, targetUrl: `${base}/recipes` } },
      ]);
      const result = await runFlow({
        flowPath: "examples/flows/recipes/inspect-products.toml",
        out: folder,
        config,
        inputs: { base_url: base, min_price: 100 },
        noLockWrite: true,
        env: {},
      });
      expect(result.summary.verdict).toBe("passed");
      expect(result.summary.outputs).toEqual({
        products: [
          { id: "p1", price: 101, currency: "USD" },
          { id: "p2", price: 205, currency: "USD" },
        ],
      });
      expect((await owner.elementState("#ledger")).text).toBe("0");
    } finally {
      await owner.teardown();
      await chrome.kill();
      await rm(folder, { recursive: true, force: true });
    }
  },
  30000,
);
