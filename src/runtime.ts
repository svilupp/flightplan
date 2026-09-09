// Small Node-compatible runtime helpers shared by the public package.
//
// Flightplan's test suite may run under Bun, but the published CLI and library are also
// supported under Node. Keep filesystem, hashing, and glob operations on standard Node APIs.

import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { access, appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * The filesystem operations the run path (artifacts, locks, flow/import loading) needs.
 * Injectable so `runFlow` can execute somewhere with no `node:fs` (e.g. Cloudflare Workers)
 * by supplying an in-memory or KV-backed implementation via `RunOptions.fs`. The default
 * ({@link nodeFileSystem}) is the real Node implementation used when no port is supplied, so
 * default behavior is byte-for-byte unchanged.
 */
export interface FileSystemPort {
  /** Read a UTF-8 text file. Rejects if the file does not exist. */
  readTextFile(path: string): Promise<string>;
  /** Write a UTF-8 text file, creating parent directories as needed. Overwrites. */
  writeTextFile(path: string, text: string): Promise<void>;
  /** Append a UTF-8 chunk to a file, creating it (and parent directories) if missing. */
  appendTextFile(path: string, text: string): Promise<void>;
  /** True iff a file/dir exists at `path`. */
  fileExists(path: string): Promise<boolean>;
  /** Create a directory. `recursive` mirrors `fs.mkdir`'s option (no-op if it already exists). */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
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
  async fileExists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await mkdir(path, options);
  },
};

export async function readTextFile(path: string): Promise<string> {
  return nodeFileSystem.readTextFile(path);
}

export async function fileExists(path: string): Promise<boolean> {
  return nodeFileSystem.fileExists(path);
}

export async function writeTextFile(path: string, text: string): Promise<void> {
  return nodeFileSystem.writeTextFile(path, text);
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function globRegex(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let source = "^";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!;
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        i++;
        if (normalized[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const end = normalized.indexOf("]", i + 1);
      if (end > i + 1) {
        source += `[${normalized.slice(i + 1, end).replaceAll("\\", "\\\\")}]`;
        i = end;
      } else {
        source += "\\[";
      }
    } else {
      source += /[\\^$+{}().|]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`${source}$`);
}

function globRoot(pattern: string): string {
  const firstMagic = pattern.search(/[*!?[]/);
  if (firstMagic < 0) return dirname(pattern);
  const prefix = pattern.slice(0, firstMagic);
  const slash = prefix.lastIndexOf("/");
  return slash >= 0 ? prefix.slice(0, slash) || "/" : ".";
}

async function walkFiles(root: string, recursive: boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isFile()) files.push(path);
      else if (recursive && entry.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  return files;
}

/** Expand a Bun.Glob-compatible path using only Node standard-library APIs. */
export async function expandGlob(raw: string, cwd = process.cwd()): Promise<string[]> {
  const pattern = normalizePath(isAbsolute(raw) ? raw : resolve(cwd, raw));
  const files = await walkFiles(resolve(globRoot(pattern)), pattern.includes("**"));
  const regex = globRegex(pattern);
  return files.filter((file) => regex.test(normalizePath(file))).sort((a, b) => a.localeCompare(b));
}

/** Expand immediate TOML children of a directory, matching Bun.Glob("*.toml"). */
export async function listTomlFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(".toml") && !entry.name.endsWith(".lock.toml"),
    )
    .map((entry) => resolve(directory, entry.name))
    .sort((a, b) => a.localeCompare(b));
}
