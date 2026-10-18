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
import {
  type NamedSessionBorrower,
  namedSessionDriverFactory,
  nativeNamedSessionBorrower,
} from "../driver/named-session.ts";
import { loadFlowFile } from "../flow/index.ts";
import {
  InputBindingError,
  type InputValues,
  inputMetadata,
  parseInputJson,
} from "../flow/input.ts";
import { resolveInputs } from "../flow/template.ts";
import type { FlowFile } from "../flow/types.ts";
import { checkFlow } from "../inspection/check.ts";
import { InvocationError } from "../invocation/index.ts";
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
import { executeCatalogue } from "./catalogue.ts";

/** Shared process exit codes across the native CLI and the shell entry. */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  inconclusive: 3,
  deadline: 124,
  cancelled: 130,
} as const;

export const COMMANDS = [
  "lint",
  "run",
  "explain",
  "report",
  "sweep",
  "migrate-effects",
  "config",
  "list",
  "describe",
  "check",
] as const;
export type Command = (typeof COMMANDS)[number];

/** Parsed, validated command line. */
export interface ParsedArgs {
  inputs: string[];
  inputEnvs: string[];
  inputsFile: string | null;
  idempotencyKey: string | null;
  session: string | null;
  targetId: string | null;
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
    config: new Set(["json"]),
    list: new Set(["json"]),
    describe: new Set(["json"]),
    check: new Set(["json", "inputs", "inputEnvs", "inputsFile", "session", "targetId"]),
    run: new Set([
      "json",
      "frozen",
      "noLockWrite",
      "lock",
      "out",
      "from",
      "to",
      "startTier",
      "inputs",
      "inputEnvs",
      "inputsFile",
      "idempotencyKey",
      "session",
      "targetId",
    ]),
    explain: new Set(["json"]),
    report: new Set(["json"]),
    sweep: new Set(["frozen", "noLockWrite", "lock", "out", "trials", "compareBaseline"]),
    "migrate-effects": new Set(["json"]),
  }[args.command];
  const values: Array<[string, boolean]> = [
    ["--json", args.json],
    ["--inputs", args.inputs.length > 0],
    ["--input-envs", args.inputEnvs.length > 0],
    ["--inputs-file", args.inputsFile !== null],
    ["--idempotency-key", args.idempotencyKey !== null],
    ["--session", args.session !== null],
    ["--target-id", args.targetId !== null],
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

  if (args.targetId !== null && args.session === null)
    throw new CliUsageError("--target-id requires --session");
  const maxPositionals =
    args.command === "lint" || args.command === "report" || args.command === "list" ? Infinity : 1;
  if (args.positionals.length === 0) {
    throw new CliUsageError(
      `${args.command}: expected ${args.command === "lint" || args.command === "report" || args.command === "list" ? "at least one" : "one"} path argument`,
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
    inputs: [],
    inputEnvs: [],
    inputsFile: null,
    idempotencyKey: null,
    session: null,
    targetId: null,
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
    if (arg === "--session" || arg === "--target-id") {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith("--"))
        throw new CliUsageError(`${arg} requires an identifier`);
      if (arg === "--session") parsed.session = value;
      else parsed.targetId = value;
      continue;
    }
    if (arg === "--idempotency-key") {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith("--"))
        throw new CliUsageError("--idempotency-key requires an identifier");
      if (parsed.idempotencyKey !== null)
        throw new CliUsageError("--idempotency-key may only be specified once");
      parsed.idempotencyKey = value;
      continue;
    }
    if (arg === "--input" || arg === "--input-env" || arg === "--inputs-file") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--"))
        throw new CliUsageError(`${arg} requires a value`);
      if (arg === "--inputs-file") {
        if (parsed.inputsFile !== null)
          throw new CliUsageError("--inputs-file may only be specified once");
        parsed.inputsFile = value;
      } else (arg === "--input" ? parsed.inputs : parsed.inputEnvs).push(value);
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
  config <flow.toml>    Inspect effective JEV policy offline as JSON
  run <flow.toml>       Execute a flow against a browser
  list <path...>       List recipe metadata without browser or model access
  describe <flow.toml> Describe one recipe as JSON
  check <flow.toml>    Inspect current entry state without dispatch; later states unchecked
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
  --json                Emit machine-readable JSON
  --session <name>       run: borrow a fenced BP-owned named session
  --target-id <id>       run: select one exact existing target in --session
  --idempotency-key <id> run: atomically claim one invocation; duplicates never redispatch
  --input <name=value>  run: override a declared scalar input
  --inputs-file <path> run: JSON object of typed input values
  --input-env <n=ENV>  run: bind a declared secret through an env reference
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
  flightplan config path/to/flow.toml --json  Inspect effective JEV policy and runtime requirements
  flightplan lint path/to/flow.toml       Validate a flow file
  flightplan run path/to/flow.toml        Execute a flow against a browser
  flightplan run path/to/flow.toml --json Execute a flow, emit run-summary JSON
  flightplan explain <run.jsonl>         Diagnose a failed run
  flightplan report .flightplan-runs/    Aggregate runs into a metrics report
  flightplan sweep path/to/flows --trials 3 --compare-baseline -o /tmp/campaign
                                          Sweep every flow, tiered + baseline, into a campaign dir
  flightplan migrate-effects path/to/flow.toml
                                          Review effect-policy suggestions (no files changed)

JEV configuration:
  [config.ai] classifier selects auto, heuristic, llm, or jev.
  [config.ai.jev] profile selects text, visual, or shadow; visual requires images = "allow".
  config reports policy, capabilities, budgets, provenance, and credential availability;
  it makes no model or browser calls and never prints credential values.
  JEV uses TYPESAFE_API_KEY (JEV_API_KEY alias); jev_api_key_env selects a custom env var
  and disables the alias. Image strategies are experimental; Box/crop are evaluation-only.
  Schema: docs/schemas/config.schema.json. See README.md for profile behavior and limits.

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
  invocationStore?: import("../invocation/index.ts").InvocationStore;
  namedSessionBorrower?: NamedSessionBorrower;
  /** AI runtime factory. Omitted → AI stays off unless an API key is present in `env`. */
  aiRuntimeFactory?: AiRuntimeFactory;
  /** Cancellation/deadline signal threaded straight into `RunOptions.signal`. */
  signal?: AbortSignal;
  /** Optional whole-run deadline in ms, threaded into `RunOptions.timeoutMs`. */
  timeoutMs?: number;
  /** Version string shown by `--version` in hosts that surface it (the shell entry). */
  version?: string;
}

async function readCliInputs(
  args: ParsedArgs,
  flow: FlowFile,
  io: CommandIO,
): Promise<InputValues | undefined> {
  let inputs: InputValues | undefined;
  if (args.inputs.length || args.inputEnvs.length || args.inputsFile !== null) {
    inputs = {};
    if (args.inputsFile !== null) {
      let text: string;
      try {
        text = await io.fs.readTextFile(resolve(io.cwd, args.inputsFile));
      } catch {
        throw new CliUsageError("inputs-file could not be read");
      }
      inputs = parseInputJson(text);
    }
    const seen = new Set<string>();
    const issues: Array<{ code: string; input: string; message: string }> = [];
    for (const [assignments, secret] of [
      [args.inputs, false],
      [args.inputEnvs, true],
    ] as const) {
      for (const assignment of assignments) {
        const equals = assignment.indexOf("=");
        if (equals < 1) {
          issues.push({
            code: "INPUT_ASSIGNMENT",
            input: "<assignment>",
            message: "Expected name=value.",
          });
          continue;
        }
        const name = assignment.slice(0, equals);
        const text = assignment.slice(equals + 1);
        if (seen.has(name)) {
          issues.push({
            code: "INPUT_DUPLICATE",
            input: name,
            message: "Input is supplied more than once on the command line.",
          });
          continue;
        }
        seen.add(name);
        const declaration = flow.inputs?.[name];
        const meta = declaration === undefined ? undefined : inputMetadata(declaration);
        if (secret) {
          inputs[name] = { from_env: text };
          continue;
        }
        if (meta?.secret) {
          issues.push({
            code: "INPUT_SECRET_REFERENCE",
            input: name,
            message: "Use --input-env for declared secrets.",
          });
          continue;
        }
        if (meta?.type === "number") {
          if (!text.trim() || !Number.isFinite(Number(text))) {
            issues.push({ code: "INPUT_TYPE", input: name, message: "Expected number." });
            continue;
          }
          inputs[name] = Number(text);
        } else if (meta?.type === "boolean") {
          if (text !== "true" && text !== "false") {
            issues.push({ code: "INPUT_TYPE", input: name, message: "Expected true or false." });
            continue;
          }
          inputs[name] = text === "true";
        } else inputs[name] = text;
      }
    }
    if (issues.length) {
      try {
        resolveInputs(flow.inputs, undefined, io.env, {}, inputs);
      } catch (error) {
        if (error instanceof InputBindingError) issues.push(...error.issues);
      }
      throw new InputBindingError(issues);
    }
  }
  resolveInputs(flow.inputs, undefined, io.env, {}, inputs);
  return inputs;
}

function inputError(error: unknown, args: ParsedArgs, io: CommandIO): boolean {
  if (!(error instanceof InputBindingError)) return false;
  if (args.json)
    io.stdout(
      JSON.stringify(
        { diagnostics: error.issues.map((issue) => ({ ...issue, severity: "error" })) },
        null,
        2,
      ),
    );
  else io.stderr(error.message);
  return true;
}

function commandError(argv: string[], io: CommandIO, code: string, message: string): void {
  if (argv.includes("--json"))
    io.stdout(
      JSON.stringify({ ok: false, diagnostics: [{ code, severity: "error", message }] }, null, 2),
    );
  else io.stderr(message);
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
      commandError(
        argv,
        io,
        "CLI_USAGE",
        argv.includes("--json") ? "Invalid command arguments." : err.message,
      );
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
    commandError(
      argv,
      io,
      "LINT_IO",
      argv.includes("--json") ? "Lint paths could not be read." : `flightplan lint: ${detail}`,
    );
    return { exitCode: EXIT.usage };
  }

  if (multi.results.length === 0) {
    commandError(
      argv,
      io,
      "LINT_NO_FILES",
      "flightplan lint: no TOML files matched the given path(s).",
    );
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
      commandError(
        argv,
        io,
        "CLI_USAGE",
        argv.includes("--json") ? "Invalid command arguments." : err.message,
      );
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
  let inputs: InputValues | undefined;
  try {
    const loaded = await loadFlowFile(flowPath, io.fs);
    inputs = await readCliInputs(args, loaded.flow, io);
    const layers: Config[] = [];
    if (loaded.flow.config) layers.push(loaded.flow.config);
    // The flow-local [run] budgets override config.run (replaced wholesale by resolveConfig).
    if (loaded.flow.run) layers.push({ run: loaded.flow.run });
    if (args.session !== null)
      layers.push({
        connect: {
          mode: "session",
          session_ref: args.session,
          target_policy: args.targetId !== null ? "exact" : "selected",
          ...(args.targetId !== null ? { target_id: args.targetId } : {}),
        },
      });
    config = resolveConfigWithDefaults(layers);
  } catch (err) {
    if (inputError(err, args, io)) return { exitCode: EXIT.usage };
    const detail = err instanceof Error ? err.message : String(err);
    commandError(
      argv,
      io,
      err instanceof InvocationError ? err.code : "RUN_UNAVAILABLE",
      argv.includes("--json")
        ? err instanceof InvocationError
          ? err.code
          : "Recipe could not be loaded or executed."
        : `flightplan run: ${detail}`,
    );
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
  if (inputs !== undefined) runOpts.inputs = inputs;
  if (args.idempotencyKey !== null) {
    runOpts.idempotencyKey = args.idempotencyKey;
    if (io.invocationStore) runOpts.invocationStore = io.invocationStore;
  }
  if (args.frozen) runOpts.frozen = true;
  if (args.noLockWrite) runOpts.noLockWrite = true;
  if (args.lock !== null) runOpts.lockPath = resolve(io.cwd, args.lock);
  if (args.from !== null) runOpts.fromStep = args.from;
  if (args.to !== null) runOpts.toStep = args.to;
  if (args.json) runOpts.json = true;
  if (args.startTier !== null) runOpts.startTier = args.startTier;
  const namedSession =
    args.session !== null
      ? namedSessionDriverFactory(io.namedSessionBorrower ?? nativeNamedSessionBorrower, {
          actionTimeoutMs: config.timeouts.action_ms,
          navTimeoutMs: config.timeouts.nav_ms,
          providerEnv: io.env,
        })
      : undefined;
  if (namedSession) {
    runOpts.driverFactory = namedSession.factory;
    runOpts.sessionHandback = namedSession.handback;
  } else if (io.driverFactory !== undefined) runOpts.driverFactory = io.driverFactory;
  if (io.aiRuntimeFactory !== undefined) runOpts.aiRuntimeFactory = io.aiRuntimeFactory;
  if (io.signal !== undefined) runOpts.signal = io.signal;
  if (io.timeoutMs !== undefined) runOpts.timeoutMs = io.timeoutMs;
  runOpts.onWarn = io.stderr;

  let result: Awaited<ReturnType<typeof runFlow>>;
  try {
    result = await runFlow(runOpts);
  } catch (err) {
    if (err instanceof RunInterruptedError) {
      commandError(argv, io, err.code, `flightplan run: ${err.message}`);
      return { exitCode: err.code === "RUN_TIMEOUT" ? EXIT.deadline : EXIT.cancelled };
    }
    if (err && typeof err === "object" && "runResult" in err) {
      const preserved = err.runResult as Awaited<ReturnType<typeof runFlow>>;
      if (args.json && preserved?.summary) io.stdout(JSON.stringify(preserved.summary, null, 2));
      io.stderr("flightplan run: driver cleanup or session handback was not confirmed");
      return { exitCode: EXIT.usage };
    }
    // A throw escaping runFlow is an infra error (runFlow itself never throws for flow failures).
    if (inputError(err, args, io)) return { exitCode: EXIT.usage };
    const detail = err instanceof Error ? err.message : String(err);
    commandError(
      argv,
      io,
      err instanceof InvocationError ? err.code : "RUN_UNAVAILABLE",
      argv.includes("--json")
        ? err instanceof InvocationError
          ? err.code
          : "Recipe could not be loaded or executed."
        : `flightplan run: ${detail}`,
    );
    return { exitCode: EXIT.usage };
  }

  if (args.json) {
    io.stdout(JSON.stringify(result.summary, null, 2));
  } else {
    io.stdout(formatRunSummary(result.summary));
    if (result.summary.verdict === "error" && result.summary.error) {
      io.stderr(`Error: ${result.summary.error}`);
    }
  }
  return { exitCode: result.exitCode };
}

/** Offline catalogue command shared by native and portable hosts. */
export async function executeDiscovery(
  argv: string[],
  io: CommandIO,
): Promise<{ exitCode: number }> {
  try {
    const args = parseArgs(argv);
    validateCommandArgs(args);
    const result = await executeCatalogue(args.positionals, io, args.command === "describe");
    io.stdout(JSON.stringify(result, null, 2));
    return { exitCode: result.diagnostics.length ? EXIT.failed : EXIT.ok };
  } catch {
    commandError(
      argv,
      io,
      "DISCOVERY_UNAVAILABLE",
      "flightplan discovery: invalid arguments or unreadable path",
    );
    return { exitCode: EXIT.usage };
  }
}

/** Current-page inspection. Explicit named borrowing is required for browser observations. */
export async function executeCheck(argv: string[], io: CommandIO): Promise<{ exitCode: number }> {
  let driver: import("../driver/types.ts").Driver | undefined;
  try {
    const args = parseArgs(argv);
    validateCommandArgs(args);
    const flowPath = resolve(io.cwd, args.positionals[0]!);
    const loaded = await loadFlowFile(flowPath, io.fs);
    const inputs = await readCliInputs(args, loaded.flow, io);
    // Binding and dependency validation precede connection acquisition.
    const initial = await checkFlow({ flowPath, inputs, env: io.env, fs: io.fs });
    if (
      initial.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
      initial.items.some((item) => item.status === "failed")
    ) {
      io.stdout(JSON.stringify(initial, null, 2));
      return { exitCode: EXIT.failed };
    }
    if (args.session !== null) {
      const connection = {
        mode: "session" as const,
        session_ref: args.session,
        target_policy: args.targetId ? ("exact" as const) : ("selected" as const),
        ...(args.targetId ? { target_id: args.targetId } : {}),
      };
      const adapter = namedSessionDriverFactory(
        io.namedSessionBorrower ?? nativeNamedSessionBorrower,
        { providerEnv: io.env },
      );
      driver = adapter.factory(connection, { signal: io.signal ?? new AbortController().signal });
      await driver.connect(connection);
    }
    const report = driver
      ? await checkFlow({ flowPath, inputs, env: io.env, fs: io.fs, driver })
      : initial;
    if (driver?.teardown) {
      const acquired = driver;
      driver = undefined;
      await acquired.teardown();
    }
    io.stdout(JSON.stringify(report, null, 2));
    return { exitCode: report.ok ? EXIT.ok : EXIT.failed };
  } catch (error) {
    if (error instanceof InputBindingError && argv.includes("--json")) {
      io.stdout(
        JSON.stringify(
          {
            ok: false,
            diagnostics: error.issues.map((issue) => ({ ...issue, severity: "error" })),
          },
          null,
          2,
        ),
      );
    } else
      commandError(
        argv,
        io,
        "CHECK_UNAVAILABLE",
        error instanceof InputBindingError
          ? error.message
          : "flightplan check: inspection unavailable; no action was dispatched",
      );
    return { exitCode: EXIT.usage };
  } finally {
    if (driver?.teardown)
      await driver
        .teardown()
        .catch(() => io.stderr("flightplan check: session cleanup was not confirmed"));
  }
}
