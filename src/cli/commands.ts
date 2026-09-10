// Flightplan — process-free CLI command core (workers-slice-2 §5/U4).
//
// This module is on the worker-legal graph (gated by `src/fitness/worker-portability.test.ts`):
// it must never statically import `node:*`/`bun:*`, the AI SDKs, or read a bare `process.`
// token. Argument parsing (`parseArgs`), validation (`validateCommandArgs`), and the `lint`/
// `run` command bodies (`executeLint`/`executeRun`) all live here so both the native Node CLI
// (`src/cli/index.ts`, a thin process-wiring shell) and the shell entry share one
// implementation and therefore one exit-code / output contract.
//
// `explain`/`report`/`sweep`/`migrate-effects` stay Node-only in `src/cli/index.ts` — they are
// out of scope for the worker entry.

import { DEFAULT_BASE_DIR, type RunSummary } from "../artifacts/index.ts";
import type { Config, ResolvedConfig } from "../config/index.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import { loadFlowFile } from "../flow/index.ts";
import { formatHuman, formatJson, lintPaths } from "../lint/index.ts";
import { resolve } from "../paths.ts";
import {
  type DriverFactory,
  RunInterruptedError,
  type RunOptions,
  runFlow,
} from "../runner/index.ts";
import type { AiRuntimeFactory } from "../runner/types.ts";
import type { FileSystemPort } from "../runtime.ts";

/** Shared process exit codes across the native CLI and the shell entry. */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  inconclusive: 3,
  deadline: 124,
  cancelled: 130,
} as const;

export const COMMANDS = ["lint", "run", "explain", "report", "sweep", "migrate-effects"] as const;
export type Command = (typeof COMMANDS)[number];

/** Parsed, validated command line. */
export interface ParsedArgs {
  /** The subcommand, or null when none was given (e.g. `--help` / `--version` only). */
  command: Command | null;
  /** Positional arguments after the command (e.g. the flow/run file path). */
  positionals: string[];
  /** Emit machine-readable JSON output (run-summary contract — PLAN.md §4). */
  json: boolean;
  /** CI mode: heal at runtime but report drift instead of persisting it. */
  frozen: boolean;
  /** Suppress all lock writes. */
  noLockWrite: boolean;
  /** Override the lock file path. */
  lock: string | null;
  /** Output directory for run artifacts. */
  out: string | null;
  /** Resume a run from a given step id. */
  from: string | null;
  /** Stop a run after a given step id (inclusive). */
  to: string | null;
  /**
   * Which ladder tier to start resolution at (`--start-tier l0|l3`). `null` = unset (defaults to
   * `"L0"`, the normal ladder — identical to before). `"L3"` runs the "AI-only baseline" mode:
   * skip L0/L1, resolve every step directly via vision, still falling through to L4.
   */
  startTier: "L0" | "L3" | null;
  /** `sweep`: number of trials per (flow, arm). `null` = unset (defaults to 1). */
  trials: number | null;
  /** `sweep`: also run the `--start-tier l3` baseline arm alongside the tiered arm. */
  compareBaseline: boolean;
  /** `--help` / `-h` was requested. */
  help: boolean;
  /** `--version` was requested. */
  version: boolean;
}

/** Raised by parseArgs on malformed input. `exitCode` is the intended process exit code. */
export class CliUsageError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number = EXIT.usage) {
    super(message);
    this.name = "CliUsageError";
    this.exitCode = exitCode;
  }
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

/** Validate command-specific operands and flags after the shared parser has collected them. */
export function validateCommandArgs(args: ParsedArgs): void {
  if (args.command === null) return;

  const allowed = {
    lint: new Set(["json"]),
    run: new Set(["json", "frozen", "noLockWrite", "lock", "out", "from", "to", "startTier"]),
    explain: new Set(["json"]),
    report: new Set(["json"]),
    sweep: new Set(["frozen", "noLockWrite", "lock", "out", "trials", "compareBaseline"]),
    "migrate-effects": new Set(["json"]),
  }[args.command];
  const values: Array<[string, boolean]> = [
    ["--json", args.json],
    ["--frozen", args.frozen],
    ["--no-lock-write", args.noLockWrite],
    ["--lock", args.lock !== null],
    ["--out", args.out !== null],
    ["--from", args.from !== null],
    ["--to", args.to !== null],
    ["--start-tier", args.startTier !== null],
    ["--trials", args.trials !== null],
    ["--compare-baseline", args.compareBaseline],
  ];
  const unsupported = values.find(([name, used]) => used && !allowed.has(flagField(name)));
  if (unsupported) {
    throw new CliUsageError(`${args.command}: flag ${unsupported[0]} is not supported`);
  }

  const maxPositionals = args.command === "lint" || args.command === "report" ? Infinity : 1;
  if (args.positionals.length === 0) {
    throw new CliUsageError(
      `${args.command}: expected ${args.command === "lint" || args.command === "report" ? "at least one" : "one"} path argument`,
    );
  }
  if (args.positionals.length > maxPositionals) {
    throw new CliUsageError(`${args.command}: expected exactly one path argument`);
  }
}

function flagField(name: string): string {
  switch (name) {
    case "--no-lock-write":
      return "noLockWrite";
    case "--start-tier":
      return "startTier";
    case "--compare-baseline":
      return "compareBaseline";
    default:
      return name.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  }
}

/**
 * Parse a raw argv tail (i.e. without the `bun` / script-path prefix) into a validated
 * {@link ParsedArgs}. Throws {@link CliUsageError} on unknown commands or flags, or on a
 * value-flag that is missing its value.
 *
 * Exported for unit testing.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: null,
    positionals: [],
    json: false,
    frozen: false,
    noLockWrite: false,
    lock: null,
    out: null,
    from: null,
    to: null,
    startTier: null,
    trials: null,
    compareBaseline: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    // Flags
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (arg === "--version") {
      parsed.version = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--frozen") {
      parsed.frozen = true;
      continue;
    }
    if (arg === "--no-lock-write") {
      parsed.noLockWrite = true;
      continue;
    }
    if (arg === "--lock") {
      const value = argv[++i];
      if (value === undefined) throw new CliUsageError("--lock requires a path");
      parsed.lock = value;
      continue;
    }
    if (arg === "-o" || arg === "--out") {
      const value = argv[++i];
      if (value === undefined) throw new CliUsageError(`${arg} requires a directory`);
      parsed.out = value;
      continue;
    }
    if (arg === "--from") {
      const value = argv[++i];
      if (value === undefined) throw new CliUsageError("--from requires a step id");
      parsed.from = value;
      continue;
    }
    if (arg === "--to") {
      const value = argv[++i];
      if (value === undefined) throw new CliUsageError("--to requires a step id");
      parsed.to = value;
      continue;
    }
    if (arg === "--start-tier") {
      const value = argv[++i];
      if (value === undefined) throw new CliUsageError("--start-tier requires a value (l0|l3)");
      const normalized = value.toLowerCase();
      if (normalized !== "l0" && normalized !== "l3") {
        throw new CliUsageError(`--start-tier must be "l0" or "l3" (got ${JSON.stringify(value)})`);
      }
      parsed.startTier = normalized === "l3" ? "L3" : "L0";
      continue;
    }
    if (arg === "--trials") {
      const value = argv[++i];
      if (value === undefined) throw new CliUsageError("--trials requires a number");
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        throw new CliUsageError(
          `--trials must be a positive integer (got ${JSON.stringify(value)})`,
        );
      }
      parsed.trials = n;
      continue;
    }
    if (arg === "--compare-baseline") {
      parsed.compareBaseline = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliUsageError(`Unknown flag: ${arg}`);
    }

    // Positional: the first one selects the command.
    if (parsed.command === null) {
      if (!isCommand(arg)) {
        throw new CliUsageError(`Unknown command: ${arg}`);
      }
      parsed.command = arg;
      continue;
    }
    parsed.positionals.push(arg);
  }

  return parsed;
}

export const USAGE = `flightplan — TOML-defined browser-automation flow runner

Usage:
  flightplan <command> [path] [flags]

Commands:
  lint <path...>        Validate flow/config files, directories, or globs
  run <flow.toml>       Execute a flow against a browser
  explain <run-dir|run.jsonl>
                        Render a human-readable failure diagnosis for a run
  report <run-dir>...   Aggregate one or many runs into a campaign metrics report
  sweep <flows-dir>     Run N trials of every flow (tiered, +baseline) into a campaign dir
  migrate-effects <flow.toml>
                        Review-only effect suggestions; never edits flows or locks

Invocation:
  flightplan <command> ...          installed globally or available on PATH
  npx flightplan <command> ...       npm package runner
  bunx flightplan <command> ...      Bun package runner
  bun run flightplan <command> ...   this repository checkout

Quick start:
  flightplan lint path/to/flow.toml
  flightplan run path/to/flow.toml --frozen --no-lock-write --json
  flightplan --version
  # Run Chrome with CDP on localhost:9222, or set [config.connect] mode = "launch".

From this repository, prefix commands with \`bun run flightplan\`.

Flags:
  --json                lint/run/explain/report/migrate-effects: emit machine-readable JSON
  --frozen              run/sweep: heal at runtime, report drift, do not persist
  --no-lock-write       run/sweep: suppress all lock writes
  --lock <path>         run/sweep: override the lock file path
  -o, --out <dir>       run/sweep: output directory for run artifacts
  --from <step>         run: resume at the given step id (inclusive)
  --to <step>           run: stop after the given step id (inclusive); combine with --from
                        to run a debugging slice
  --start-tier <tier>   run: start at "l0" (default) or "l3" (AI-only vision baseline)
  --trials <n>          sweep: number of trials per (flow, arm) (default 1)
  --compare-baseline    sweep: also run each trial with --start-tier l3
  -h, --help            Show this help
  --version             Show version

Examples:
  flightplan lint path/to/flow.toml       Validate a flow file
  flightplan run path/to/flow.toml        Execute a flow against a browser
  flightplan run path/to/flow.toml --json Execute a flow, emit run-summary JSON
  flightplan explain <run.jsonl>         Diagnose a failed run
  flightplan report .flightplan-runs/    Aggregate runs into a metrics report
  flightplan sweep path/to/flows --trials 3 --compare-baseline -o /tmp/campaign
                                          Sweep every flow, tiered + baseline, into a campaign dir
  flightplan migrate-effects path/to/flow.toml
                                          Review effect-policy suggestions (no files changed)

WebMCP is page-scoped and experimental: use Chrome 149+ with the required origin-trial/testing
configuration and verify availability with \`bp webmcp status\`. See README.md and
docs/BROWSER_PILOT_INTEGRATION.md for the full authoring and browser setup contract.`;

export function printUsage(write: (s: string) => void): void {
  write(USAGE);
}

/** Render a concise human summary of a run (verdict, per-step tier, failures, run dir). */
export function formatRunSummary(summary: RunSummary): string {
  const lines: string[] = [];
  const passed = summary.steps.filter((s) => s.ok).length;
  const failed = summary.steps.length - passed;
  lines.push(`Verdict: ${summary.verdict.toUpperCase()}`);
  lines.push(`Flow: ${summary.flow_id}   (run ${summary.run_id})`);
  lines.push(`Steps: ${passed} passed, ${failed} failed of ${summary.steps.length}`);
  for (const s of summary.steps) {
    const mark = s.ok ? "ok " : "FAIL";
    const tier = s.tier ? ` [${s.tier}]` : "";
    const err = s.error ? `  — ${s.error}` : "";
    lines.push(`  ${mark} ${s.stepId} (${s.do})${tier}${err}`);
  }
  if (summary.failed_assertions.length > 0) {
    lines.push("Failed assertions:");
    for (const a of summary.failed_assertions) {
      lines.push(`  ${a.step}: ${a.type} — ${a.detail}`);
    }
  }
  lines.push(`Artifacts: ${summary.run_dir}`);
  return lines.join("\n");
}

/**
 * The process-free dependency surface `executeLint`/`executeRun` need. Both the native CLI
 * (`src/cli/index.ts`) and the shell entry construct one of these and never touch
 * `process`/`console` inside this module.
 */
export interface CommandIO {
  /** Filesystem port for every file operation (flow/lock/artifact reads+writes). */
  fs: FileSystemPort;
  /** Base directory for resolving relative paths (glob roots, directory expansion). */
  cwd: string;
  /** Environment used to resolve `${env.*}` templating and the AI key lookup. Never `process.env`
   * implicitly — the native CLI shell passes it explicitly, the shell entry defaults to `{}`. */
  env: Record<string, string | undefined>;
  /** Write a line of stdout (primary output: lint/run reports, JSON). */
  stdout: (text: string) => void;
  /** Write a line of stderr (usage errors, warnings, IO failures). */
  stderr: (text: string) => void;
  /** Browser driver factory. Defaults to the real `BrowserPilotDriver` when omitted. */
  driverFactory?: DriverFactory;
  /** AI runtime factory. Omitted → AI stays off unless an API key is present in `env`. */
  aiRuntimeFactory?: AiRuntimeFactory;
  /** Cancellation/deadline signal threaded straight into `RunOptions.signal`. */
  signal?: AbortSignal;
  /** Optional whole-run deadline in ms, threaded into `RunOptions.timeoutMs`. */
  timeoutMs?: number;
  /** Version string shown by `--version` in hosts that surface it (the shell entry). */
  version?: string;
}

/**
 * `flightplan lint <path...>` — lint one or more flow/config TOML files. A path may also be a
 * directory (expands to its `*.toml` children) or a glob (e.g. `examples/flows/*.toml`).
 *
 * `argv` is the FULL command tail (command word included, e.g. `["lint", "flow.toml",
 * "--json"]`) — the same shape `parseArgs` always took. Exit code: 0 no errors (warnings
 * allowed) · 1 any file has an error · 2 usage/IO.
 */
export async function executeLint(argv: string[], io: CommandIO): Promise<{ exitCode: number }> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
    validateCommandArgs(args);
  } catch (err) {
    if (err instanceof CliUsageError) {
      io.stderr(err.message);
      return { exitCode: err.exitCode };
    }
    throw err;
  }

  let multi: Awaited<ReturnType<typeof lintPaths>>;
  try {
    multi = await lintPaths(args.positionals, { fs: io.fs, cwd: io.cwd });
  } catch (err) {
    // IO/expansion failure (e.g. an unreadable glob root) → usage/IO error.
    const detail = err instanceof Error ? err.message : String(err);
    io.stderr(`flightplan lint: ${detail}`);
    return { exitCode: EXIT.usage };
  }

  if (multi.results.length === 0) {
    io.stderr("flightplan lint: no TOML files matched the given path(s).");
    return { exitCode: EXIT.usage };
  }

  if (args.json) {
    io.stdout(formatJson(multi));
  } else {
    io.stdout(formatHuman(multi));
  }

  return { exitCode: multi.ok ? EXIT.ok : EXIT.failed };
}

/**
 * `flightplan run <flow.toml> [flags]` — execute a flow against a browser.
 *
 * `argv` is the FULL command tail (command word included, e.g. `["run", "flow.toml",
 * "--json"]`). Exit code: 0 passed · 1 failed · 2 usage/IO/connect error · 3 inconclusive
 * (from `RunResult.exitCode`), plus 124 (deadline) / 130 (cancelled) when `runFlow` rejects
 * with {@link RunInterruptedError}.
 */
export async function executeRun(argv: string[], io: CommandIO): Promise<{ exitCode: number }> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
    validateCommandArgs(args);
  } catch (err) {
    if (err instanceof CliUsageError) {
      io.stderr(err.message);
      return { exitCode: err.exitCode };
    }
    throw err;
  }

  const rawFlowPath = args.positionals[0];
  if (rawFlowPath === undefined) {
    io.stderr("flightplan run: expected a flow file path.");
    return { exitCode: EXIT.usage };
  }
  // Resolve CLI operands once against the command host's cwd. Imports and hooks then
  // resolve from the absolute entry path, independent of the filesystem adapter's cwd.
  const flowPath = resolve(io.cwd, rawFlowPath);

  // Resolve the config from the ENTRY flow's own layers (built-in → flow [config] → flow [run]).
  // Only the entry flow contributes config here — imported flows supply steps, never config,
  // so the entry flow's [connect] (or the attach-localhost:9222 default) is authoritative and
  // imported flows' [connect] blocks are intentionally ignored.
  let config: ResolvedConfig;
  try {
    const loaded = await loadFlowFile(flowPath, io.fs);
    const layers: Config[] = [];
    if (loaded.flow.config) layers.push(loaded.flow.config);
    // The flow-local [run] budgets override config.run (replaced wholesale by resolveConfig).
    if (loaded.flow.run) layers.push({ run: loaded.flow.run });
    config = resolveConfigWithDefaults(layers);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    io.stderr(`flightplan run: ${detail}`);
    return { exitCode: EXIT.usage };
  }

  const runOpts: RunOptions = {
    flowPath,
    cwd: io.cwd,
    config,
    fs: io.fs,
    env: io.env,
    out: resolve(io.cwd, args.out ?? DEFAULT_BASE_DIR),
  };
  if (args.frozen) runOpts.frozen = true;
  if (args.noLockWrite) runOpts.noLockWrite = true;
  if (args.lock !== null) runOpts.lockPath = resolve(io.cwd, args.lock);
  if (args.from !== null) runOpts.fromStep = args.from;
  if (args.to !== null) runOpts.toStep = args.to;
  if (args.json) runOpts.json = true;
  if (args.startTier !== null) runOpts.startTier = args.startTier;
  if (io.driverFactory !== undefined) runOpts.driverFactory = io.driverFactory;
  if (io.aiRuntimeFactory !== undefined) runOpts.aiRuntimeFactory = io.aiRuntimeFactory;
  if (io.signal !== undefined) runOpts.signal = io.signal;
  if (io.timeoutMs !== undefined) runOpts.timeoutMs = io.timeoutMs;
  runOpts.onWarn = io.stderr;

  let result: Awaited<ReturnType<typeof runFlow>>;
  try {
    result = await runFlow(runOpts);
  } catch (err) {
    if (err instanceof RunInterruptedError) {
      io.stderr(`flightplan run: ${err.message}`);
      return { exitCode: err.code === "RUN_TIMEOUT" ? EXIT.deadline : EXIT.cancelled };
    }
    // A throw escaping runFlow is an infra error (runFlow itself never throws for flow failures).
    const detail = err instanceof Error ? err.message : String(err);
    io.stderr(`flightplan run: ${detail}`);
    return { exitCode: EXIT.usage };
  }

  if (args.json) {
    io.stdout(JSON.stringify(result.summary, null, 2));
  } else {
    io.stdout(formatRunSummary(result.summary));
  }
  return { exitCode: result.exitCode };
}
