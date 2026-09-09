import { describe, expect, test } from "bun:test";
import { Bash, type Command, createCommandContext, type IFileSystem, InMemoryFs } from "just-bash";
import { MockDriver } from "../driver/index.ts";
import type { FileSystemPort } from "../runtime.ts";
import { type FlightplanShellPorts, runFlightplan } from "./index.ts";

// Consumer-owned glue: only this integration test depends on just-bash.
function commandsForJustBash(ports: FlightplanShellPorts = {}): Command[] {
  return [
    {
      name: "flightplan",
      trusted: true,
      async execute(args, ctx) {
        const result = await runFlightplan(
          args,
          {
            fs: justBashFileSystem(ctx.fs, ctx.cwd),
            cwd: ctx.cwd,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          },
          ports,
        );
        return { ...result, stdoutKind: "text" as const };
      },
    },
  ];
}

const FLOW_SOURCE = `
version = 1
kind = "flow"
id = "just-bash.smoke"
description = "a minimal flow for the just-bash adapter"

[[steps]]
id = "open"
do = "goto"
url = "https://example.test/"
`;

const FLOW_WITH_IMPORT = `
version = 1
kind = "flow"
id = "just-bash.parent"
description = "a flow importing a child that does not exist, to force a lint diagnostic"
imports = "./child.toml"

[[steps]]
id = "login"
do = "run"
flow = "auth.nope"
`;

const CHILD_FLOW = `
version = 1
kind = "flow"
id = "auth.login"
description = "child"

[[steps]]
id = "open"
do = "goto"
url = "https://example.com/"
`;

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines[lines.length - 1] ?? "";
}

describe("commandsForJustBash — real just-bash Bash", () => {
  test("flightplan lint reports diagnostics from an import and exits 1 on error", async () => {
    const bash = new Bash({
      customCommands: commandsForJustBash({}),
      files: {
        "/flows/a.toml": FLOW_WITH_IMPORT,
        "/flows/child.toml": CHILD_FLOW,
      },
      defenseInDepth: false,
    });
    const res = await bash.exec("flightplan lint /flows/a.toml --json");
    expect(res.exitCode).toBe(1);
    const report = JSON.parse(res.stdout) as { ok: boolean; results: unknown[] };
    expect(report.ok).toBe(false);
    expect(report.results.length).toBe(1);
  });

  test("flightplan run --json passes with a MockDriver and writes artifacts into the VFS", async () => {
    const bash = new Bash({
      customCommands: commandsForJustBash({ driverFactory: () => new MockDriver() }),
      files: { "/flows/a.toml": FLOW_SOURCE },
      defenseInDepth: false,
    });
    const res = await bash.exec("flightplan run /flows/a.toml --json --no-lock-write -o /out");
    expect(res.exitCode).toBe(0);
    const summary = JSON.parse(res.stdout) as {
      summary_version: number;
      verdict: string;
      run_dir: string;
    };
    expect(summary.summary_version).toBe(1);
    expect(summary.verdict).toBe("passed");

    // Prove artifacts landed IN the shell VFS (not just in-process memory): `ls`/`cat` the
    // run directory via the same Bash instance.
    const ls = await bash.exec(`ls ${summary.run_dir}`);
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout).toContain("run.jsonl");
    const cat = await bash.exec(`cat ${summary.run_dir}/run.jsonl`);
    expect(cat.exitCode).toBe(0);
    expect(cat.stdout.length).toBeGreaterThan(0);
  });

  test("flightplan run without a driverFactory fails fast with exit 2 and an actionable message", async () => {
    const bash = new Bash({
      customCommands: commandsForJustBash({}),
      files: { "/flows/a.toml": FLOW_SOURCE },
      defenseInDepth: false,
    });
    const res = await bash.exec("flightplan run /flows/a.toml");
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("driverFactory");
  });

  test("flightplan run --json output pipes through a downstream shell command", async () => {
    const bash = new Bash({
      customCommands: commandsForJustBash({ driverFactory: () => new MockDriver() }),
      files: { "/flows/a.toml": FLOW_SOURCE },
      defenseInDepth: false,
    });
    const res = await bash.exec(
      "flightplan run /flows/a.toml --json --no-lock-write | head -c 100",
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout.length).toBe(100);
    expect(res.stdout).toContain('"summary_version"');
  });

  test("${env.*} interpolation reads ports.env, never the shell's own exported env", async () => {
    const flowWithEnv = FLOW_SOURCE.replace(
      'url = "https://example.test/"',
      'url = "https://example.test/?t=${env.TOKEN}"',
    );
    const driver = new MockDriver();
    const bash = new Bash({
      customCommands: commandsForJustBash({
        driverFactory: () => driver,
        env: { TOKEN: "from-ports" },
      }),
      files: { "/flows/a.toml": flowWithEnv },
      env: { TOKEN: "from-shell-should-never-be-used" },
      defenseInDepth: false,
    });
    const res = await bash.exec("flightplan run /flows/a.toml --json --no-lock-write");
    expect(res.exitCode).toBe(0);
    // Assert against the URL the MockDriver actually navigated to (recorded on its call log),
    // not against the JSON summary — the run summary never echoes step arguments back out.
    const gotoCall = driver.callsTo("goto")[0];
    const gotoUrl = (gotoCall?.args as [string] | undefined)?.[0];
    expect(gotoUrl).toContain("from-ports");
    expect(gotoUrl).not.toContain("from-shell-should-never-be-used");
  });

  test("lints a directory even when the VFS lacks readdirWithFileTypes (fallback path)", async () => {
    const inner = new InMemoryFs({
      "/flows/a.toml": FLOW_WITH_IMPORT,
      "/flows/child.toml": CHILD_FLOW,
    });
    // Wrap the fs to hide the optional `readdirWithFileTypes`, forcing the adapter's own
    // `readdir` + per-entry `stat` fallback (vfs.ts). Methods are bound to `inner` (not a
    // `Proxy`) so `InMemoryFs.readdir`'s own internal optimization call to
    // `this.readdirWithFileTypes` still resolves against the real object — only the
    // property this adapter reads directly is hidden.
    const wrapped: InMemoryFs = Object.create(Object.getPrototypeOf(inner));
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(inner))) {
      const value = (inner as unknown as Record<string, unknown>)[key];
      if (typeof value === "function") {
        (wrapped as unknown as Record<string, unknown>)[key] = value.bind(inner);
      }
    }
    (wrapped as unknown as Record<string, unknown>).readdirWithFileTypes = undefined;
    const bash = new Bash({
      customCommands: commandsForJustBash({}),
      fs: wrapped,
      defenseInDepth: false,
    });
    const res = await bash.exec("flightplan lint /flows --json");
    expect(res.exitCode).toBe(1);
    const report = JSON.parse(res.stdout) as { results: unknown[] };
    // Both `a.toml` (the parent, one error) and `child.toml` (the import) are picked up by the
    // directory expansion, which is only reachable through the `readdir`+`stat` fallback here.
    expect(report.results.length).toBe(2);
  });
});

describe("commandsForJustBash — cancellation, invoked without the Bash exec wrapper", () => {
  // just-bash's own `Bash.exec({ signal })` intercepts ANY aborted signal itself (before or
  // during dispatch) and always reports exit 124 ("bash: execution aborted"), regardless of
  // what a custom command's `execute()` returns — verified against just-bash@3.4.2. So the
  // adapter's own 130-vs-124 distinction (`executeRun`'s `RunInterruptedError` mapping,
  // `src/cli/commands.ts`) is only observable by invoking the registered `Command.execute()`
  // directly with a `ResolvedCommandContext` (via `createCommandContext`), bypassing that
  // shell-level wrapper. This is a documented deviation from the plan's "pre-aborted ctx.signal
  // → exit 130 via bash.exec" expectation.
  function makeCtx(fs: InMemoryFs, signal?: AbortSignal) {
    return createCommandContext({ fs, cwd: "/", ...(signal ? { signal } : {}) });
  }

  test("a pre-aborted ctx.signal maps to exit 130 (cancelled) via the command's own dispatch", async () => {
    const fs = new InMemoryFs({ "/flows/a.toml": FLOW_SOURCE });
    const [command] = commandsForJustBash({ driverFactory: () => new MockDriver() });
    if (!command) throw new Error("expected a registered command");
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx(fs, controller.signal);
    const res = await command.execute(
      ["run", "/flows/a.toml", "--no-lock-write"],
      ctx as Parameters<typeof command.execute>[1],
    );
    expect(res.exitCode).toBe(130);
  });

  test("a tiny timeoutMs maps to exit 124 (deadline)", async () => {
    const fs = new InMemoryFs({ "/flows/a.toml": FLOW_SOURCE });
    // Hang every read after the first so the run is still loading when the deadline fires,
    // mirroring `src/cli/commands.test.ts`'s deadline test.
    const hang = new Promise<string>(() => {});
    const originalRead = fs.readFile.bind(fs);
    let reads = 0;
    fs.readFile = (async (path: string) => {
      reads += 1;
      if (reads > 1) return hang;
      return originalRead(path);
    }) as typeof fs.readFile;
    const [command] = commandsForJustBash({
      driverFactory: () => new MockDriver(),
      timeoutMs: 5,
    });
    if (!command) throw new Error("expected a registered command");
    const ctx = makeCtx(fs);
    const res = await command.execute(
      ["run", "/flows/a.toml", "--no-lock-write"],
      ctx as Parameters<typeof command.execute>[1],
    );
    expect(res.exitCode).toBe(124);
  });

  test("AI stays off by default: an ai_pick step fails cleanly (exit 1/2), never silently invoking a real provider", async () => {
    const flowWithAi = `
version = 1
kind = "flow"
id = "just-bash.ai-off"
description = "a flow whose only step requires AI"

[[steps]]
id = "pick"
do = "ai_pick"
prompt = "click the button"
`;
    const fs = new InMemoryFs({ "/flows/a.toml": flowWithAi });
    const [command] = commandsForJustBash({ driverFactory: () => new MockDriver() });
    if (!command) throw new Error("expected a registered command");
    const ctx = makeCtx(fs);
    const res = await command.execute(
      ["run", "/flows/a.toml", "--no-lock-write"],
      ctx as Parameters<typeof command.execute>[1],
    );
    // Without an injected aiRuntimeFactory and no key in ports.env, the ai_pick step cannot
    // resolve — the run reports a failure (exit 1) or an infra/usage error (exit 2), but never
    // exit 0. Either is an acceptable "AI off" outcome; only a passing run would be a bug.
    expect(res.exitCode).not.toBe(0);
  });
});

describe("help / usage", () => {
  test("--help lists native-only commands", async () => {
    const bash = new Bash({
      customCommands: commandsForJustBash({}),
      defenseInDepth: false,
    });
    const res = await bash.exec("flightplan --help");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Native-only commands");
    expect(res.stdout).toContain("explain");
    expect(res.stdout).toContain("sweep");
  });

  test("--version prints the host-supplied version string", async () => {
    const bash = new Bash({
      customCommands: commandsForJustBash({ version: "9.9.9" }),
      defenseInDepth: false,
    });
    const res = await bash.exec("flightplan --version");
    expect(res.exitCode).toBe(0);
    expect(lastLine(res.stdout)).toBe("9.9.9");
  });
});

/** Shape of `IFileSystem.readdirWithFileTypes`'s entries (not re-exported from the package root). */
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * Wrap a just-bash `IFileSystem` (typically `ctx.fs` from a `ResolvedCommandContext`) as a
 * `FileSystemPort`. `cwd` is used only to resolve relative paths passed to this port's methods
 * — it does not change with `cd` inside the shell; callers construct a fresh wrapper per
 * invocation (the adapter's `index.ts` does this for every `flightplan` call).
 */
function justBashFileSystem(fs: IFileSystem, cwd: string): FileSystemPort {
  const resolve = (path: string): string => fs.resolvePath(cwd, path);

  return {
    async readTextFile(path: string): Promise<string> {
      return fs.readFile(resolve(path));
    },
    async writeTextFile(path: string, text: string): Promise<void> {
      await fs.writeFile(resolve(path), text);
    },
    async appendTextFile(path: string, text: string): Promise<void> {
      await fs.appendFile(resolve(path), text);
    },
    // No writeBinaryFile: the just-bash VFS has no byte-clean write path this adapter can use
    // safely (writeFile's FileContent covers it, but binary-artifact plumbing is out of scope
    // for this slice — see docs/plans/workers-slice-2.md §10, "Screenshots/recording through
    // the port" — deferred).
    async fileExists(path: string): Promise<boolean> {
      return fs.exists(resolve(path));
    },
    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      await fs.mkdir(resolve(path), options);
    },
    async readDir(
      path: string,
    ): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>> {
      const resolved = resolve(path);
      if (fs.readdirWithFileTypes) {
        const entries = await fs.readdirWithFileTypes(resolved);
        return entries.map((entry: DirentEntry) => ({
          name: entry.name,
          isFile: entry.isFile,
          isDirectory: entry.isDirectory,
        }));
      }
      // Fallback for IFileSystem implementations that omit the optional
      // `readdirWithFileTypes` (per-name `stat`, matching Node `Dirent` no-follow semantics
      // isn't available without `lstat` per entry — `stat` is the best this fallback can do,
      // which matches `readdirWithFileTypes`'s own documented file-type intent).
      const names = await fs.readdir(resolved);
      const out: Array<{ name: string; isFile: boolean; isDirectory: boolean }> = [];
      for (const name of names) {
        const childPath = fs.resolvePath(resolved, name);
        try {
          const st = await fs.stat(childPath);
          out.push({ name, isFile: st.isFile, isDirectory: st.isDirectory });
        } catch {
          // Entry vanished between readdir and stat, or is an unreadable special file —
          // report it as neither file nor directory, matching a broken-symlink Dirent.
          out.push({ name, isFile: false, isDirectory: false });
        }
      }
      return out;
    },
    async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean } | null> {
      try {
        const st = await fs.stat(resolve(path));
        return { isFile: st.isFile, isDirectory: st.isDirectory };
      } catch {
        return null;
      }
    },
    async lstat(
      path: string,
    ): Promise<{ isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean } | null> {
      try {
        const st = await fs.lstat(resolve(path));
        return {
          isFile: st.isFile,
          isDirectory: st.isDirectory,
          isSymbolicLink: st.isSymbolicLink,
        };
      } catch {
        return null;
      }
    },
  };
}
