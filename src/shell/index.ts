// Host-independent shell entry, sharing lint/run behavior with the native CLI.
import { type CommandIO, EXIT, executeLint, executeRun, USAGE } from "../cli/commands.ts";
import type { AiRuntimeFactory, DriverFactory } from "../runner/types.ts";
import type { FileSystemPort } from "../runtime.ts";

export { EXIT } from "../cli/commands.ts";
export type { FileSystemPort } from "../runtime.ts";

/** Per-invocation context supplied by the shell host. */
export interface FlightplanShellContext {
  fs: FileSystemPort;
  /** Absolute working directory in the supplied filesystem. */
  cwd: string;
  signal?: AbortSignal;
}

export interface FlightplanShellPorts {
  /** Explicit template/provider environment. Defaults to {}, with no ambient lookup. */
  env?: Record<string, string | undefined>;
  /** Required for run. The host owns browser connection and session policy. */
  driverFactory?: DriverFactory;
  aiRuntimeFactory?: AiRuntimeFactory;
  /** Both commands are enabled unless explicitly disabled. */
  capabilities?: { lint?: boolean; run?: boolean };
  /** Maximum UTF-8 bytes per output stream. Defaults to 1 MiB; excess output fails. */
  limits?: { maxOutputBytes?: number };
  version?: string;
  timeoutMs?: number;
}

export interface FlightplanShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const HELP_TEXT = `${USAGE}

Shell entry notes:
  Only "lint" and "run" are available through the "flightplan" shell command.
  Native-only commands: explain, report, sweep, migrate-effects.
`;

async function dispatch(
  args: string[],
  context: FlightplanShellContext,
  ports: FlightplanShellPorts,
): Promise<FlightplanShellResult> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    return { stdout: HELP_TEXT, stderr: "", exitCode: EXIT.ok };
  }
  if (args[0] === "--version") {
    return { stdout: `${ports.version ?? "unknown"}\n`, stderr: "", exitCode: EXIT.ok };
  }

  const command = args[0];
  if (command !== "lint" && command !== "run") {
    return {
      stdout: "",
      stderr: `flightplan: unknown subcommand '${command}'. Run 'flightplan --help' to list commands.\n`,
      exitCode: EXIT.usage,
    };
  }
  if (ports.capabilities?.[command] === false) {
    return {
      stdout: "",
      stderr: `flightplan ${command}: capability '${command}' is not granted on this host.\n`,
      exitCode: EXIT.usage,
    };
  }
  if (command === "run" && ports.driverFactory === undefined) {
    return {
      stdout: "",
      stderr:
        "flightplan run: no driverFactory supplied; pass { driverFactory } to runFlightplan().\n",
      exitCode: EXIT.usage,
    };
  }

  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CommandIO = {
    fs: context.fs,
    cwd: context.cwd,
    env: ports.env ?? {},
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  if (context.signal !== undefined) io.signal = context.signal;
  if (ports.driverFactory !== undefined) io.driverFactory = ports.driverFactory;
  if (ports.aiRuntimeFactory !== undefined) io.aiRuntimeFactory = ports.aiRuntimeFactory;
  if (ports.timeoutMs !== undefined) io.timeoutMs = ports.timeoutMs;
  const { exitCode } = await (command === "lint" ? executeLint(args, io) : executeRun(args, io));
  return {
    stdout: stdout.join("\n") + (stdout.length ? "\n" : ""),
    stderr: stderr.join("\n"),
    exitCode,
  };
}

/**
 * Execute a parsed argv tail, e.g. ["lint", "flow.toml", "--json"].
 * The host handles command registration and adapts its storage to FileSystemPort.
 */
export async function runFlightplan(
  args: string[],
  context: FlightplanShellContext,
  ports: FlightplanShellPorts = {},
): Promise<FlightplanShellResult> {
  const result = await dispatch(args, context, ports);
  const maxBytes = ports.limits?.maxOutputBytes ?? 1_048_576;
  const encoder = new TextEncoder();
  if (
    encoder.encode(result.stdout).byteLength > maxBytes ||
    encoder.encode(result.stderr).byteLength > maxBytes
  ) {
    return {
      stdout: "",
      stderr: "flightplan: output exceeds the configured output limit\n",
      exitCode: EXIT.usage,
    };
  }
  return result;
}
