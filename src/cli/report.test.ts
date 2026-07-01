// Flightplan — `flightplan report` tests (offline).
//
// Drives the report command over the committed test inputs the metrics harness already ships:
// the 4 REAL `.flightplan-runs/` dirs (the green campaign) and the 6 synthetic
// `src/metrics/__fixtures__/*` run dirs. Asserts the human output surfaces the key campaign
// metrics (tier histogram, hit-rates, cost, exit-criteria markers), that `--json` parses to a
// CampaignMetrics-shaped payload with the projection + lock cross-check attached, that single and
// multiple run dirs both work, that a campaign-root directory expands to its child run dirs, and
// that a missing dir fails with exit 2 + a clear message and no throw.
//
// All offline: no Chrome, no network, no SDK. Mirrors `explain.test.ts`'s capture helper.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./index.ts";
import {
  buildReportData,
  buildReportJson,
  expandRunInputs,
  formatReport,
  runReport,
} from "./report.ts";
import { loadRun } from "./explain.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const realRunsDir = join(repoRoot, ".flightplan-runs");
const fixturesDir = join(repoRoot, "src", "metrics", "__fixtures__");

function realRunDirs(): string[] {
  return readdirSync(realRunsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(realRunsDir, d.name))
    .sort();
}

const fixture = (name: string): string => join(fixturesDir, name);

/** Capture console.log/console.error around a call (mirrors explain.test.ts). */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  try {
    const code = await fn();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

// ---------------------------------------------------------------------------
// 1) The 4 real .flightplan-runs dirs — the green campaign report.
// ---------------------------------------------------------------------------

describe("report — the 4 real .flightplan-runs dirs (green campaign)", () => {
  test("exit 0 and the human report surfaces the campaign metrics", async () => {
    const { code, out } = await capture(() => runReport(parseArgs(["report", ...realRunDirs()])));
    expect(code).toBe(0);

    // Header + run counts.
    expect(out).toContain("Flightplan campaign report");
    expect(out).toContain("Runs:     4");
    expect(out).toContain("4 passed");

    // Tier histogram + hit-rates (every resolving step landed at L1).
    expect(out).toContain("Tier histogram (13 resolving steps)");
    expect(out).toContain("L1 hit:          100.0%");
    expect(out).toContain("deterministic:   100.0%");
    expect(out).toContain("escalation:      0.0%");

    // Cost rollup (the green campaign is free).
    expect(out).toContain("total:           $0.000000");

    // Exit criteria — all PASS for the green campaign.
    expect(out).toContain("Exit criteria: [PASS] overall");
    expect(out).toContain("[PASS] deterministic majority");
    expect(out).toContain("[PASS] cost per pass");
    expect(out).toContain("[PASS] locks stable");

    // Per-fixture matrix maps the real flows to their expected tiers.
    expect(out).toContain("Per-fixture matrix");
    expect(out).toContain("01-wizard");
  });

  test("a campaign-root directory expands to its child run dirs", async () => {
    // `report .flightplan-runs` (the parent dir, no run.jsonl of its own) → all 4 children.
    const targets = await expandRunInputs([realRunsDir]);
    expect(targets.length).toBe(4);

    const { code, out } = await capture(() => runReport(parseArgs(["report", realRunsDir])));
    expect(code).toBe(0);
    expect(out).toContain("Runs:     4");
  });

  test("--json parses to a CampaignMetrics-shaped payload with projection + stability", async () => {
    const { code, out } = await capture(() =>
      runReport(parseArgs(["report", realRunsDir, "--json"])),
    );
    expect(code).toBe(0);

    const data = JSON.parse(out) as Record<string, unknown>;
    // CampaignMetrics fields are present at the top level.
    expect(data.runCount).toBe(4);
    expect(data.passCount).toBe(4);
    expect(data.histogram).toEqual({ L0: 0, L1: 13, L2: 0, L3: 0, L4: 0, total: 13 });
    expect(data.l1HitRate).toBe(1);
    expect(data.deterministicShare).toBe(1);
    expect(data.totalCostUsd).toBe(0);
    expect(Array.isArray(data.runs)).toBe(true);
    expect((data.runs as unknown[]).length).toBe(4);
    expect(Array.isArray(data.perFixture)).toBe(true);

    // The two side analyses + exit criteria are attached.
    expect(data.costProjection).toBeDefined();
    expect(data.lockStability).toBeDefined();
    const ex = data.exitCriteria as Record<string, unknown>;
    expect(ex.allPass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2) Synthetic fixtures — escalation + cost, single and multiple dirs.
// ---------------------------------------------------------------------------

describe("report — synthetic fixtures", () => {
  test("a single run dir works", async () => {
    const { code, out } = await capture(() =>
      runReport(parseArgs(["report", fixture("l2-escalate")])),
    );
    expect(code).toBe(0);
    expect(out).toContain("Runs:     1");
    expect(out).toContain("Tier histogram (1 resolving steps)");
  });

  test("multiple run dirs aggregate escalation + per-role cost", async () => {
    const { code, out } = await capture(() =>
      runReport(parseArgs(["report", fixture("l2-escalate"), fixture("l3-vision")])),
    );
    expect(code).toBe(0);
    expect(out).toContain("Runs:     2");

    // Both runs escalated to a model tier → 100% escalation, deterministic majority FAILS.
    expect(out).toContain("escalation:      100.0%");
    expect(out).toContain("[FAIL] deterministic majority");

    // Per-role spend appears (resolver for L2, vision for L3).
    expect(out).toContain("resolver");
    expect(out).toContain("vision");
    expect(out).toContain("Cost projection (model vs actual)");
  });

  test("the false-positive fixture is flagged in the resolution-quality section", async () => {
    const { code, out } = await capture(() =>
      runReport(parseArgs(["report", fixture("false-positive")])),
    );
    expect(code).toBe(0);
    expect(out).toContain("false positives");
    expect(out).toContain("s_click");
  });

  test("--json for synthetic fixtures carries the cost projection numbers", async () => {
    const loaded = await loadRun(fixture("l3-vision"));
    const json = buildReportJson(buildReportData([loaded]));
    expect(json.escalationRate).toBe(1);
    const proj = json.costProjection as Record<string, unknown>;
    expect(typeof proj.campaignUsd).toBe("number");
    expect(proj.withinBudget).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3) Pure builders + error handling.
// ---------------------------------------------------------------------------

describe("report — pure builders", () => {
  test("buildReportData + formatReport render a no-resolving-step campaign gracefully", async () => {
    // budget-inconclusive is a partial run; feed it alone and ensure no throw + a rendered report.
    const loaded = await loadRun(fixture("budget-inconclusive"));
    const data = buildReportData([loaded]);
    expect(data.campaign.runCount).toBe(1);
    const text = formatReport(data);
    expect(text).toContain("Flightplan campaign report");
    expect(text).toContain("Exit criteria");
  });
});

describe("report — error handling", () => {
  test("missing run dir → exit 2 + clear message, no throw", async () => {
    const missing = join(repoRoot, "does-not-exist-run-dir");
    const { code, err } = await capture(() => runReport(parseArgs(["report", missing])));
    expect(code).toBe(2);
    expect(err).toContain("flightplan report:");
    expect(err).toContain("no such file or directory");
  });

  test("no positional argument → exit 2 + clear message", async () => {
    const { code, err } = await capture(() => runReport(parseArgs(["report"])));
    expect(code).toBe(2);
    expect(err).toContain("expected at least one run directory");
  });

  test("a bad dir mixed with good ones still fails fast with exit 2", async () => {
    const missing = join(repoRoot, "nope-run-dir");
    const { code, err } = await capture(() =>
      runReport(parseArgs(["report", fixture("l2-escalate"), missing])),
    );
    expect(code).toBe(2);
    expect(err).toContain("flightplan report:");
  });
});
