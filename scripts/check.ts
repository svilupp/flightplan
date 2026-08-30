#!/usr/bin/env bun
/**
 * Check runner. Each leg delegates output handling to scripts/run-quiet, which
 * keeps a complete per-leg log and prints a bounded status block. Every
 * requested leg runs even if an earlier one fails, so one command surfaces all
 * failures at once.
 *
 *   bun run scripts/check.ts                 # run every leg
 *   bun run scripts/check.ts lint            # run a single leg
 *   bun run scripts/check.ts lint typecheck  # run a subset
 *
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

type Leg = { name: string; label: string; cmd: string };

// One shell command per leg. `lint` runs Biome (format + lint) then oxlint with
// its type-aware pass (tsgolint); `typecheck` is `tsc --noEmit`; `test` is Bun.
const LEGS: Leg[] = [
  { name: "lint", label: "Lint", cmd: "biome check . && oxlint --type-aware" },
  { name: "typecheck", label: "Typecheck", cmd: "tsc --noEmit" },
  { name: "test", label: "Tests", cmd: "bun test" },
];

const requested = process.argv.slice(2);
const legs: Leg[] = requested.length
  ? requested.map((n) => {
      const leg = LEGS.find((l) => l.name === n);
      if (!leg) {
        console.error(`unknown check: ${n} (known: ${LEGS.map((l) => l.name).join(", ")})`);
        process.exit(2);
      }
      return leg;
    })
  : LEGS;

// Tool binaries live in node_modules/.bin; put it on PATH so each `sh -c`
// subshell resolves them the way `bun run` would.
const PATH = `${process.cwd()}/node_modules/.bin:${process.env.PATH ?? ""}`;
const RUN_QUIET = join(import.meta.dir, "run-quiet");

let failed = false;
for (const leg of legs) {
  const r = spawnSync("sh", [RUN_QUIET, leg.label, "--", "sh", "-c", leg.cmd], {
    env: { ...process.env, PATH },
    stdio: "inherit",
  });
  if (r.status !== 0 || r.error) {
    failed = true;
    if (r.error) console.error(`${leg.label}: could not start run-quiet: ${r.error.message}`);
  }
}

if (failed) process.exit(1);
