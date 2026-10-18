import { expect, test } from "bun:test";
import { memoryFileSystem } from "../adapters/memory.ts";
import { MockDriver } from "../driver/index.ts";
import { lintText } from "../lint/lint.ts";
import { checkFlow } from "./check.ts";

const header = 'version=1\nkind="flow"\nid="check"\ndescription="check"\n';
test("check inspects current target and leaves later states unchecked without mutations", async () => {
  const fs = memoryFileSystem();
  await fs.writeTextFile(
    "/flow.toml",
    header +
      '[[steps]]\nid="open"\ndo="click"\ntarget="[data-testid=\'open\']"\neffect="idempotent"\n[[steps]]\nid="later"\ndo="click"\ntarget="[data-testid=\'later\']"\neffect="idempotent"',
  );
  const driver = new MockDriver().setElementState({
    exists: true,
    visible: true,
    count: 3,
    text: "Open",
    value: null,
    boundingBox: null,
  });
  const report = await checkFlow({ flowPath: "/flow.toml", fs, driver, env: {} });
  expect(report.items.find((item) => item.code === "TARGET_AMBIGUOUS")?.evidence).toEqual({
    matches: 3,
  });
  expect(report.items.find((item) => item.step === "later")?.status).toBe("unchecked");
  expect(driver.callsTo("batch")).toHaveLength(0);
  expect(driver.callsTo("click")).toHaveLength(0);
  expect(driver.callsTo("goto")).toHaveLength(0);
  expect(driver.callsTo("evalInFrame")).toHaveLength(0);
});
test("lint aggregates independent imports, capture ordering, schema and condition timing", async () => {
  const fs = memoryFileSystem();
  const source =
    header +
    'imports="./missing.toml"\n[[before]]\ntype="url"\nurl="https://example.com"\nwhen="after"\n[[steps]]\nid="fill"\ndo="fill"\nvalue="${capture.later}"\ntarget="field"\nmisspelled=true\n[[steps.capture]]\nname="later"\ntype="text"';
  const result = await lintText(source, "/flow.toml", { fs });
  expect(result.diagnostics.map((item) => item.ruleId)).toContain("imports/resolves");
  expect(result.diagnostics.map((item) => item.ruleId)).toContain("capture/before-definition");
  expect(
    result.diagnostics.filter((item) => item.ruleId === "schema/invalid").length,
  ).toBeGreaterThanOrEqual(2);
  expect(result.diagnostics.every((item) => typeof item.code === "string")).toBe(true);
});
test("misspelled keys carry stable codes, safe suggestions and physical key positions", async () => {
  const fs = memoryFileSystem();
  const result = await lintText(
    header + '[[steps]]\nid="open"\ndo="click"\ntargte="Open order"',
    "/flow.toml",
    { fs },
  );
  const typo = result.diagnostics.find((item) => item.code === "SCHEMA_UNKNOWN_KEY");
  expect(typo?.sourceRange).toEqual({ line: 8, column: 1 });
  expect(typo?.suggestions).toEqual(["Use target if that is the intended field."]);
  expect(typo?.rootCauseId).toBe("steps[0].targte");
});
