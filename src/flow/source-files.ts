import type { FileSystemPort } from "../runtime.ts";

/** A preparation filesystem and the exact source bytes it has read. */
export interface SourceFileCapture {
  readonly fs: FileSystemPort;
  readonly sources: ReadonlyMap<string, string>;
}

function withTextReader(
  fs: FileSystemPort,
  readTextFile: FileSystemPort["readTextFile"],
): FileSystemPort {
  // Preserve optional capabilities and method receivers on injected class-based adapters.
  return new Proxy(
    { ...fs },
    {
      get(_target, property) {
        if (property === "readTextFile") return readTextFile;
        const value: unknown = Reflect.get(fs, property, fs);
        return typeof value === "function" ? value.bind(fs) : value;
      },
      has(_target, property) {
        return property in fs;
      },
    },
  );
}

/** Cache source reads during preparation, including nested calls and hooks. */
export function captureSourceFiles(
  fs: FileSystemPort,
  initialSources: ReadonlyMap<string, string> = new Map(),
): SourceFileCapture {
  const sources = new Map(initialSources);
  return {
    sources,
    fs: withTextReader(fs, async (path) => {
      const cached = sources.get(path);
      if (cached !== undefined) return cached;
      const source = await fs.readTextFile(path);
      sources.set(path, source);
      return source;
    }),
  };
}

/** Replay prepared sources; other reads and all writes (locks/artifacts) remain live. */
export function pinSourceFiles(
  fs: FileSystemPort,
  sources: ReadonlyMap<string, string>,
): FileSystemPort {
  const pinned = new Map(sources);
  return withTextReader(fs, async (path) => pinned.get(path) ?? fs.readTextFile(path));
}
