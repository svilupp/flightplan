#!/usr/bin/env node
// Test the actual release tarball; optionally substitute a packed browser-pilot candidate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length > 3)
  throw new Error("Usage: node scripts/package-smoke.mjs [browser-pilot.tgz]");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidate = process.argv[2] ? resolve(process.argv[2]) : undefined;
const temp = mkdtempSync(join(tmpdir(), "flightplan-package-smoke-"));
let passed = false;
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", temp], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const modules = join(temp, "node_modules");
  const flightplan = join(modules, "@svilupp", "flightplan");
  mkdirSync(flightplan, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    join(temp, packed[0].filename),
    "--strip-components=1",
    "-C",
    flightplan,
  ]);
  // Reuse the installed dependency graph without installing anything or changing this checkout.
  for (const entry of readdirSync(join(root, "node_modules"))) {
    if (entry === "@svilupp" || entry === "just-bash" || (candidate && entry === "browser-pilot"))
      continue;
    symlinkSync(join(root, "node_modules", entry), join(modules, entry), "junction");
  }
  if (candidate) {
    const browserPilot = join(modules, "browser-pilot");
    mkdirSync(browserPilot);
    execFileSync("tar", ["-xzf", candidate, "--strip-components=1", "-C", browserPilot]);
  }
  const bpManifest = JSON.parse(
    readFileSync(join(modules, "browser-pilot", "package.json"), "utf8"),
  );
  assert.equal(bpManifest.name, "browser-pilot");
  const manifest = JSON.parse(readFileSync(join(flightplan, "package.json"), "utf8"));
  assert.equal(
    execFileSync(process.execPath, [join(flightplan, "dist/cli/index.js"), "--version"], {
      encoding: "utf8",
    }).trim(),
    manifest.version,
  );

  writeFileSync(
    join(temp, "consumer.mts"),
    `
import type { FileSystemPort, RunOptions } from "@svilupp/flightplan";
const fs: FileSystemPort = {
  async readTextFile() { return ""; }, async writeTextFile() {}, async appendTextFile() {},
  async fileExists() { return false; }, async mkdir() {}, async writeBinaryFile(_path, bytes) {
    const data: Uint8Array = bytes; void data;
  },
  async readDir() { return []; }, async stat() { return null; },
};
import { runFlightplan, type FlightplanShellContext } from "@svilupp/flightplan/shell";
const context: FlightplanShellContext = { fs, cwd: "/virtual" };
void runFlightplan(["lint", "flow.toml"], context);
const options: Pick<RunOptions, "fs" | "signal" | "timeoutMs"> = { fs, signal: new AbortController().signal, timeoutMs: 1000 };
void options;
`,
  );
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--skipLibCheck",
      "--strict",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      "--types",
      "node",
      join(temp, "consumer.mts"),
    ],
    { cwd: temp, stdio: "inherit" },
  );
  copyFileSync(join(root, "scripts/package-consumer-smoke.mjs"), join(temp, "consumer.mjs"));
  assert.ok(manifest.exports?.["./shell"]);
  assert.equal(manifest.peerDependencies?.["just-bash"], undefined);
  execFileSync(process.execPath, [join(temp, "consumer.mjs"), bpManifest.version], {
    cwd: temp,
    stdio: "inherit",
  });
  console.log(
    `Package smoke: Flightplan ${manifest.version} + browser-pilot ${bpManifest.version}: OK`,
  );
  passed = true;
} finally {
  if (passed) rmSync(temp, { recursive: true, force: true });
  else console.error(`Package smoke evidence retained at ${temp}`);
}
