#!/usr/bin/env node

// Flightplan CLI shell.
//
// Phase 1 deliverable: a REAL command shell (arg parsing + dispatch) with `lint | run |
// explain` stubbed. Later phases drop real implementations into runLint/runRun/runExplain
// without touching the parser or dispatcher. See PLAN.md §2 (cli/) and §5 (Phase 1).
//
// No external arg-parsing dependency — the parser below is hand-rolled and exported so it
// can be unit-tested in isolation.

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunSummary } from "../artifacts/index.ts";
import type { Config, ResolvedConfig } from "../config/index.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import { loadFlowFile } from "../flow/index.ts";
import { formatHuman, formatJson, lintPaths } from "../lint/index.ts";
import { type RunOptions, runFlow } from "../runner/index.ts";
import { runExplain } from "./explain.ts";
import { runReport } from "./report.ts";
import { runSweep } from "./sweep.ts";

export const COMMANDS = ["lint", "run", "explain", "report", "sweep", "migrate-effects"] as const;
export type Command = (typeof COMMANDS)[number];

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

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
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "CliUsageError";
    this.exitCode = exitCode;
  }
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

/** Validate command-specific operands and flags after the shared parser has collected them. */
function validateCommandArgs(args: ParsedArgs): void {
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

const USAGE = `flightplan — TOML-defined browser-automation flow runner

Usage:
  flightplan <command> [file] [flags]

Commands:
  lint <flow.toml>      Validate a flow/config file against the linter rules
  run <flow.toml>       Execute a flow against a browser
  explain <run.jsonl>   Render a human-readable failure diagnosis for a run
  report <run-dir>...   Aggregate one or many runs into a campaign metrics report
  sweep <flows-dir>     Run N trials of every flow (tiered, +baseline) into a campaign dir
  migrate-effects <flow.toml>
                        Review-only effect suggestions; never edits flows or locks

Flags:
  --json                Emit machine-readable JSON (run-summary contract)
  --frozen              CI mode: heal at runtime, report drift, do not persist
  --no-lock-write       Suppress all lock writes
  --lock <path>         Override the lock file path
  -o, --out <dir>       Output directory for run artifacts
  --from <step>         Resume a run starting at the given step id (inclusive)
  --to <step>           Stop a run after the given step id (inclusive); combine with --from
                         to run a debugging slice
  --start-tier <tier>   Start ladder resolution at "l0" (default) or "l3" (AI-only vision
                         baseline: skips L0/L1, resolves every step via vision, falls through
                         to L4 on escalation — for fair comparison against the tiered resolver)
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

See the documentation in the repository for the full design. This project is under active development.`;

export function printUsage(write: (s: string) => void = (s) => console.log(s)): void {
  write(USAGE);
}

// --- Commands ----------------------------------------------------------------------------
// Each command returns the intended process exit code. `explain` lives in ./explain.ts; the
// dispatcher imports it. `run`/`lint` are implemented inline below.

/**
 * `flightplan lint <path...>` — lint one or more flow/config TOML files. A path may also be a
 * directory (expands to its `*.toml` children) or a glob (e.g. `examples/flows/*.toml`).
 *
 * Output: human-readable grouped-by-file report + a `N errors, M warnings` summary, or the
 * full LintResult set as JSON with `--json`.
 *
 * Exit code: 0 when there are no errors (warnings are allowed), 1 when any file has an error,
 * 2 for a usage error (no path given). Matches the scaffold's exit-code conventions.
 */
export async function runLint(args: ParsedArgs): Promise<number> {
  if (args.positionals.length === 0) {
    console.error("flightplan lint: expected at least one flow/config file (or directory/glob).");
    printUsage((s) => console.error(s));
    return 2;
  }

  let multi: Awaited<ReturnType<typeof lintPaths>>;
  try {
    multi = await lintPaths(args.positionals);
  } catch (err) {
    // IO/expansion failure (e.g. an unreadable glob root) → usage/IO error.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`flightplan lint: ${detail}`);
    return 2;
  }

  if (multi.results.length === 0) {
    console.error("flightplan lint: no TOML files matched the given path(s).");
    return 2;
  }

  if (args.json) {
    console.log(formatJson(multi));
  } else {
    console.log(formatHuman(multi));
  }

  return multi.ok ? 0 : 1;
}

/**
 * Review-only effect migration aid. It prints suggestions and intentionally never rewrites the
 * flow or its lock; a human must choose observe/idempotent/at_most_once and add postconditions.
 */
export async function runMigrateEffects(args: ParsedArgs): Promise<number> {
  const flowPath = args.positionals[0];
  if (!flowPath) {
    console.error("flightplan migrate-effects: expected a flow file path.");
    return 2;
  }
  try {
    const loaded = await loadFlowFile(flowPath);
    const suggestions = loaded.flow.steps.map((step) => {
      const effect = step.effect;
      const suggestion =
        effect ??
        (step.do === "wait" ||
        step.do === "assert" ||
        step.do === "switch_frame" ||
        step.do === "switch_to_main"
          ? "observe"
          : "review_required");
      return {
        step: step.id,
        do: step.do,
        current: effect ?? null,
        suggestion,
        retry: step.retry ?? null,
        note:
          suggestion === "review_required"
            ? "Choose the effect explicitly; migration never assumes idempotency."
            : "No file was changed.",
      };
    });
    const result = { file: loaded.path, source_hash: loaded.sourceHash, suggestions };
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Review-only effect suggestions for ${loaded.path}`);
      for (const item of suggestions) {
        console.log(
          `  ${item.step} (${item.do}): ${item.current ?? "unset"} -> ${item.suggestion}`,
        );
      }
      console.log("No flow or lock files were modified.");
    }
    return 0;
  } catch (err) {
    console.error(
      `flightplan migrate-effects: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }
}

/**
 * `flightplan run <flow.toml> [flags]` — execute a flow against a browser.
 *
 * Loads the flow to derive its resolved config (built-in defaults → flow `[config]` + `[run]`;
 * global/imported layers land in later phases), builds {@link RunOptions} from the parsed flags
 * (`-o/--out`→out, `--frozen`/`--no-lock-write`/`--lock`→pass-through, `--from`→fromStep,
 * `--to`→toStep, `--json`→json), and calls {@link runFlow}. Prints the RunSummary JSON under `--json`, else a
 * concise human summary. Exit code: 0 passed · 1 failed · 2 usage/IO/connect error · 3
 * inconclusive (verdict→code mapping owned by the runner; see `RunResult.exitCode`).
 */
export async function runRun(args: ParsedArgs): Promise<number> {
  const flowPath = args.positionals[0];
  if (flowPath === undefined) {
    console.error("flightplan run: expected a flow file path.");
    printUsage((s) => console.error(s));
    return 2;
  }

  // Resolve the config from the ENTRY flow's own layers (built-in → flow [config] → flow [run]).
  // Only the entry flow contributes config here — imported flows supply steps, never config,
  // so the entry flow's [connect] (or the attach-localhost:9222 default) is authoritative and
  // imported flows' [connect] blocks are intentionally ignored.
  let config: ResolvedConfig;
  try {
    const loaded = await loadFlowFile(flowPath);
    const layers: Config[] = [];
    if (loaded.flow.config) layers.push(loaded.flow.config);
    // The flow-local [run] budgets override config.run (replaced wholesale by resolveConfig).
    if (loaded.flow.run) layers.push({ run: loaded.flow.run });
    config = resolveConfigWithDefaults(layers);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`flightplan run: ${detail}`);
    return 2;
  }

  const runOpts: RunOptions = { flowPath, config };
  if (args.out !== null) runOpts.out = args.out;
  if (args.frozen) runOpts.frozen = true;
  if (args.noLockWrite) runOpts.noLockWrite = true;
  if (args.lock !== null) runOpts.lockPath = args.lock;
  if (args.from !== null) runOpts.fromStep = args.from;
  if (args.to !== null) runOpts.toStep = args.to;
  if (args.json) runOpts.json = true;
  if (args.startTier !== null) runOpts.startTier = args.startTier;

  let result: Awaited<ReturnType<typeof runFlow>>;
  try {
    result = await runFlow(runOpts);
  } catch (err) {
    // A throw escaping runFlow is an infra error (runFlow itself never throws for flow failures).
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`flightplan run: ${detail}`);
    return 2;
  }

  if (args.json) {
    console.log(JSON.stringify(result.summary, null, 2));
  } else {
    console.log(formatRunSummary(result.summary));
  }
  return result.exitCode;
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

async function dispatch(args: ParsedArgs): Promise<number> {
  switch (args.command) {
    case "lint":
      return runLint(args);
    case "run":
      return runRun(args);
    case "explain":
      return runExplain(args);
    case "report":
      return runReport(args);
    case "sweep":
      return runSweep(args);
    case "migrate-effects":
      return runMigrateEffects(args);
    case null:
      // No command and no help/version handled upstream → show usage as an error.
      printUsage((s) => console.error(s));
      return 2;
  }
}

/** Entrypoint. Resolves to the process exit code; never calls process.exit itself. */
export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      console.error(err.message);
      printUsage((s) => console.error(s));
      return err.exitCode;
    }
    throw err;
  }

  if (args.help) {
    printUsage();
    return 0;
  }
  if (args.version) {
    console.log(pkg.version);
    return 0;
  }

  try {
    validateCommandArgs(args);
  } catch (err) {
    if (err instanceof CliUsageError) {
      console.error(err.message);
      return err.exitCode;
    }
    throw err;
  }

  return dispatch(args);
}

// Only run when invoked directly (not when imported by a test). This explicit Node-compatible
// check works for both `node dist/cli/index.js` and Bun's source/test invocation.
const invokedPath = process.argv[1];
let invokedDirectly = false;
if (invokedPath !== undefined) {
  const modulePath = fileURLToPath(import.meta.url);
  try {
    // npm and pnpm expose bins through symlinks, so compare canonical paths rather than the
    // argv spelling. The fallback keeps direct relative-path invocation usable if the target
    // disappears between startup and this check.
    invokedDirectly = realpathSync(modulePath) === realpathSync(resolve(invokedPath));
  } catch {
    invokedDirectly = modulePath === resolve(invokedPath);
  }
}
if (invokedDirectly) {
  process.exit(await main(process.argv.slice(2)));
}
