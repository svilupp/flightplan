// A Map-backed, worker-legal `FileSystemPort` implementation. Useful for tests and for hosts
// (e.g. Cloudflare Workers) that want an in-memory filesystem instead of a real one. Implements
// the full port, including `readDir`/`stat`/`lstat`, with the same symlink semantics
// (`stat` follows, `readDir` does not) documented on `FileSystemPort` in `runtime.ts` — there
// are no real symlinks in-memory, so `lstat` always reports `isSymbolicLink: false`.

import type { FileSystemPort } from "../runtime.ts";

function normalize(path: string): string {
  const withSlashes = path.replaceAll("\\", "/");
  if (withSlashes.length > 1 && withSlashes.endsWith("/")) return withSlashes.slice(0, -1);
  return withSlashes;
}

function dirnameOf(path: string): string {
  const normalized = normalize(path);
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return ".";
  if (slash === 0) return "/";
  return normalized.slice(0, slash);
}

function basenameOf(path: string): string {
  const normalized = normalize(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

/** Create a fresh, empty in-memory `FileSystemPort`. Each call is an independent filesystem. */
export function memoryFileSystem(): FileSystemPort {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>(["/", "."]);

  function ensureDir(path: string): void {
    let dir = normalize(path);
    while (dir && dir !== "/" && dir !== "." && !dirs.has(dir)) {
      dirs.add(dir);
      dir = dirnameOf(dir);
    }
    dirs.add(dir);
  }

  return {
    async readTextFile(path: string): Promise<string> {
      const key = normalize(path);
      const value = files.get(key);
      if (value === undefined) throw new Error(`ENOENT: no such file '${path}'`);
      return typeof value === "string" ? value : new TextDecoder().decode(value);
    },
    async writeTextFile(path: string, text: string): Promise<void> {
      const key = normalize(path);
      ensureDir(dirnameOf(key));
      files.set(key, text);
    },
    async appendTextFile(path: string, text: string): Promise<void> {
      const key = normalize(path);
      ensureDir(dirnameOf(key));
      const existing = files.get(key);
      const prefix = existing === undefined ? "" : typeof existing === "string" ? existing : "";
      files.set(key, prefix + text);
    },
    async writeBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
      const key = normalize(path);
      ensureDir(dirnameOf(key));
      files.set(key, bytes);
    },
    async fileExists(path: string): Promise<boolean> {
      const key = normalize(path);
      return files.has(key) || dirs.has(key);
    },
    async mkdir(path: string): Promise<void> {
      ensureDir(normalize(path));
    },
    async readDir(
      path: string,
    ): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>> {
      const key = normalize(path);
      if (!dirs.has(key)) throw new Error(`ENOENT: no such directory '${path}'`);
      const names = new Map<string, { isFile: boolean; isDirectory: boolean }>();
      for (const filePath of files.keys()) {
        if (dirnameOf(filePath) === key) {
          names.set(basenameOf(filePath), { isFile: true, isDirectory: false });
        }
      }
      for (const dirPath of dirs) {
        if (dirPath === key) continue;
        if (dirnameOf(dirPath) === key) {
          names.set(basenameOf(dirPath), { isFile: false, isDirectory: true });
        }
      }
      return [...names.entries()]
        .map(([name, kind]) => ({ name, ...kind }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean } | null> {
      const key = normalize(path);
      if (files.has(key)) return { isFile: true, isDirectory: false };
      if (dirs.has(key)) return { isFile: false, isDirectory: true };
      return null;
    },
    async lstat(
      path: string,
    ): Promise<{ isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean } | null> {
      const key = normalize(path);
      if (files.has(key)) return { isFile: true, isDirectory: false, isSymbolicLink: false };
      if (dirs.has(key)) return { isFile: false, isDirectory: true, isSymbolicLink: false };
      return null;
    },
  };
}
