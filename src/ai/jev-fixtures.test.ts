import { expect, test } from "bun:test";
import { JEV_ROUTES, renderJevFixture } from "../../examples/fixtures/jev.ts";
import { jevOracle } from "../../examples/fixtures/jev-oracles.ts";

test("all thirteen fixtures are deterministic and keep oracle module separate", () => {
  expect(JEV_ROUTES).toHaveLength(13);
  for (const route of JEV_ROUTES) {
    const url = new URL(`http://localhost/jev/${route}`);
    const page = renderJevFixture(url)!;
    expect(page).toBe(renderJevFixture(url)!);
    expect(page).toContain("window.__jevFixture");
    expect(page).not.toContain("jevOracle");
    expect(jevOracle(route).dispatches).toBeLessThanOrEqual(1);
  }
});
