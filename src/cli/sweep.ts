// Flightplan — `flightplan sweep <flows-dir-or-glob> [--trials N] [--compare-baseline] [-o <dir>]`.
//
// Orchestrates repeated `run` invocations across many flows and (optionally) two arms — the
// normal tiered ladder and the `--start-tier l3` "AI-only baseline" — writing each run's
// artifacts into `<campaign-dir>/<flow-id>/<arm>/<trial-n>/`. This is the "drive N runs across M
// fixtures x up-to-2 arms and organize their run-dirs" half described in
// docs/P6_IMPROVEMENT_PLAN.md §6; the aggregation half is already built (`flightplan report`,
// which already expands a directory-of-run-dirs "campaign root" — recursively, so this nested
// flow-id/arm/trial-n layout is consumed unmodified, see `expandRunInputs` in `report.ts`).
//
// Shared runner preparation validates every unit before dispatch. Execution uses runFlow,
// with the same input parser as run and path expansion as lint; trials remain sequential.
//
// Error handling: a single flow/trial/arm throwing is caught, logged as a warning with the flow
// id + arm + trial number + error message, and does not stop the sweep. The exit code follows the
// same passed/not-passed convention as `run`: 0 when every run in the sweep passed, 1 when at
// least one run did not pass (failed/error/inconclusive) or threw, 2 on a usage error (no input).

import { isAbsolute, join, resolve } from "node:path";
import { nodeFileSystem } from "../adapters/node/index.ts";
import { ExecutionPolicyError, executionPolicyIssues } from "../config/execution-policy.ts";
import type { Config, ResolvedConfig } from "../config/index.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import { loadFlowFile } from "../flow/index.ts";
import { InputBindingError } from "../flow/input.ts";
import { expandPaths } from "../lint/index.ts";
import { type RunOptions, runFlow } from "../runner/index.ts";
import { prepareRun } from "../runner/prepare.ts";
import { type CommandIO, type ParsedArgs, readCliInputs } from "./commands.ts";

/** The two arms a sweep can run each flow under. */
export type SweepArm = "tiered" | "baseline";

/** One planned (flow, arm, trial) unit of work — the full cross-product the sweep will execute. */
export interface SweepUnit {
  flowPath: string;
  flowId: string;
  arm: SweepArm;
  /** 1-indexed trial number. */
  trial: number;
}

/** The outcome of running one {@link SweepUnit}. */
export interface SweepUnitResult extends SweepUnit {
  ok: boolean;
  /** Present when the run completed (even if it did not pass). */
  exitCode?: number;
  /** Safe explanation of a preflight denial or preparation/runtime failure. */
  error?: string;
}

/** The directory a given sweep unit's run artifacts are written to: `<campaign>/<flowId>/<arm>`. */
export function sweepUnitOutDir(
  campaignDir: string,
  unit: Pick<SweepUnit, "flowId" | "arm">,
): string {
  return join(campaignDir, unit.flowId, unit.arm);
}

/** Keep arm/trial order stable while carrying each prepared flow's identity together. */
function planFlowTrials(
  flow: Pick<SweepUnit, "flowPath" | "flowId">,
  trials: number,
  compareBaseline: boolean,
): SweepUnit[] {
  const arms: SweepArm[] = compareBaseline ? ["tiered", "baseline"] : ["tiered"];
  const units: SweepUnit[] = [];
  for (const arm of arms) {
    for (let trial = 1; trial <= trials; trial++) units.push({ ...flow, arm, trial });
  }
  return units;
}

type SweepArgs = Pick<ParsedArgs, "frozen" | "noLockWrite" | "lock"> &
  Partial<Pick<ParsedArgs, "inputs" | "inputEnvs" | "inputsFile">>;
interface PreparedSweepFlow {
  readonly flowId: string;
  readonly options: RunOptions;
  readonly policyError?: string;
  readonly baselineError?: string;
}
function nativeIo(): CommandIO {
  return {
    fs: nodeFileSystem,
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
  };
}

async function prepareSweepFlow(
  flowPath: string,
  args: SweepArgs,
  io: CommandIO,
): Promise<PreparedSweepFlow> {
  const loaded = await loadFlowFile(flowPath, io.fs);
  const inputs = await readCliInputs(
    {
      inputs: args.inputs ?? [],
      inputEnvs: args.inputEnvs ?? [],
      inputsFile: args.inputsFile ?? null,
    },
    loaded.flow,
    io,
  );
  const layers: Config[] = [loaded.flow.config ?? {}];
  if (loaded.flow.run) layers.push({ run: loaded.flow.run });
  const config: ResolvedConfig = resolveConfigWithDefaults(layers);
  const options: RunOptions = {
    flowPath,
    config,
    ...(io.fs === nodeFileSystem ? {} : { fs: io.fs }),
    cwd: io.cwd,
    env: { ...io.env },
    inputs,
    frozen: args.frozen,
    noLockWrite: args.noLockWrite,
    onWarn: io.stderr,
    ...(args.lock !== null ? { lockPath: resolve(io.cwd, args.lock) } : {}),
    ...(io.driverFactory ? { driverFactory: io.driverFactory } : {}),
    ...(io.aiRuntimeFactory ? { aiRuntimeFactory: io.aiRuntimeFactory } : {}),
    ...(io.signal ? { signal: io.signal } : {}),
    ...(io.timeoutMs !== undefined ? { timeoutMs: io.timeoutMs } : {}),
  };
  options.flowSource = loaded.sourceText;
  const prepared = await prepareRun(options, io.fs, io.env);
  // Replay precisely the sources whose inputs/dependencies passed the campaign preflight.
  options.flowSources = prepared.sourceTexts;
  const baselineIssues = executionPolicyIssues(prepared.policy, config, [], { startTier: "L3" });
  return {
    flowId: loaded.flow.id,
    options,
    ...(prepared.policyIssues.length
      ? { policyError: new ExecutionPolicyError(prepared.policyIssues).message }
      : {}),
    ...(baselineIssues.length
      ? { baselineError: new ExecutionPolicyError(baselineIssues).message }
      : {}),
  };
}

async function executeSweepUnit(
  campaignDir: string,
  unit: SweepUnit,
  prepared: PreparedSweepFlow,
  runFlowFn: (opts: RunOptions) => Promise<{ exitCode: number }>,
): Promise<SweepUnitResult> {
  const error =
    prepared.policyError ?? (unit.arm === "baseline" ? prepared.baselineError : undefined);
  if (error) return { ...unit, ok: false, exitCode: 2, error };
  try {
    const result = await runFlowFn({
      ...prepared.options,
      out: sweepUnitOutDir(campaignDir, unit),
      runId: String(unit.trial),
      ...(unit.arm === "baseline" ? { startTier: "L3" } : {}),
    });
    return { ...unit, ok: result.exitCode === 0, exitCode: result.exitCode };
  } catch {
    // A thrown adapter error can contain bound secrets. Detailed redacted evidence belongs to the run.
    return { ...unit, ok: false, error: "Run could not complete; inspect its redacted artifacts." };
  }
}

/** Run one unit, translating preparation and runtime errors into a safe campaign result. */
export async function runSweepUnit(
  campaignDir: string,
  unit: SweepUnit,
  baseArgs: SweepArgs,
  runFlowFn: (opts: RunOptions) => Promise<{ exitCode: number }> = runFlow,
): Promise<SweepUnitResult> {
  try {
    return await executeSweepUnit(
      campaignDir,
      unit,
      await prepareSweepFlow(unit.flowPath, baseArgs, nativeIo()),
      runFlowFn,
    );
  } catch {
    return { ...unit, ok: false, error: "Flow inputs or dependencies could not be prepared." };
  }
}

/** Summary line for a single sweep unit result, used in both progress + final logging. */
function unitLabel(u: SweepUnit): string {
  return `${u.flowId}/${u.arm}/${u.trial}`;
}

/**
 * `flightplan sweep <flows-dir-or-glob> [--trials N] [--compare-baseline] [-o <campaign-dir>]` —
 * run N repeated trials of every flow under the given directory/glob, in the tiered arm and
 * (when `--compare-baseline` is set) the `--start-tier l3` baseline arm, writing each run's
 * artifacts into `<campaign-dir>/<flow-id>/<arm>/<trial-n>/`. Prints a pass/fail tally and points
 * the user at `flightplan report <campaign-dir>` to aggregate the results.
 *
 * Exit code: 0 when every run in the sweep passed, 1 when at least one run did not pass or threw,
 * 2 on a preparation error (missing flows, invalid bindings, or duplicate flow IDs).
 */
export async function runSweep(
  args: ParsedArgs,
  runFlowFn: (opts: RunOptions) => Promise<{ exitCode: number }> = runFlow,
  io: CommandIO = nativeIo(),
): Promise<number> {
  const flowsPath = args.positionals[0];
  if (flowsPath === undefined) {
    io.stderr("flightplan sweep: expected a flows directory (or glob).");
    return 2;
  }
  const trials = args.trials ?? 1;

  let flowPaths: string[];
  try {
    flowPaths = await expandPaths([flowsPath], { fs: io.fs, cwd: io.cwd });
  } catch (err) {
    const detail =
      err instanceof InputBindingError
        ? err.message
        : "Inputs or dependencies could not be prepared.";
    io.stderr(`flightplan sweep: ${detail}`);
    return 2;
  }
  if (flowPaths.length === 0) {
    io.stderr(`flightplan sweep: no .toml flow files matched ${JSON.stringify(flowsPath)}.`);
    return 2;
  }

  const pathsById = new Map<string, string>();
  const preparedFlows: PreparedSweepFlow[] = [];
  for (const p of flowPaths) {
    try {
      const prepared = await prepareSweepFlow(p, args, io);
      const artifactId = prepared.flowId.normalize("NFC").toLowerCase();
      if (
        !artifactId ||
        artifactId === "." ||
        artifactId === ".." ||
        artifactId === "sweep.json" ||
        /[/\\]/.test(artifactId) ||
        Array.from(artifactId).some((character) => character.charCodeAt(0) < 32) ||
        /[.\s]$/.test(artifactId)
      ) {
        io.stderr(
          `flightplan sweep: Flow id ${JSON.stringify(prepared.flowId)} cannot name a campaign artifact directory.`,
        );
        return 2;
      }
      const previousPath = pathsById.get(artifactId);
      if (previousPath !== undefined) {
        io.stderr(
          `flightplan sweep: Duplicate flow id ${JSON.stringify(prepared.flowId)} in ${previousPath} and ${p}; use unique IDs to keep run artifacts separate.`,
        );
        return 2;
      }
      pathsById.set(artifactId, p);
      preparedFlows.push(prepared);
    } catch (err) {
      const detail =
        err instanceof InputBindingError
          ? err.message
          : "Inputs or dependencies could not be prepared.";
      io.stderr(`flightplan sweep: failed to load ${p}: ${detail}`);
      return 2;
    }
  }

  const campaignDir =
    args.out !== null ? args.out : join(".flightplan-runs", `sweep-${Date.now()}`);
  const absCampaignDir = isAbsolute(campaignDir) ? campaignDir : resolve(io.cwd, campaignDir);
  try {
    const existing = await io.fs.stat(absCampaignDir);
    if (existing && (!existing.isDirectory || (await io.fs.readDir(absCampaignDir)).length > 0)) {
      io.stderr("flightplan sweep: Campaign output directory must be empty; choose a new -o path.");
      return 2;
    }
    await io.fs.mkdir(absCampaignDir, { recursive: true });
  } catch {
    io.stderr("flightplan sweep: Campaign output directory could not be prepared.");
    return 2;
  }

  const units = preparedFlows.flatMap((prepared) =>
    planFlowTrials(
      {
        flowPath: prepared.options.flowPath,
        flowId: prepared.flowId,
      },
      trials,
      args.compareBaseline,
    ).map((unit) => ({ unit, prepared })),
  );
  const results: SweepUnitResult[] = [];
  for (const { unit, prepared } of units) {
    const result = await executeSweepUnit(absCampaignDir, unit, prepared, runFlowFn);
    results.push(result);
    if (result.ok) {
      io.stdout(`[ok]   ${unitLabel(unit)}`);
    } else {
      const reason = result.error ?? `exit ${result.exitCode}`;
      io.stderr(`[warn] ${unitLabel(unit)} did not pass — ${reason}`);
    }
  }

  const passCount = results.filter((r) => r.ok).length;
  const failCount = results.length - passCount;
  await io.fs.writeTextFile(
    join(absCampaignDir, "sweep.json"),
    JSON.stringify(
      {
        passed: passCount,
        notPassed: failCount,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  io.stdout("");
  io.stdout(
    `Sweep complete: ${passCount} passed, ${failCount} not-passed of ${results.length} runs.`,
  );
  io.stdout(`Campaign dir: ${absCampaignDir}`);
  io.stdout(
    `sweep.json includes preflight failures; flightplan report ${absCampaignDir} aggregates executed runs only.`,
  );

  return failCount === 0 ? 0 : 1;
}
