#!/usr/bin/env bun

import { chmod, rm } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
await rm(dist, { recursive: true, force: true });

async function build(entrypoint: string, filename: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    format: "esm",
    outdir: "dist",
    naming: filename,
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

await build("src/index.ts", "index.js");
await build("src/cli/index.ts", "flightplan.js");
await chmod("dist/flightplan.js", 0o755);

console.log("Build: OK");
