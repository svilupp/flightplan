// Run while the candidate BP tarball is installed; no manifest or lock edits.

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(root, "node_modules/.fp-owner-contract-"));
try {
  const source = join(directory, "consumer.ts");
  await writeFile(
    source,
    `
import type { NamedSessionBorrow as BpLease, BorrowedOwnerActions as BpStrict } from 'browser-pilot/adapters/node';
import type { OwnerActionPort as BpPort } from 'browser-pilot/core';
import type { NamedSessionBorrow as FpLease } from '../../src/driver/named-session.ts';
import type { BorrowedOwnerActions as FpStrict } from '../../src/driver/native-owner-actions.ts';
import type { OwnerActionPort as FpPort } from '../../src/driver/owner-contract.ts';
type Expect<T extends true> = T;
type NamedCompatibility = Expect<BpLease extends FpLease ? true : false>;
type StrictCompatibility = Expect<BpStrict extends FpStrict ? true : false>;
type PortCompatibility = Expect<BpPort extends FpPort ? true : false>;
`,
  );
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "preserve",
      "--moduleResolution",
      "bundler",
      "--target",
      "es2022",
      "--allowImportingTsExtensions",
      source,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(
      `Packed BP public type compatibility failed\n${result.stdout}\n${result.stderr}`,
    );
  console.log("Packed BP named/strict public type compatibility: PASS");
} finally {
  await rm(directory, { recursive: true, force: true });
}
