import { type FileSystemPort, runFlightplan } from "@svilupp/flightplan/shell";
import { type DriverFactory, MockDriver } from "@svilupp/flightplan/worker";
import { Bash, type IFileSystem } from "just-bash/browser";

const FLOW = `version = 1
kind = "flow"
id = "worker-demo"
description = "Flightplan through a shell in a Worker"

[[steps]]
id = "open"
do = "goto"
url = "https://example.com/"
`;

// Consumer-owned adapter. Flightplan itself has no dependency on just-bash.
function fileSystem(fs: IFileSystem): FileSystemPort {
  const parent = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
  const missing = (error: unknown) =>
    error instanceof Error && /\b(?:ENOENT|ENOTDIR)\b/.test(error.message);
  return {
    readTextFile: (path) => fs.readFile(path),
    async writeTextFile(path, text) {
      await fs.mkdir(parent(path), { recursive: true });
      await fs.writeFile(path, text);
    },
    async appendTextFile(path, text) {
      await fs.mkdir(parent(path), { recursive: true });
      await fs.appendFile(path, text);
    },
    async writeBinaryFile(path, bytes) {
      await fs.mkdir(parent(path), { recursive: true });
      await fs.writeFile(path, bytes);
    },
    fileExists: (path) => fs.exists(path),
    mkdir: (path, options) => fs.mkdir(path, options),
    async readDir(path) {
      return Promise.all(
        (await fs.readdir(path)).map(async (name) => {
          const stat = await fs.lstat(fs.resolvePath(path, name));
          return {
            name,
            isFile: !stat.isSymbolicLink && stat.isFile,
            isDirectory: !stat.isSymbolicLink && stat.isDirectory,
          };
        }),
      );
    },
    async stat(path) {
      try {
        return await fs.stat(path);
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async lstat(path) {
      try {
        return await fs.lstat(path);
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
  };
}

/** The host supplies a fresh Driver per run; it owns remote browser/session policy. */
export function createShell(driverFactory: DriverFactory, signal?: AbortSignal): Bash {
  return new Bash({
    cwd: "/workspace",
    files: { "/workspace/demo.toml": FLOW },
    customCommands: [
      {
        name: "flightplan",
        trusted: true,
        async execute(args, ctx) {
          const signals = [signal, ctx.signal].filter((value): value is AbortSignal => !!value);
          const result = await runFlightplan(
            args,
            {
              fs: fileSystem(ctx.fs),
              cwd: ctx.cwd,
              ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
            },
            {
              driverFactory,
              env: {},
              timeoutMs: 30_000,
            },
          );
          return { ...result, stdoutKind: "text" as const };
        },
      },
    ],
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    // Offline demo. Replace this factory with your host's remote browser Driver.
    const bash = createShell(() => new MockDriver(), request.signal);
    const result = await bash.exec(
      "flightplan lint demo.toml --json > lint.json && " +
        "flightplan run demo.toml --json --frozen --no-lock-write -o /runs",
    );
    return Response.json({ mode: "mock", ...result });
  },
};
