// Flightplan — the lazily-resolved default `FileSystemPort`.
//
// Portable run-path modules (artifacts/flow/lock/runner/lint) take `fs?: FileSystemPort` and,
// when no port is injected, resolve this default instead of statically importing the Node
// adapter. The import specifier is built at runtime (not a string literal) so bundlers
// (including `Bun.build({ target: "browser" })`, the worker-portability fitness gate's bundle
// proxy) never see a resolvable static specifier and never pull `src/adapters/node/**` (and
// therefore `node:fs`/`node:path`) into a worker bundle. On real Node/Bun the dynamic import
// resolves at runtime exactly as `nodeFileSystem` always did — no behavior change.
//
// Resolution happens once per process (cached) so repeated calls do not repeat the import.

import { CapabilityError, type FileSystemPort } from "./runtime.ts";

let cached: Promise<FileSystemPort> | null = null;

/**
 * Resolve the default `FileSystemPort`: the real Node adapter when available, otherwise throws
 * {@link CapabilityError}. Cached after the first call (successful or not — a host that lacks
 * Node fs will keep lacking it for the process lifetime).
 */
export function defaultFileSystem(): Promise<FileSystemPort> {
  if (cached === null) {
    cached = (async () => {
      try {
        const spec = "./adapters/node/index.js";
        const mod = (await import(/* @vite-ignore */ spec)) as { nodeFileSystem: FileSystemPort };
        return mod.nodeFileSystem;
      } catch (err) {
        throw new CapabilityError(
          "filesystem",
          "no FileSystemPort injected and Node fs unavailable — pass fs",
          { cause: err },
        );
      }
    })();
  }
  return cached;
}
