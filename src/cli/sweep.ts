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
// Deliberately thin: this module does not touch `runner/` or `metrics/` internals. It reuses the
// SAME in-process `runFlow` entrypoint the `run` command calls (no subprocess spawning), and the
// SAME flow-path expansion (`expandPaths`) the `lint` command uses to enumerate flow files.
// `--trials`/`--compare-baseline` are parsed by the shared `parseArgs` in `./index.ts`.
//
// Error handling: a single flow/trial/arm throwing is caught, logged as a warning with the flow
// id + arm + trial number + error message, and does not stop the sweep. The exit code follows the
// same passed/not-passed convention as `run`: 0 when every run in the sweep passed, 1 when at
// least one run did not pass (failed/error/inconclusive) or threw, 2 on a usage error (no input).

import { isAbsolute, join, resolve } from "node:path";

import { resolveConfigWithDefaults } from "../config/index.ts";
import type { Config, ResolvedConfig } from "../config/index.ts";
import { loadFlowFile } from "../flow/index.ts";
import { expandPaths } from "../lint/index.ts";
import { runFlow, type RunOptions } from "../runner/index.ts";
import type { ParsedArgs } from "./index.ts";

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
  /** Present when the run threw (an infra error, not a flow failure). */
  error?: string;
}

/** The directory a given sweep unit's run artifacts are written to: `<campaign>/<flowId>/<arm>`. */
export function sweepUnitOutDir(campaignDir: string, unit: Pick<SweepUnit, "flowId" | "arm">): string {
  return join(campaignDir, unit.flowId, unit.arm);
}

/**
 * Build the full cross-product of (flow x arm x trial) for a sweep. One "tiered" unit per trial
 * always; one additional "baseline" (`--start-tier l3`) unit per trial when `compareBaseline` is
 * set. Trial numbers are 1-indexed.
 */
export function planSweep(
  flowPaths: string[],
  flowIds: string[],
  trials: number,
  compareBaseline: boolean,
): SweepUnit[] {
  const units: SweepUnit[] = [];
  for (let f = 0; f < flowPaths.length; f++) {
    const flowPath = flowPaths[f];
    const flowId = flowIds[f];
    if (flowPath === undefined || flowId === undefined) continue;
    const arms: SweepArm[] = compareBaseline ? ["tiered", "baseline"] : ["tiered"];
    for (const arm of arms) {
      for (let trial = 1; trial <= trials; trial++) {
        units.push({ flowPath, flowId, arm, trial });
      }
    }
  }
  return units;
}

/**
 * Run one sweep unit through the same `runFlow` entrypoint `flightplan run` uses. Never throws:
 * infra errors are caught and folded into the returned {@link SweepUnitResult}.
 */
export async function runSweepUnit(
  campaignDir: string,
  unit: SweepUnit,
  baseArgs: Pick<ParsedArgs, "frozen" | "noLockWrite" | "lock">,
  runFlowFn: (opts: RunOptions) => Promise<{ exitCode: number }> = runFlow,
): Promise<SweepUnitResult> {
  try {
    const loaded = await loadFlowFile(unit.flowPath);
    const layers: Config[] = [];
    if (loaded.flow.config) layers.push(loaded.flow.config);
    if (loaded.flow.run) layers.push({ run: loaded.flow.run });
    const config: ResolvedConfig = resolveConfigWithDefaults(layers);

    const runOpts: RunOptions = {
      flowPath: unit.flowPath,
      config,
      out: sweepUnitOutDir(campaignDir, unit),
      runId: String(unit.trial),
    };
    if (baseArgs.frozen) runOpts.frozen = true;
    if (baseArgs.noLockWrite) runOpts.noLockWrite = true;
    if (baseArgs.lock !== null) runOpts.lockPath = baseArgs.lock;
    if (unit.arm === "baseline") runOpts.startTier = "L3";

    const result = await runFlowFn(runOpts);
    return { ...unit, ok: result.exitCode === 0, exitCode: result.exitCode };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ...unit, ok: false, error: detail };
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
 * 2 on a usage error (no flows path, or no `.toml` flows found).
 */
export async function runSweep(
  args: ParsedArgs,
  runFlowFn: (opts: RunOptions) => Promise<{ exitCode: number }> = runFlow,
): Promise<number> {
  const flowsPath = args.positionals[0];
  if (flowsPath === undefined) {
    console.error("flightplan sweep: expected a flows directory (or glob).");
    return 2;
  }
  const trials = args.trials ?? 1;

  let flowPaths: string[];
  try {
    flowPaths = await expandPaths([flowsPath]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`flightplan sweep: ${detail}`);
    return 2;
  }
  if (flowPaths.length === 0) {
    console.error(`flightplan sweep: no .toml flow files matched ${JSON.stringify(flowsPath)}.`);
    return 2;
  }

  const flowIds: string[] = [];
  for (const p of flowPaths) {
    try {
      const loaded = await loadFlowFile(p);
      flowIds.push(loaded.flow.id);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`flightplan sweep: failed to load ${p}: ${detail}`);
      return 2;
    }
  }

  const campaignDir = args.out !== null ? args.out : join(".flightplan-runs", `sweep-${Date.now()}`);
  const absCampaignDir = isAbsolute(campaignDir) ? campaignDir : resolve(process.cwd(), campaignDir);

  const units = planSweep(flowPaths, flowIds, trials, args.compareBaseline);
  const results: SweepUnitResult[] = [];
  for (const unit of units) {
    const result = await runSweepUnit(absCampaignDir, unit, args, runFlowFn);
    results.push(result);
    if (result.ok) {
      console.log(`[ok]   ${unitLabel(unit)}`);
    } else {
      const reason = result.error ?? `exit ${result.exitCode}`;
      console.warn(`[warn] ${unitLabel(unit)} did not pass — ${reason}`);
    }
  }

  const passCount = results.filter((r) => r.ok).length;
  const failCount = results.length - passCount;
  console.log("");
  console.log(`Sweep complete: ${passCount} passed, ${failCount} not-passed of ${results.length} runs.`);
  console.log(`Campaign dir: ${absCampaignDir}`);
  console.log(`Run \`flightplan report ${absCampaignDir}\` to aggregate the results.`);

  return failCount === 0 ? 0 : 1;
}
