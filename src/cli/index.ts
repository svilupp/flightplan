#!/usr/bin/env node

// Flightplan CLI shell.
//
// Node process wiring ONLY: `process.argv`/`process.env`/`process.cwd()`, `console.log`/
// `console.error`, `process.exit`, and the `nodeFileSystem` adapter. Argument parsing,
// validation, and the `lint`/`run` command bodies live in the process-free `./commands.ts`
// (shared with the shell entry) — this file's job is only to build the `CommandIO`
// and translate `{ exitCode }` into `process.exit`.
//
// `explain`/`report`/`sweep`/`migrate-effects` stay Node-only and are implemented inline/in
// their own sibling modules — they are out of scope for the worker entry.

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeFileSystem } from "../adapters/node/index.ts";
import { loadFlowFile } from "../flow/index.ts";
import {
  CliUsageError,
  type CommandIO,
  EXIT,
  executeLint,
  executeRun,
  type ParsedArgs,
  parseArgs,
  printUsage,
  validateCommandArgs,
} from "./commands.ts";
import { runExplain } from "./explain.ts";
import { runReport } from "./report.ts";
import { runSweep } from "./sweep.ts";

export {
  CliUsageError,
  COMMANDS,
  type Command,
  type CommandIO,
  executeLint,
  executeRun,
  formatRunSummary,
  type ParsedArgs,
  parseArgs,
  USAGE,
  validateCommandArgs,
} from "./commands.ts";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

export function printUsageToStderr(): void {
  printUsage((s) => console.error(s));
}
export { printUsage };

/** Build the `CommandIO` the native CLI feeds to `executeLint`/`executeRun`. */
function nodeCommandIO(): CommandIO {
  return {
    fs: nodeFileSystem,
    cwd: process.cwd(),
    env: process.env,
    stdout: (text: string) => console.log(text),
    stderr: (text: string) => console.error(text),
  };
}

/**
 * Review-only effect migration aid. It prints suggestions and intentionally never rewrites the
 * flow or its lock; a human must choose observe/idempotent/at_most_once and add postconditions.
 */
export async function runMigrateEffects(args: ParsedArgs): Promise<number> {
  const flowPath = args.positionals[0];
  if (!flowPath) {
    console.error("flightplan migrate-effects: expected a flow file path.");
    return EXIT.usage;
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
    return EXIT.ok;
  } catch (err) {
    console.error(
      `flightplan migrate-effects: ${err instanceof Error ? err.message : String(err)}`,
    );
    return EXIT.usage;
  }
}

async function dispatch(argv: string[], args: ParsedArgs): Promise<number> {
  switch (args.command) {
    case "lint":
      return (await executeLint(argv, nodeCommandIO())).exitCode;
    case "run":
      return (await executeRun(argv, nodeCommandIO())).exitCode;
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
      printUsageToStderr();
      return EXIT.usage;
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
      printUsageToStderr();
      return err.exitCode;
    }
    throw err;
  }

  if (args.help) {
    printUsage((s) => console.log(s));
    return EXIT.ok;
  }
  if (args.version) {
    console.log(pkg.version);
    return EXIT.ok;
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

  return dispatch(argv, args);
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
