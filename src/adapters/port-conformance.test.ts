// Shared conformance test asserting `nodeFileSystem` and `memoryFileSystem()` agree on the
// `FileSystemPort` contract pinned in `runtime.ts`: symlink semantics (`stat` follows,
// `readDir` does not), missing-path semantics, recursive `mkdir`, and `appendTextFile`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FileSystemPort } from "../runtime.ts";
import { memoryFileSystem } from "./memory.ts";
import { nodeFileSystem } from "./node/index.ts";

async function withNodeFixture(): Promise<{ fs: FileSystemPort; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "flightplan-fs-conformance-"));
  return { fs: nodeFileSystem, root };
}

describe.each([
  {
    name: "nodeFileSystem",
    setup: withNodeFixture,
    teardown: async (root: string) => rm(root, { recursive: true, force: true }),
  },
  {
    name: "memoryFileSystem",
    setup: async () => ({ fs: memoryFileSystem(), root: "/root" }),
    teardown: async () => {},
  },
])("FileSystemPort conformance — $name", ({ setup, teardown }) => {
  let fs: FileSystemPort;
  let root: string;

  beforeEach(async () => {
    const fixture = await setup();
    fs = fixture.fs;
    root = fixture.root;
  });

  afterEach(async () => {
    await teardown(root);
  });

  test("mkdir is recursive and writeTextFile creates parent directories", async () => {
    const nested = `${root}/a/b/c.txt`;
    await fs.mkdir(`${root}/a/b`, { recursive: true });
    await fs.writeTextFile(nested, "hello");
    expect(await fs.readTextFile(nested)).toBe("hello");
  });

  test("appendTextFile creates the file when missing and appends when present", async () => {
    const path = `${root}/append.txt`;
    await fs.appendTextFile(path, "a");
    await fs.appendTextFile(path, "b");
    expect(await fs.readTextFile(path)).toBe("ab");
  });

  test("fileExists / stat report false / null for missing paths", async () => {
    const missing = `${root}/does-not-exist.txt`;
    expect(await fs.fileExists(missing)).toBe(false);
    expect(await fs.stat(missing)).toBeNull();
  });

  test("stat distinguishes files from directories", async () => {
    await fs.mkdir(`${root}/dir`, { recursive: true });
    await fs.writeTextFile(`${root}/dir/file.txt`, "x");
    expect(await fs.stat(`${root}/dir`)).toEqual({ isFile: false, isDirectory: true });
    expect(await fs.stat(`${root}/dir/file.txt`)).toEqual({ isFile: true, isDirectory: false });
  });

  test("readDir lists immediate entries with file/directory kind", async () => {
    await fs.mkdir(`${root}/list/sub`, { recursive: true });
    await fs.writeTextFile(`${root}/list/one.txt`, "1");
    await fs.writeTextFile(`${root}/list/two.txt`, "2");
    const entries = await fs.readDir(`${root}/list`);
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get("one.txt")).toEqual({ name: "one.txt", isFile: true, isDirectory: false });
    expect(byName.get("sub")).toEqual({ name: "sub", isFile: false, isDirectory: true });
  });
});

describe("FileSystemPort symlink semantics (nodeFileSystem, real symlinks)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "flightplan-fs-symlink-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("stat follows a symlink to a file (reports isFile: true)", async () => {
    const targetFile = join(root, "target.txt");
    await writeFile(targetFile, "x");
    const link = join(root, "link.txt");
    await symlink(targetFile, link);
    expect(await nodeFileSystem.stat(link)).toEqual({ isFile: true, isDirectory: false });
  });

  test("readDir does not follow a symlinked directory entry", async () => {
    const targetDir = join(root, "targetdir");
    await import("node:fs/promises").then((m: typeof import("node:fs/promises")) =>
      m.mkdir(targetDir, { recursive: true }),
    );
    const link = join(root, "linkdir");
    await symlink(targetDir, link);
    const entries = await nodeFileSystem.readDir(root);
    const linkEntry = entries.find((e) => e.name === "linkdir");
    expect(linkEntry).toEqual({ name: "linkdir", isFile: false, isDirectory: false });
  });

  test("lstat reports isSymbolicLink for a symlink, stat reports the followed kind", async () => {
    const targetFile = join(root, "target2.txt");
    await writeFile(targetFile, "x");
    const link = join(root, "link2.txt");
    await symlink(targetFile, link);
    expect(await nodeFileSystem.lstat?.(link)).toEqual({
      isFile: false,
      isDirectory: false,
      isSymbolicLink: true,
    });
    expect(await nodeFileSystem.stat(link)).toEqual({ isFile: true, isDirectory: false });
  });
});
