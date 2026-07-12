// Flightplan — `flightplan explain` tests (offline).
//
// Builds synthetic run directories from the REAL artifact event types (run.jsonl / trace.jsonl
// / ai.jsonl / summary.json), then asserts the rendered diagnosis surfaces the key facts:
// verdict, a healed step + drift_count, a failed step's evidence (assertion + failure reason),
// the cost rollup, the advisory verdict, and the proposed-patch path. Also covers the AI-less
// (deterministic) run and the error cases (missing / malformed / no-arg) → exit 2, no throw.
//
// Temp-dir pattern mirrors the runner/lock tests (mkdtemp under os.tmpdir, afterAll cleanup).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AiCallEvent,
  AssertionResultEvent,
  BrowserActionEvent,
  ResolutionAttemptEvent,
  RunEndEvent,
  RunEvent,
  RunStartEvent,
  RunSummary,
  StepEndEvent,
  StepStartEvent,
  TraceEvent,
} from "../artifacts/index.ts";
import { buildExplainJson, formatExplainReport, loadRun, runExplain } from "./explain.ts";
import { parseArgs } from "./index.ts";

// ---------------------------------------------------------------------------
// Temp-dir + artifact helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fp-explain-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

const jsonl = (events: object[]): string => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

/** Write a run directory; only the files passed are created (so AI-less runs omit ai/trace). */
async function writeRunDir(files: {
  run: RunEvent[];
  trace?: TraceEvent[];
  ai?: AiCallEvent[];
  summary?: RunSummary;
}): Promise<string> {
  const base = await makeTmpDir();
  const dir = join(base, "20260630T120000000-abcd1234");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.jsonl"), jsonl(files.run));
  if (files.trace !== undefined) await writeFile(join(dir, "trace.jsonl"), jsonl(files.trace));
  if (files.ai !== undefined) await writeFile(join(dir, "ai.jsonl"), jsonl(files.ai));
  if (files.summary !== undefined) {
    await writeFile(join(dir, "summary.json"), JSON.stringify(files.summary, null, 2));
  }
  return dir;
}

/** Capture console.log/console.error around a call. */
async function capture(fn: () => Promise<number>): Promise<{
  code: number;
  out: string;
  err: string;
}> {
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
// Fixture builders (typed against the real event schemas)
// ---------------------------------------------------------------------------

const runStart: RunStartEvent = {
  type: "run_start",
  ts: 1_900_000_000_000,
  runId: "20260630T120000000-abcd1234",
  flowId: "admin-create-order",
  inputs: {},
  configSummary: { connect_mode: "launch" },
  limits: { max_steps: 10 },
};

function stepStart(stepId: string, doVerb: string, intent?: string): StepStartEvent {
  const e: StepStartEvent = { type: "step_start", ts: 1_900_000_000_100, stepId, do: doVerb };
  if (intent !== undefined) e.intent = intent;
  return e;
}
function stepEnd(p: Omit<StepEndEvent, "type" | "ts">): StepEndEvent {
  return { type: "step_end", ts: 1_900_000_000_200, ...p };
}

// ---------------------------------------------------------------------------
// 1) Full AI run — healed step, failed step, cost, advisory + proposed patch
// ---------------------------------------------------------------------------

describe("explain — full AI run", () => {
  async function buildFullRun(): Promise<string> {
    const run: RunEvent[] = [
      runStart,
      stepStart("open", "goto"),
      stepEnd({ stepId: "open", ok: true, tier: "L0", healed: false, durationMs: 12 }),
      stepStart("fill_name", "fill", "type the customer name"),
      stepEnd({ stepId: "fill_name", ok: true, tier: "L1", healed: true, durationMs: 45 }),
      stepStart("submit", "click", "submit the order"),
      stepEnd({
        stepId: "submit",
        ok: false,
        tier: "L3",
        healed: false,
        durationMs: 1500,
        error: "post-assertion failed",
      }),
      {
        type: "assertion_result",
        ts: 1_900_000_000_300,
        stepId: "submit",
        assertType: "text",
        pass: false,
        message: 'expected text "Order created" but found "Server error"',
        durationMs: 200,
      } satisfies AssertionResultEvent,
      {
        type: "run_end",
        ts: 1_900_000_000_400,
        verdict: "failed",
        totals: {
          steps_run: 3,
          drift_count: 1,
          total_cost_usd: 0.001234,
          model_usage: [
            { role: "resolver", model: "deepseek/deepseek-v4-flash", calls: 1, cost_usd: 0.000005 },
            { role: "vision", model: "google/gemini-3-flash-preview", calls: 1, cost_usd: 0.0006 },
            { role: "advisor", model: "z-ai/glm-5.2", calls: 1, cost_usd: 0.000629 },
          ],
        },
      } satisfies RunEndEvent,
    ];

    const trace: TraceEvent[] = [
      {
        type: "browser_action",
        ts: 1_900_000_000_150,
        action: "click",
        selectorOrIntent: "submit the order",
        ok: false,
        failureReason: "element_not_found",
        durationMs: 1400,
      } satisfies BrowserActionEvent,
      {
        type: "resolution_attempt",
        ts: 1_900_000_000_160,
        stepId: "submit",
        tier: "L1",
        outcome: "unresolved",
        durationMs: 30,
      } satisfies ResolutionAttemptEvent,
      {
        type: "resolution_attempt",
        ts: 1_900_000_000_170,
        stepId: "submit",
        tier: "L3",
        outcome: "escalated",
        durationMs: 1200,
      } satisfies ResolutionAttemptEvent,
    ];

    const ai: AiCallEvent[] = [
      {
        type: "ai_call",
        ts: 1_900_000_000_180,
        role: "resolver",
        model: "deepseek/deepseek-v4-flash",
        purpose: "resolve",
        inputTokens: 100,
        outputTokens: 20,
        cost_usd: 0.000005,
        outcome: "ok",
      },
      {
        type: "ai_call",
        ts: 1_900_000_000_185,
        role: "vision",
        model: "google/gemini-3-flash-preview",
        purpose: "resolve",
        inputTokens: 800,
        outputTokens: 60,
        cost_usd: 0.0006,
        outcome: "ok",
      },
      {
        type: "ai_call",
        ts: 1_900_000_000_190,
        role: "advisor",
        model: "z-ai/glm-5.2",
        purpose: "classify",
        inputTokens: 400,
        outputTokens: 80,
        cost_usd: 0.000629,
        outcome: "intent_changed",
        advisoryVerdict: "intent_changed",
      },
    ];

    const summary: RunSummary = {
      verdict: "failed",
      flow_id: "admin-create-order",
      run_id: "20260630T120000000-abcd1234",
      run_dir: "(set below)",
      failed_step: "submit",
      failed_assertions: [
        {
          step: "submit",
          type: "text",
          detail: 'expected text "Order created" but found "Server error"',
        },
      ],
      advisory_verdict: "intent_changed",
      healed_steps: ["fill_name"],
      drift_count: 1,
      screenshot_paths: ["screenshots/submit.png"],
      video_path: null,
      trace_path: "trace.jsonl",
      total_cost_usd: 0.001234,
      model_usage: [
        { role: "resolver", model: "deepseek/deepseek-v4-flash", calls: 1, cost_usd: 0.000005 },
        { role: "vision", model: "google/gemini-3-flash-preview", calls: 1, cost_usd: 0.0006 },
        { role: "advisor", model: "z-ai/glm-5.2", calls: 1, cost_usd: 0.000629 },
      ],
      proposed_patch_path: "proposed-patches/submit.patch",
      replan_count: 0,
      repaired_steps: [],
      steps: [],
    };

    return writeRunDir({ run, trace, ai, summary });
  }

  test("renders verdict, healed step + drift_count, failure evidence, cost, advisory, patch", async () => {
    const dir = await buildFullRun();
    const report = formatExplainReport(await loadRun(dir));

    // Verdict + exit reason.
    expect(report).toContain("FAILED");
    expect(report).toContain("exit 1");

    // Self-healing surfaced prominently.
    expect(report).toContain("drift_count: 1");
    expect(report).toContain("fill_name");
    expect(report).toContain("self-healed");

    // Failed step evidence: the assertion detail AND the browser failure reason.
    expect(report).toContain("Order created");
    expect(report).toContain("element_not_found");
    expect(report).toContain("assertion FAILED");

    // Resolution climb from trace.jsonl.
    expect(report).toContain("L1 unresolved");
    expect(report).toContain("L3 escalated");

    // Cost rollup.
    expect(report).toContain("$0.001234");
    expect(report).toContain("model calls: 3");
    expect(report).toContain("deepseek/deepseek-v4-flash");
    expect(report).toContain("google/gemini-3-flash-preview");

    // Advisory verdict + proposed patch.
    expect(report).toContain("intent_changed");
    expect(report).toContain("proposed-patches/submit.patch");
  });

  test("runExplain returns 0 (explain succeeds even on a FAILED run) and prints the report", async () => {
    const dir = await buildFullRun();
    const { code, out } = await capture(() => runExplain(parseArgs(["explain", dir])));
    expect(code).toBe(0);
    expect(out).toContain("Flightplan run diagnosis");
    expect(out).toContain("FAILED");
  });

  test("--json emits a machine-readable diagnosis with the key fields", async () => {
    const dir = await buildFullRun();
    const data = buildExplainJson(await loadRun(dir));
    expect(data.verdict).toBe("failed");
    expect(data.exit_code).toBe(1);
    expect(data.drift_count).toBe(1);
    expect(data.healed_steps).toEqual(["fill_name"]);
    expect(data.advisory_verdict).toBe("intent_changed");
    expect(data.proposed_patch_path).toBe("proposed-patches/submit.patch");
    expect(data.total_cost_usd).toBeCloseTo(0.001234, 6);
    expect(data.model_calls).toBe(3);

    // The same data is reachable through the command's --json path.
    const { code, out } = await capture(() => runExplain(parseArgs(["explain", dir, "--json"])));
    expect(code).toBe(0);
    expect(JSON.parse(out).verdict).toBe("failed");
  });

  test("accepts a run.jsonl FILE path (not just the directory)", async () => {
    const dir = await buildFullRun();
    const report = formatExplainReport(await loadRun(join(dir, "run.jsonl")));
    expect(report).toContain("FAILED");
    expect(report).toContain("drift_count: 1");
  });
});

// ---------------------------------------------------------------------------
// 2) AI-less deterministic run — no ai.jsonl / trace.jsonl / summary.json
// ---------------------------------------------------------------------------

describe("explain — AI-less deterministic run", () => {
  test("renders cleanly with no model calls and no drift", async () => {
    const run: RunEvent[] = [
      runStart,
      stepStart("open", "goto"),
      stepEnd({ stepId: "open", ok: true, tier: "L0", healed: false, durationMs: 10 }),
      stepStart("next", "click", "go to the next page"),
      stepEnd({ stepId: "next", ok: true, tier: "L1", healed: false, durationMs: 22 }),
      {
        type: "run_end",
        ts: 1_900_000_000_400,
        verdict: "passed",
        totals: { steps_run: 2, drift_count: 0, total_cost_usd: 0, model_usage: [] },
      } satisfies RunEndEvent,
    ];
    // Only run.jsonl — no trace.jsonl, no ai.jsonl, no summary.json.
    const dir = await writeRunDir({ run });

    const loaded = await loadRun(dir);
    expect(loaded.traceEvents).toEqual([]);
    expect(loaded.aiEvents).toEqual([]);
    expect(loaded.summary).toBeNull();

    const report = formatExplainReport(loaded);
    expect(report).toContain("PASSED");
    expect(report).toContain("Cost: none (deterministic run");
    expect(report).toContain("no steps healed");
    expect(report).toContain("open");
    expect(report).toContain("next");

    // And the command itself returns 0 and does not throw.
    const { code } = await capture(() => runExplain(parseArgs(["explain", dir])));
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3) Error cases — missing / malformed / no-arg → exit 2, clear message, no throw
// ---------------------------------------------------------------------------

describe("explain — error handling", () => {
  test("missing run dir → exit 2 + clear message, no stack trace", async () => {
    const base = await makeTmpDir();
    const missing = join(base, "no-such-run");
    const { code, err } = await capture(() => runExplain(parseArgs(["explain", missing])));
    expect(code).toBe(2);
    expect(err).toContain("flightplan explain:");
    expect(err).toContain("no such file or directory");
  });

  test("malformed run.jsonl (no parseable events) → exit 2 + clear message", async () => {
    const base = await makeTmpDir();
    const dir = join(base, "broken-run");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.jsonl"), "not json\n{also not valid\n");
    const { code, err } = await capture(() => runExplain(parseArgs(["explain", dir])));
    expect(code).toBe(2);
    expect(err).toContain("empty or malformed");
  });

  test("no positional argument → exit 2 + usage message", async () => {
    const { code, err } = await capture(() => runExplain(parseArgs(["explain"])));
    expect(code).toBe(2);
    expect(err).toContain("expected a run directory");
  });

  test("a run dir with a run.jsonl but a malformed summary.json still renders from events", async () => {
    const run: RunEvent[] = [
      runStart,
      stepStart("open", "goto"),
      stepEnd({ stepId: "open", ok: true, tier: "L0", healed: false, durationMs: 10 }),
      {
        type: "run_end",
        ts: 1_900_000_000_400,
        verdict: "passed",
        totals: { steps_run: 1, drift_count: 0, total_cost_usd: 0, model_usage: [] },
      } satisfies RunEndEvent,
    ];
    const dir = await writeRunDir({ run });
    await writeFile(join(dir, "summary.json"), "{ this is : not json");

    const loaded = await loadRun(dir);
    expect(loaded.summary).toBeNull();
    expect(formatExplainReport(loaded)).toContain("PASSED");
  });
});
