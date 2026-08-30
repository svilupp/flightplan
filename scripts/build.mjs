#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dist = join(process.cwd(), "dist");
await rm(dist, { recursive: true, force: true });

const tsc = process.platform === "win32" ? "tsc.cmd" : "tsc";
const result = spawnSync(tsc, ["-p", "tsconfig.build.json"], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

async function rewriteDeclarationExtensions(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewriteDeclarationExtensions(path);
    } else if (entry.name.endsWith(".d.ts")) {
      const source = await readFile(path, "utf8");
      const rewritten = source.replaceAll(/\.ts(["'])/g, ".js$1");
      if (rewritten !== source) await writeFile(path, rewritten, "utf8");
    }
  }
}

await rewriteDeclarationExtensions(dist);
await chmod(join(dist, "cli", "index.js"), 0o755);
// Keep stdout clean for `npm pack --json`; npm forwards lifecycle stdout into the pack result.
console.error("Build: OK");
