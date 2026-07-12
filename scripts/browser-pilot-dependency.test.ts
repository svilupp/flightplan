import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundaryConsumerJavaScript,
  boundaryConsumerTypeScript,
  checkApiCompatibility,
  classifyDependencyPath,
  linkBrowserPilot,
  packageContentHash,
  sourceConfigFromPackage,
} from "./browser-pilot-dependency.ts";

async function withTemp<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "flightplan-fp07-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("FP-07 browser-pilot dependency guard", () => {
  test("resolves only local file dependencies for the link workflow", () => {
    expect(
      sourceConfigFromPackage(
        { dependencies: { "browser-pilot": "file:../browser-pilot" } },
        "/workspace/flightplan",
      ),
    ).toEqual({
      dependencySpec: "file:../browser-pilot",
      sourceRoot: "/workspace/browser-pilot",
    });
    expect(
      sourceConfigFromPackage(
        { dependencies: { "browser-pilot": "0.1.0" } },
        "/workspace/flightplan",
      ),
    ).toEqual({ dependencySpec: "0.1.0" });
  });

  test("dist/package hash changes when copied package content changes", async () => {
    await withTemp(async (root) => {
      const packageRoot = join(root, "browser-pilot");
      await mkdir(join(packageRoot, "dist"), { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        '{"name":"browser-pilot","version":"0.1.0"}\n',
      );
      await writeFile(
        join(packageRoot, "dist", "index.d.ts"),
        "export declare const version: string;\n",
      );
      const before = await packageContentHash(packageRoot);
      await writeFile(
        join(packageRoot, "dist", "index.d.ts"),
        "export declare const version: number;\n",
      );
      const after = await packageContentHash(packageRoot);
      expect(after).not.toBe(before);
    });
  });

  test("classifies copied directories and real symlinks separately", async () => {
    await withTemp(async (root) => {
      const copy = join(root, "copy");
      const link = join(root, "link");
      await mkdir(copy);
      await symlink(copy, link, "dir");
      expect(await classifyDependencyPath(copy)).toBe("copy");
      expect(await classifyDependencyPath(link)).toBe("symlink");
    });
  });

  test("preserves an existing copied package before linking the local source", async () => {
    await withTemp(async (root) => {
      const sourceRoot = join(root, "browser-pilot");
      const flightplanRoot = join(root, "flightplan");
      const installedRoot = join(flightplanRoot, "node_modules", "browser-pilot");
      await mkdir(join(sourceRoot, "dist"), { recursive: true });
      await mkdir(installedRoot, { recursive: true });
      await writeFile(
        join(sourceRoot, "package.json"),
        '{"name":"browser-pilot","version":"0.1.0","files":["dist"]}\n',
      );
      await writeFile(join(sourceRoot, "dist", "index.d.ts"), "export {};\n");
      await writeFile(join(installedRoot, "copied-marker.txt"), "preserve me\n");
      await writeFile(
        join(flightplanRoot, "package.json"),
        JSON.stringify({ dependencies: { "browser-pilot": `file:${sourceRoot}` } }),
      );

      await linkBrowserPilot(flightplanRoot);

      expect(await classifyDependencyPath(installedRoot)).toBe("symlink");
      const entries = await readdir(join(flightplanRoot, "node_modules"));
      const backup = entries.find((entry) => entry.startsWith(".flightplan-browser-pilot-copy-"));
      expect(backup).toBeDefined();
      expect(
        await Bun.file(join(flightplanRoot, "node_modules", backup!, "copied-marker.txt")).text(),
      ).toBe("preserve me\n");
    });
  });

  test("checks every packed boundary contract and reports missing markers", async () => {
    await withTemp(async (root) => {
      const packageRoot = join(root, "browser-pilot");
      await mkdir(join(packageRoot, "dist"), { recursive: true });
      await writeFile(
        join(packageRoot, "dist", "index.d.ts"),
        [
          "dispatchState retrySafe matchedConditions navigationObserved waitUntil",
          "TargetNotFoundError targetUrl fallbackToBestTarget",
          "waitForReady ReadinessDiagnostics detached recoverStaleRef",
          "listTargets newPage targetId",
        ].join("\n"),
      );
      const compatible = await checkApiCompatibility(packageRoot);
      expect(compatible.ok).toBe(true);
      await writeFile(
        join(packageRoot, "dist", "index.d.ts"),
        "export declare const retrySafe: boolean;\n",
      );
      const incompatible = await checkApiCompatibility(packageRoot);
      expect(incompatible.ok).toBe(false);
      expect(incompatible.checks.filter((check) => !check.ok).length).toBeGreaterThan(0);
    });
  });

  test("packed consumer exercises metadata, readiness, detached refs, targets, and popup contracts", () => {
    const types = boundaryConsumerTypeScript();
    const runtime = boundaryConsumerJavaScript();
    expect(types).toContain('StepResult["dispatchState"]');
    expect(types).toContain('PageType["waitForReady"]');
    expect(types).toContain('"detached"');
    expect(runtime).toContain("explicit target failure fell back to another target");
    expect(runtime).toContain('method === "Target.setDiscoverTargets"');
    expect(runtime).toContain("Page.waitForReady");
    expect(runtime).toContain("recoverStaleRef");
  });
});
