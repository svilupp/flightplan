import { expect, test } from "bun:test";
import { createRedactor } from "../redaction/index.ts";
import { BrowserPilotDriver } from "./browser-pilot-driver.ts";

function setup(
  options: {
    unsafe?: boolean;
    secret?: string;
    moving?: boolean;
    iframe?: boolean;
    width?: number;
  } = {},
) {
  const driver = new BrowserPilotDriver();
  let observations = 0;
  let screenshots = 0;
  let backendNodeId = 1;
  let structure = "<button>safe</button>";
  const width = options.width ?? 800;
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, 600);
  const page = {
    targetId: "main",
    getCurrentFrame: () => (options.iframe ? "child" : null),
    evaluate: async () => ({
      url: "https://fixture.test",
      width: 800,
      height: 600,
      scrollX: 0,
      scrollY: 0,
      dpr: 1,
      visualScale: 1,
      unsafe: options.unsafe ?? false,
      content: options.secret ?? "safe fixture",
      structure,
      layout: options.moving ? String(observations++) : "stable",
    }),
    exportRefMap: () => ({ e1: backendNodeId }),
    cdpClient: {
      send: async (method: string) =>
        method === "DOM.resolveNode"
          ? { object: { objectId: "object" } }
          : method === "Runtime.callFunctionOn"
            ? { result: { value: { x: 10, y: 20, width: 40, height: 30 } } }
            : {},
    },
    screenshot: async () => {
      screenshots++;
      return btoa(String.fromCharCode(...bytes));
    },
  };
  Object.assign(driver, { activePage: page });
  return {
    driver,
    screenshots: () => screenshots,
    replace: () => {
      backendNodeId++;
    },
    alterSvg: () => {
      structure = "<svg><path d=changed></svg>";
    },
  };
}
test("verified DOM-only capture reads actual PNG dimensions and retains physical refs", async () => {
  const { driver } = setup();
  const result = await driver.captureJevEvidence({ refs: ["e1"] });
  expect(result.geometry.e1).toEqual({ x: 10, y: 20, width: 40, height: 30 });
  expect(result.image.width).toBe(800);
  expect(result.pixelsSafe).toBe(true);
});
test("opaque content, earlier known secrets, and sensitive visible text prevent capture", async () => {
  for (const options of [{ unsafe: true }, { secret: "Bearer token12345" }]) {
    const { driver, screenshots } = setup(options);
    await expect(driver.captureJevEvidence({ refs: [] })).rejects.toThrow("jev_pixels_unsafe");
    expect(screenshots()).toBe(0);
  }
  const { driver, screenshots } = setup();
  await expect(
    driver.captureJevEvidence({
      refs: [],
      redactor: createRedactor({ maskText: true, secrets: ["earlier-secret"] }),
    }),
  ).rejects.toThrow("jev_pixels_unsafe");
  expect(screenshots()).toBe(0);
});
test("layout motion and screenshot scale mismatch fail closed", async () => {
  await expect(setup({ moving: true }).driver.captureJevEvidence({ refs: ["e1"] })).rejects.toThrow(
    "jev_snapshot_stale",
  );
  await expect(setup({ width: 400 }).driver.captureJevEvidence({ refs: ["e1"] })).rejects.toThrow(
    "jev_transform_unknown",
  );
  await expect(setup({ iframe: true }).driver.captureJevEvidence({ refs: [] })).rejects.toThrow(
    "jev_transform_unknown",
  );
});

test("same-geometry replacement and pixel-only structural changes invalidate evidence", async () => {
  for (const change of ["replace", "alterSvg"] as const) {
    const fixture = setup();
    const evidence = await fixture.driver.captureJevEvidence({ refs: ["e1"] });
    expect(await fixture.driver.validateJevEvidence(evidence)).toBe(true);
    fixture[change]();
    expect(await fixture.driver.validateJevEvidence(evidence)).toBe(false);
  }
});
