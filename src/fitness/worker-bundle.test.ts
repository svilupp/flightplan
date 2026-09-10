// Worker bundle gate (workers-slice-2 §7.3).
//
// Cheap proxy for "does this actually bundle for workerd" without a real workerd/miniflare smoke
// (deferred per §7.3): `Bun.build({ target: "browser" })` on `src/worker.ts` must succeed, and
// the emitted output must contain no static `node:*` import, `chrome-launcher`, or `@ai-sdk/*`
// reference. Size is reported and bounded generously (3 MB) so a runaway transitive dependency
// (e.g. an accidental static AI-SDK pull-in that the string checks miss) is still caught.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "..");
const SIZE_CEILING_BYTES = 3 * 1024 * 1024;

describe("worker bundle gate", () => {
  test("Bun.build({ target: 'browser' }) of src/worker.ts succeeds and stays node/AI-SDK-free", async () => {
    if (typeof Bun === "undefined" || typeof Bun.build !== "function") {
      console.warn("worker-bundle gate: Bun.build unavailable in this runtime — skipping.");
      return;
    }

    const outDir = await mkdtemp(join(tmpdir(), "flightplan-worker-bundle-"));
    try {
      const result = await Bun.build({
        entrypoints: [resolve(SRC_ROOT, "worker.ts")],
        target: "browser",
        outdir: outDir,
        format: "esm",
      });

      if (!result.success) {
        const messages = result.logs.map((l) => l.message).join("\n");
        throw new Error(`Bun.build failed for src/worker.ts (target: browser):\n${messages}`);
      }
      expect(result.outputs.length).toBeGreaterThan(0);

      let totalBytes = 0;
      const findings: Array<{ file: string; reason: string }> = [];
      for (const output of result.outputs) {
        const bytes = await readFile(output.path);
        totalBytes += bytes.byteLength;
        const text = bytes.toString("utf8");
        // Only STATIC `import ... from "spec"` / bare `import "spec"` forms count — the lazy
        // computed-specifier dynamic imports for chrome-launcher (`browser-pilot-driver.ts`) and
        // the AI SDKs (`ai/default-generate.ts`) are the documented escape hatch (workers-slice-2
        // §2.8/§4): their specifier strings legitimately survive into the bundle as inert data
        // (`const spec = "chrome-launcher"; import(spec)`), never as a resolved static import.
        if (/(?:^|\n)\s*import(?:\s+type)?[^;\n]*from\s*["']node:[^"']+["']/.test(text)) {
          findings.push({ file: output.path, reason: "static node:* import in bundle output" });
        }
        if (/(?:^|\n)\s*import[^;\n]*from\s*["']chrome-launcher["']/.test(text)) {
          findings.push({
            file: output.path,
            reason: "static chrome-launcher import in bundle output",
          });
        }
        if (
          /(?:^|\n)\s*import[^;\n]*from\s*["']@ai-sdk\/[^"']+["']/.test(text) ||
          /(?:^|\n)\s*import[^;\n]*from\s*["']@openrouter\/ai-sdk-provider["']/.test(text)
        ) {
          findings.push({ file: output.path, reason: "static AI SDK import in bundle output" });
        }
      }

      expect(findings).toEqual([]);
      console.log(
        `worker-bundle gate: src/worker.ts bundled for browser target — ${result.outputs.length} output file(s), ${(totalBytes / 1024).toFixed(1)} KiB total.`,
      );
      expect(totalBytes).toBeLessThan(SIZE_CEILING_BYTES);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
