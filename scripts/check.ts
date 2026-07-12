#!/usr/bin/env bun
/**
 * Quiet check runner — success is silence, the Unix way.
 *
 * Each leg runs with NO output on success and prints a one-line "<Label>: OK".
 * On failure it prints "<Label>: FAIL" followed by the tool's combined
 * stdout+stderr, then exits non-zero.
 *
 *   bun run scripts/check.ts                 # run every leg
 *   bun run scripts/check.ts lint            # run a single leg
 *   bun run scripts/check.ts lint typecheck  # run a subset
 *
 * Every requested leg runs even if an earlier one fails, so one command
 * surfaces all failures at once. Set NO_COLOR=1 (or pipe to a non-TTY) to
 * disable ANSI colors.
 */
import { spawnSync } from "node:child_process";

const NO_COLOR = process.env.NO_COLOR != null || !process.stdout.isTTY;
const paint = (code: string, s: string) => (NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`);
const green = (s: string) => paint("32", s);
const red = (s: string) => paint("31", s);
const bold = (s: string) => paint("1", s);

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

// Tool binaries live in node_modules/.bin; put it on PATH so the `sh -c`
// subshell resolves them the way `bun run` would.
const PATH = `${process.cwd()}/node_modules/.bin:${process.env.PATH ?? ""}`;
const pad = Math.max(...legs.map((l) => l.label.length)) + 1;

let failed = false;
for (const leg of legs) {
  const r = spawnSync("sh", ["-c", leg.cmd], {
    env: { ...process.env, PATH },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = `${leg.label}:`.padEnd(pad);
  if (r.status === 0) {
    console.log(`  ${green(`${tag} OK`)}`);
  } else {
    failed = true;
    console.log(`  ${red(`${tag} FAIL`)}`);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd();
    if (out) console.log(out);
    if (r.error) console.log(String(r.error.message ?? r.error));
  }
}

if (failed) process.exit(1);
if (legs.length > 1) console.log(green(bold("All checks passed.")));
