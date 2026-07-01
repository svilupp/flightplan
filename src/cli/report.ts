// Flightplan — `flightplan report <run-dir>... [--json]` command.
//
// The user-facing surface for the offline campaign-metrics harness (`src/metrics/`). It loads one
// OR many completed run dirs (each via `loadRun`, REUSED from `cli/explain.ts`), folds them into
// the campaign exit-criteria metrics (`aggregateCampaign`), and prints a human-readable + JSON
// campaign summary: tier histogram, L0/L1 hit-rates + deterministic share + escalation rate,
// cost/pass + max-run + per-role spend, drift-heal success, latency p50/p95, the per-fixture
// expected-vs-observed tier matrix, false-positive/negative flags, the cost-model projection
// (projected vs actual), and the lock write-policy cross-check. The three campaign exit criteria
// (deterministic majority, cost < $0.01/pass, locks stable) are rendered as obvious PASS/FAIL.
//
// This module OWNS only the CLI rendering. It consumes `src/metrics/` as-is and reuses
// `cli/explain.ts`'s `loadRun` (imported, never reimplemented). Canonical reference: PLAN.md §6/§7
// (escalation matrix + cost ladder) and the Phase 6 exit criteria.
//
// Resilience contract (mirrors `explain`):
//   - One or more positionals, each a run dir OR a `run.jsonl` path. A directory that is itself a
//     campaign root (holds many run dirs but no `run.jsonl`) is expanded to its child run dirs.
//   - A missing/malformed run dir → a clear error to stderr + exit 2, NEVER a stack trace.
//   - `report` returns 0 whenever it can produce a report; it reports ON runs, it does not inherit
//     their verdicts.

import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { RUN_FILES } from "../artifacts/index.ts";
import type { LadderTier } from "../artifacts/index.ts";
import { resolveRegistry } from "../ai/registry.ts";
import {
  CAMPAIGN_EXPECTED_TIERS,
  aggregateCampaign,
  checkLockStability,
  projectCampaignCost,
} from "../metrics/index.ts";
import type { CampaignMetrics, CostModelResult, StabilityResult } from "../metrics/index.ts";
import { ExplainError, loadRun } from "./explain.ts";
import type { LoadedRun } from "./explain.ts";
import type { ParsedArgs } from "./index.ts";

// ---------------------------------------------------------------------------
// Input expansion + loading
// ---------------------------------------------------------------------------

const TIERS: readonly LadderTier[] = ["L0", "L1", "L2", "L3", "L4"];

async function statKind(p: string): Promise<"file" | "dir" | "missing"> {
  try {
    const s = await stat(p);
    return s.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

async function hasRunLog(dir: string): Promise<boolean> {
  return (await statKind(join(dir, RUN_FILES.run))) === "file";
}

/**
 * Recursively find every descendant directory of `dir` that holds a `run.jsonl` (a leaf run
 * dir), stopping the descent at each leaf (a run dir's own subdirectories — `screenshots/`,
 * `proposed-patches/` — are never themselves run dirs, so there's no need to look inside them).
 * This walks arbitrarily deep, so both a flat campaign root (`<root>/<run-id>/run.jsonl`) and a
 * nested one (e.g. `flightplan sweep`'s `<root>/<flow-id>/<arm>/<trial-n>/run.jsonl`) resolve to
 * the same flat list of leaf run dirs.
 */
async function findRunDirs(dir: string): Promise<string[]> {
  if (await hasRunLog(dir)) return [dir];
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    found.push(...(await findRunDirs(join(dir, entry.name))));
  }
  found.sort();
  return found;
}

/**
 * Expand the positional inputs into a flat, ordered list of run-dir / `run.jsonl` targets that
 * {@link loadRun} can consume. A positional is passed through unchanged when it is a `run.jsonl`
 * file, a run directory (one that holds a `run.jsonl`), or missing (so `loadRun` produces the
 * canonical clear error). A directory that holds NO `run.jsonl` of its own is treated as a
 * campaign root: it is walked recursively (see {@link findRunDirs}) for descendant directories
 * that DO hold a `run.jsonl`, which are sorted and folded in. This lets `flightplan report
 * .flightplan-runs` report on the whole committed campaign, AND lets it consume a `flightplan
 * sweep` campaign dir's nested `<flow-id>/<arm>/<trial-n>/` layout without modification.
 */
export async function expandRunInputs(inputs: string[]): Promise<string[]> {
  const targets: string[] = [];
  for (const input of inputs) {
    const abs = isAbsolute(input) ? input : resolve(process.cwd(), input);
    const kind = await statKind(abs);

    // Missing / a file / a real run dir → pass through (loadRun handles each, incl. the error).
    if (kind !== "dir" || (await hasRunLog(abs))) {
      targets.push(input);
      continue;
    }

    // A directory with no run.jsonl of its own → a campaign root; expand recursively.
    const childRunDirs = await findRunDirs(abs);
    if (childRunDirs.length > 0) {
      targets.push(...childRunDirs);
    } else {
      // Neither a run dir nor a campaign root → let loadRun throw the canonical clear error.
      targets.push(input);
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Report assembly — fold loaded runs into the campaign metrics + projection + stability
// ---------------------------------------------------------------------------

/** Per-run lock write-policy cross-check (Unit D), keyed back to the run it came from. */
export interface RunLockStability {
  runId: string;
  stability: StabilityResult;
}

/** The three Phase 6 campaign exit criteria, each with a pass/fail verdict for obvious rendering. */
export interface ExitCriteria {
  /** Deterministic (L0+L1) share is the majority of resolving steps. */
  deterministicMajority: { pass: boolean; share: number };
  /** Cost per pass is under the ceiling (default $0.01 — "well under a cent per pass"). */
  costPerPass: { pass: boolean; value: number; ceilingUsd: number };
  /** No lock-write-policy violation across the campaign (offline write-policy cross-check). */
  locksStable: { pass: boolean };
  /** All three criteria hold. */
  allPass: boolean;
}

/** Everything the text + JSON renderers consume — the campaign metrics plus the two side analyses. */
export interface ReportData {
  campaign: CampaignMetrics;
  projection: CostModelResult;
  lockStability: { overallStable: boolean; perRun: RunLockStability[] };
  exitCriteria: ExitCriteria;
}

/** Fold the loaded runs into the full report payload. Pure: no IO. */
export function buildReportData(loadedRuns: LoadedRun[]): ReportData {
  const campaign = aggregateCampaign(loadedRuns, { expectedTiers: CAMPAIGN_EXPECTED_TIERS });
  const projection = projectCampaignCost(CAMPAIGN_EXPECTED_TIERS, resolveRegistry());

  // Lock byte-stability needs before/after snapshots that the run artifacts do not carry (the lock
  // lives next to the flow, not in the run dir). What IS derivable offline is the write-policy
  // cross-check: a clean green run (drift_count==0 ∧ passed) must NOT write the lock. We surface
  // that per run; byte-level stability across repeated runs is a LIVE-runbook check.
  const perRun: RunLockStability[] = campaign.runs.map((r) => ({
    runId: r.runId,
    stability: checkLockStability({
      before: null,
      after: null,
      driftCount: r.driftCount,
      verdict: r.verdict,
    }),
  }));
  const overallStable = perRun.every((p) => !p.stability.contractViolation);

  const exitCriteria: ExitCriteria = {
    deterministicMajority: {
      pass: campaign.deterministicShare > 0.5,
      share: campaign.deterministicShare,
    },
    costPerPass: {
      pass: campaign.costPerPass < projection.costPerPassCeilingUsd,
      value: campaign.costPerPass,
      ceilingUsd: projection.costPerPassCeilingUsd,
    },
    locksStable: { pass: overallStable },
    allPass: false,
  };
  exitCriteria.allPass =
    exitCriteria.deterministicMajority.pass &&
    exitCriteria.costPerPass.pass &&
    exitCriteria.locksStable.pass;

  return {
    campaign,
    projection,
    lockStability: { overallStable, perRun },
    exitCriteria,
  };
}

// ---------------------------------------------------------------------------
// Rendering — human text
// ---------------------------------------------------------------------------

function usd(n: number): string {
  return `$${n.toFixed(6)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function marker(pass: boolean): string {
  return pass ? "[PASS]" : "[FAIL]";
}

/** Render the full human-readable campaign report. Pure: no IO. */
export function formatReport(data: ReportData): string {
  const { campaign: c, projection: proj, lockStability, exitCriteria: ex } = data;
  const out: string[] = [];

  out.push("=== Flightplan campaign report ===");
  const otherCount = c.runCount - c.passCount;
  out.push(
    `Runs:     ${c.runCount}   (${c.passCount} passed` +
      (otherCount > 0 ? `, ${otherCount} not-passed)` : ")"),
  );

  // Exit criteria first — the headline pass/fail for the whole campaign.
  out.push("");
  out.push(`Exit criteria: ${marker(ex.allPass)} overall`);
  out.push(
    `  ${marker(ex.deterministicMajority.pass)} deterministic majority ` +
      `(L0+L1 share ${pct(ex.deterministicMajority.share)}, need > 50%)`,
  );
  out.push(
    `  ${marker(ex.costPerPass.pass)} cost per pass ${usd(ex.costPerPass.value)} ` +
      `(ceiling ${usd(ex.costPerPass.ceilingUsd)})`,
  );
  out.push(
    `  ${marker(ex.locksStable.pass)} locks stable ` +
      `(write-policy cross-check; byte-stability is a live-runbook check)`,
  );

  // Tier histogram (R resolving steps).
  out.push("");
  out.push(`Tier histogram (${c.histogram.total} resolving steps):`);
  if (c.histogram.total === 0) {
    out.push("  (no resolving steps — every step was a goto/wait or no tier was recorded)");
  } else {
    for (const t of TIERS) {
      const n = c.histogram[t];
      out.push(`  ${t}  ${String(n).padStart(4)}  (${pct(n / c.histogram.total)})`);
    }
  }

  // Resolution rates.
  out.push("");
  out.push("Resolution rates (of resolving steps):");
  out.push(`  L0 hit:          ${pct(c.l0HitRate)}`);
  out.push(`  L1 hit:          ${pct(c.l1HitRate)}`);
  out.push(`  deterministic:   ${pct(c.deterministicShare)}  (L0+L1, free in-process)`);
  out.push(`  escalation:      ${pct(c.escalationRate)}  (L2+L3+L4, model tiers)`);
  out.push(`  L2 / L3 / L4:    ${pct(c.l2Rate)} / ${pct(c.l3Rate)} / ${pct(c.l4Rate)}`);

  // Cost.
  out.push("");
  out.push("Cost:");
  out.push(`  total:           ${usd(c.totalCostUsd)}`);
  out.push(`  per pass:        ${usd(c.costPerPass)}`);
  out.push(`  max single run:  ${usd(c.maxRunCostUsd)}`);
  const roles = Object.entries(c.perRoleCost);
  if (roles.length === 0) {
    out.push("  per-role:        none (no model calls)");
  } else {
    out.push("  per-role:");
    for (const [role, spend] of roles) {
      if (spend === undefined) continue;
      const callWord = spend.calls === 1 ? "call" : "calls";
      out.push(`    ${role.padEnd(10)} ${spend.calls} ${callWord}  ${usd(spend.cost_usd)}`);
    }
  }

  // Drift / self-healing.
  out.push("");
  out.push("Drift / self-healing:");
  out.push(`  drift runs:        ${c.driftRuns} of ${c.runCount}  (drift_count total ${c.totalDriftCount})`);
  out.push(`  healed steps:      ${c.totalHealedSteps}`);
  out.push(
    `  heal success:      ${c.driftHealSuccessRuns} of ${c.driftRuns}  ` +
      `(${pct(c.driftHealSuccessRate)})`,
  );

  // Latency.
  out.push("");
  out.push("Latency (ms):");
  out.push(
    `  step p50/p95:    ${c.stepLatency.p50} / ${c.stepLatency.p95}  ` +
      `(n=${c.stepLatency.count})`,
  );
  const tierLatLines: string[] = [];
  for (const t of TIERS) {
    const l = c.perTierLatency[t];
    if (l !== undefined) tierLatLines.push(`  ${t} p50/p95:      ${l.p50} / ${l.p95}  (n=${l.count})`);
  }
  if (tierLatLines.length > 0) out.push(...tierLatLines);

  // Cost-model projection vs actual.
  out.push("");
  out.push("Cost projection (model vs actual):");
  out.push(
    `  projected:       ${usd(proj.campaignUsd)} campaign  ·  ` +
      `${usd(proj.costPerPass)}/pass  ·  ${usd(proj.maxRunCostUsd)} max run`,
  );
  out.push(`  actual:          ${usd(c.totalCostUsd)} campaign  ·  ${usd(c.costPerPass)}/pass  ·  ${usd(c.maxRunCostUsd)} max run`);
  out.push(`  within budget:   ${marker(proj.withinBudget)} (projection over the §6 expected-tier table)`);

  // Lock write-policy cross-check.
  out.push("");
  out.push(`Lock stability: ${marker(lockStability.overallStable)} no write-policy violations`);
  for (const { runId, stability } of lockStability.perRun) {
    const expect = stability.expectedNoWrite ? "no-write expected" : "write allowed (drift/verdict)";
    out.push(`  ${runId}: verdict=${stability.verdict} drift=${stability.driftCount} — ${expect}`);
  }

  // Per-fixture expected-vs-observed tier matrix.
  out.push("");
  out.push("Per-fixture matrix (expected vs observed tier):");
  if (c.perFixture.length === 0) {
    out.push("  (no runs matched the §6 expected-tier table)");
  } else {
    out.push(`  ${"fixture".padEnd(14)} ${"expected".padEnd(12)} ${"observed".padEnd(10)} hit  runs`);
    for (const f of c.perFixture) {
      const expected = f.expectedTiers.join("/");
      const observed = f.maxTierObserved ?? "-";
      out.push(
        `  ${f.fixture.padEnd(14)} ${expected.padEnd(12)} ${observed.padEnd(10)} ` +
          `${f.expectedTierHit ? "ok " : "MISS"} ${f.runs}`,
      );
    }
  }

  // Resolution-quality flags.
  out.push("");
  if (c.falsePositiveSteps.length === 0 && c.falseNegatives.length === 0) {
    out.push("Resolution quality: no false positives, no false negatives.");
  } else {
    out.push("Resolution quality:");
    if (c.falsePositiveSteps.length > 0) {
      out.push(`  false positives (ok step, failed assertion): ${c.falsePositiveSteps.length}`);
      for (const fp of c.falsePositiveSteps) out.push(`    ${fp.runId}: ${fp.stepId}`);
    }
    if (c.falseNegatives.length > 0) {
      out.push(`  false negatives (escalated past the matrix tier): ${c.falseNegatives.length}`);
      for (const fn of c.falseNegatives) {
        out.push(`    ${fn.runId} (${fn.flowId}): ${fn.stepId} reached ${fn.tier}`);
      }
    }
  }

  return out.join("\n");
}

/** Build the machine-readable campaign report (the `--json` surface). Pure: no IO. */
export function buildReportJson(data: ReportData): Record<string, unknown> {
  // Spread the full CampaignMetrics at the top level (so the payload is CampaignMetrics-shaped),
  // then attach the cost projection, the lock cross-check, and the exit-criteria verdicts.
  return {
    ...data.campaign,
    costProjection: data.projection,
    lockStability: data.lockStability,
    exitCriteria: data.exitCriteria,
  };
}

// ---------------------------------------------------------------------------
// Command entrypoint
// ---------------------------------------------------------------------------

/**
 * `flightplan report <run-dir>... [--json]` — load one or many completed run dirs, aggregate them
 * into the Phase 6 campaign metrics, and print a human-readable (default) or JSON (`--json`)
 * campaign summary. A positional may be a run directory, a `run.jsonl` path, or a campaign root
 * directory (expanded to its child run dirs).
 *
 * Exit code: 0 whenever a report can be produced (the runs' OWN verdicts are NOT this command's
 * exit code — `report` reports on runs, it does not inherit their verdicts); 2 on a usage error
 * (no path) or an IO/parse error (a missing or malformed run dir). A clear message is printed to
 * stderr, never a stack trace.
 */
export async function runReport(args: ParsedArgs): Promise<number> {
  if (args.positionals.length === 0) {
    console.error(
      "flightplan report: expected at least one run directory (or a campaign root / run.jsonl).",
    );
    return 2;
  }

  let loadedRuns: LoadedRun[];
  try {
    const targets = await expandRunInputs(args.positionals);
    loadedRuns = await Promise.all(targets.map((t) => loadRun(t)));
  } catch (err) {
    if (err instanceof ExplainError) {
      console.error(`flightplan report: ${err.message}`);
      return err.exitCode;
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`flightplan report: ${detail}`);
    return 2;
  }

  const data = buildReportData(loadedRuns);
  if (args.json) {
    console.log(JSON.stringify(buildReportJson(data), null, 2));
  } else {
    console.log(formatReport(data));
  }
  return 0;
}
