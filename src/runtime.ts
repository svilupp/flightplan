// Portable runtime helpers shared by the public package.
//
// This module is on the `runFlow`/`lintText` static run path: it must never import `node:*`,
// `bun:*`, or read ambient globals unguarded. The real Node filesystem implementation lives in
// `src/adapters/node/index.ts`; hosts without Node reach it (or don't) via
// `src/fs-default.ts`'s cached computed-specifier dynamic import.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { dirname, isAbsolute, resolve } from "./paths.ts";

/**
 * The filesystem operations the run path (artifacts, locks, flow/import loading) needs.
 * Injectable so `runFlow` can execute somewhere with no `node:fs` (e.g. Cloudflare Workers)
 * by supplying an in-memory or KV-backed implementation via `RunOptions.fs`. The default is
 * `nodeFileSystem` (`src/adapters/node/index.ts`), resolved lazily via `src/fs-default.ts` when
 * no port is supplied, so default behavior is byte-for-byte unchanged.
 *
 * Paths use the host's filesystem syntax. Adapters own authorization, traversal/symlink
 * checks, and atomic commit rules; only a missing entry should make fileExists return false.
 * Writes resolve when committed. Stopping a caller's wait cannot undo a dispatched write.
 */
export interface FileSystemPort {
  /** Read a UTF-8 text file. Rejects if the file does not exist. */
  readTextFile(path: string): Promise<string>;
  /** Write a UTF-8 text file, creating parent directories as needed. Overwrites. */
  writeTextFile(path: string, text: string): Promise<void>;
  /** Append a UTF-8 chunk to a file, creating it (and parent directories) if missing. */
  appendTextFile(path: string, text: string): Promise<void>;
  /** Optional binary artifact support. Required for recording with RunOptions.fs. */
  writeBinaryFile?(path: string, bytes: Uint8Array): Promise<void>;
  /** True iff a file/dir exists at `path`. */
  fileExists(path: string): Promise<boolean>;
  /** Create a directory. `recursive` mirrors `fs.mkdir`'s option (no-op if it already exists). */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /**
   * List a directory's immediate entries. Directory listing for lint path expansion and glob
   * walking. Does NOT follow symlinks: a symlink entry reports `isFile: false, isDirectory:
   * false` (Node `Dirent` semantics), so walkers never traverse symlinked directories.
   */
  readDir(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>>;
  /**
   * Stat a path, following symlinks (Node `fs.stat` semantics — a symlink to a file reports
   * `isFile: true`). Resolves to null when the path does not exist.
   */
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean } | null>;
  /**
   * Optional no-follow stat for hosts that distinguish symlinks.
   * Resolves to null when the path does not exist.
   */
  lstat?(
    path: string,
  ): Promise<{ isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean } | null>;
}

/**
 * Thrown when a run needs a capability (filesystem, environment, etc.) that the current host
 * cannot provide and no port was injected. Mirrors browser-pilot's `CapabilityError` shape
 * (`name`/`capability`) for cross-package matching by name/structure — no `instanceof`
 * unification across packages is promised or possible.
 */
export class CapabilityError extends Error {
  readonly capability: string;

  constructor(capability: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CapabilityError";
    this.capability = capability;
  }
}

/**
 * Read `process.env` if a `process` global exists (Node/Bun), else `{}` (e.g. Cloudflare
 * Workers without `nodejs_compat`). Never throws.
 */
export function ambientEnv(): Record<string, string | undefined> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  );
}

const textEncoder = new TextEncoder();

export function sha256Text(text: string): string {
  return bytesToHex(sha256(textEncoder.encode(text)));
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

/**
 * Walk a directory tree via the injected port's `readDir`, collecting file paths. Never follows
 * symlinked directories (relies on `readDir`'s no-follow `isDirectory` semantics — see
 * `FileSystemPort`'s docblock). A `readDir` failure on any directory (missing, not a directory,
 * permission error) is swallowed and that subtree contributes no files — matches the previous
 * Node-only behavior's catch-all.
 */
async function walkFiles(fs: FileSystemPort, root: string, recursive: boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }>;
    try {
      entries = await fs.readDir(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isFile) files.push(path);
      else if (recursive && entry.isDirectory) await visit(path);
    }
  }
  await visit(root);
  return files;
}

/** Expand a Bun.Glob-compatible path by walking the injected {@link FileSystemPort}. */
export async function expandGlob(
  raw: string,
  opts: { fs: FileSystemPort; cwd: string },
): Promise<string[]> {
  const pattern = normalizePath(isAbsolute(raw) ? raw : resolve(opts.cwd, raw));
  const files = await walkFiles(opts.fs, resolve(globRoot(pattern)), pattern.includes("**"));
  const regex = globRegex(pattern);
  return files.filter((file) => regex.test(normalizePath(file))).sort((a, b) => a.localeCompare(b));
}

/** Expand immediate TOML children of a directory, matching Bun.Glob("*.toml"). */
export async function listTomlFiles(directory: string, fs: FileSystemPort): Promise<string[]> {
  let entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }>;
  try {
    entries = await fs.readDir(directory);
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) => entry.isFile && entry.name.endsWith(".toml") && !entry.name.endsWith(".lock.toml"),
    )
    .map((entry) => resolve(directory, entry.name))
    .sort((a, b) => a.localeCompare(b));
}
