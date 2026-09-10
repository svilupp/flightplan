// Flightplan — the real Node `node:fs`-backed `FileSystemPort`.
//
// Every static `node:fs`/`node:fs/promises`/`node:path` import in the run path lives HERE and
// nowhere else. Portable modules (`src/runtime.ts`, `src/artifacts/*`, `src/flow/*`,
// `src/lock/*`, `src/runner/*`, `src/lint/*`) never import this module statically — they reach
// it only through `src/fs-default.ts`'s cached computed-specifier dynamic import, so it never
// appears in the worker-legal graph. The root barrel (`src/index.ts`) is allowed to import it
// statically (the root is Node-flavored by design).

import { constants } from "node:fs";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { FileSystemPort } from "../../runtime.ts";

/**
 * True for errors that mean "nothing exists at this path": ENOENT (missing entry) and ENOTDIR
 * (a path component is a file, so the full path cannot exist). Matches Node's `existsSync`,
 * which reports `false` for both — and the pre-port `fileExists`, whose catch-all returned
 * `false`. Real I/O faults (EACCES, EIO, …) still throw.
 */
function isMissingEntryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** The real Node `node:fs`-backed {@link FileSystemPort}. The default when no port is injected. */
export const nodeFileSystem: FileSystemPort = {
  async readTextFile(path: string): Promise<string> {
    return readFile(path, "utf8");
  },
  async writeTextFile(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
  },
  async appendTextFile(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, text, "utf8");
  },
  async writeBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  },
  async fileExists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch (error) {
      if (isMissingEntryError(error)) return false;
      throw error;
    }
  },
  async mkdir(path: string): Promise<void> {
    // Always recursive/idempotent per the `FileSystemPort` contract (`runtime.ts`), regardless
    // of any caller-supplied `options.recursive` — matches the in-memory adapter's semantics.
    await mkdir(path, { recursive: true });
  },
  async readDir(
    path: string,
  ): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }));
  },
  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean } | null> {
    try {
      const info = await stat(path);
      return { isFile: info.isFile(), isDirectory: info.isDirectory() };
    } catch (error) {
      if (isMissingEntryError(error)) return null;
      throw error;
    }
  },
  async lstat(
    path: string,
  ): Promise<{ isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean } | null> {
    try {
      const info = await lstat(path);
      return {
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        isSymbolicLink: info.isSymbolicLink(),
      };
    } catch (error) {
      if (isMissingEntryError(error)) return null;
      throw error;
    }
  },
};
