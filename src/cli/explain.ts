// Flightplan — `flightplan explain <run-dir | run.jsonl>` command.
//
// Reads a COMPLETED run's artifacts (run.jsonl + the optional trace.jsonl / ai.jsonl /
// summary.json) and prints a human-readable diagnosis: the overall verdict + exit reason, a
// per-step breakdown (resolution tier, self-heal, pass/fail + failure evidence), the
// self-healing summary (drift_count + which steps healed), the cost rollup (when AI tiers ran),
// the advisory verdict, and any proposed-patch path.
//
// This module OWNS only the CLI rendering. It imports the artifact event TYPES and reads the
// files the runner already wrote — it never re-derives shapes nor touches the runner/artifacts
// writers/AI layers. Canonical references: PLAN.md §5 Phase 5 (`explain` deliverable),
// PROPOSAL_v1.md "CLI shape" (`flightplan explain ...runs/<run-id>/run.jsonl`).
//
// Resilience contract (this module's brief):
//   - A run dir OR a `run.jsonl` path is accepted; the sibling artifacts are derived from it.
//   - A missing trace.jsonl / ai.jsonl (an AI-less, deterministic run) still renders cleanly.
//   - A missing/malformed run dir produces a clear error + exit code 2 (the CLI's usage/IO
//     convention), NEVER a stack trace.

import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { RUN_FILES } from "../artifacts/index.ts";
import type {
  AiCallEvent,
  AssertionResultEvent,
  BrowserActionEvent,
  LadderTier,
  ResolutionAttemptEvent,
  RunEndEvent,
  RunEvent,
  RunStartEvent,
  RunSummary,
  StepEndEvent,
  StepStartEvent,
  TraceEvent,
} from "../artifacts/index.ts";
import type { AdvisoryVerdictKind, AssertType, RunVerdict } from "../types.ts";
import type { ParsedArgs } from "./index.ts";

// ---------------------------------------------------------------------------
// Errors + exit codes
// ---------------------------------------------------------------------------

/**
 * Raised by {@link loadRun} on a missing/empty/unreadable run dir. `exitCode` is the intended
 * process exit code — 2, matching the CLI's usage/IO convention (see `runLint`/`runRun`).
 */
export class ExplainError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "ExplainError";
    this.exitCode = exitCode;
  }
}

/** verdict → process exit code (PLAN.md §4: passed 0 · failed 1 · error 2 · inconclusive 3). */
const VERDICT_EXIT: Record<RunVerdict, number> = {
  passed: 0,
  failed: 1,
  error: 2,
  inconclusive: 3,
};

function exitReason(v: RunVerdict): string {
  switch (v) {
    case "passed":
      return "all assertions passed";
    case "failed":
      return "an assertion failed";
    case "inconclusive":
      return "a run budget was exceeded (fail-fast, partial evidence)";
    case "error":
      return "the harness errored";
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** The parsed artifacts for one run, as consumed by the renderer. */
export interface LoadedRun {
  /** Absolute path to the run directory. */
  runDir: string;
  /** Absolute path to the `run.jsonl` that was read. */
  runJsonlPath: string;
  runEvents: RunEvent[];
  /** Empty when `trace.jsonl` is absent (still a valid, AI-less run). */
  traceEvents: TraceEvent[];
  /** Empty when `ai.jsonl` is absent (a deterministic, no-model run). */
  aiEvents: AiCallEvent[];
  /** The on-disk `summary.json` when present + parseable; else null (best-effort). */
  summary: RunSummary | null;
  /** Non-fatal notes (e.g. skipped malformed lines) surfaced in the report footer. */
  warnings: string[];
}

async function statKind(p: string): Promise<"file" | "dir" | "missing"> {
  try {
    const s = await stat(p);
    return s.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

/**
 * Read a JSONL file into typed events. Returns null when the file is absent (the caller
 * distinguishes "missing" from "empty"); skips individual malformed lines and reports the count
 * so one bad append never aborts the whole report.
 */
async function readJsonl<T>(path: string): Promise<{ events: T[]; malformed: number } | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const events: T[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed) as T);
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

/**
 * Resolve the input (a run dir OR a `run.jsonl` path) and load every artifact stream. Throws
 * {@link ExplainError} (exit 2) when the run log is missing, empty, or unparseable; missing
 * trace/ai/summary files are tolerated (an AI-less run is normal).
 */
export async function loadRun(inputPath: string): Promise<LoadedRun> {
  const abs = isAbsolute(inputPath) ? inputPath : resolve(process.cwd(), inputPath);
  const kind = await statKind(abs);
  if (kind === "missing") {
    throw new ExplainError(`no such file or directory: ${inputPath}`);
  }

  let runDir: string;
  let runJsonlPath: string;
  if (kind === "dir") {
    runDir = abs;
    runJsonlPath = join(abs, RUN_FILES.run);
  } else {
    runJsonlPath = abs;
    runDir = dirname(abs);
  }

  const run = await readJsonl<RunEvent>(runJsonlPath);
  if (run === null) {
    throw new ExplainError(
      `run log not found: ${runJsonlPath}\n` +
        `(pass a run directory containing ${RUN_FILES.run}, or the ${RUN_FILES.run} file itself)`,
    );
  }
  if (run.events.length === 0) {
    throw new ExplainError(`run log is empty or malformed (no parseable events): ${runJsonlPath}`);
  }

  const warnings: string[] = [];
  if (run.malformed > 0) {
    warnings.push(`skipped ${run.malformed} malformed line(s) in ${RUN_FILES.run}`);
  }

  const trace = await readJsonl<TraceEvent>(join(runDir, RUN_FILES.trace));
  if (trace && trace.malformed > 0) {
    warnings.push(`skipped ${trace.malformed} malformed line(s) in ${RUN_FILES.trace}`);
  }
  const ai = await readJsonl<AiCallEvent>(join(runDir, RUN_FILES.ai));
  if (ai && ai.malformed > 0) {
    warnings.push(`skipped ${ai.malformed} malformed line(s) in ${RUN_FILES.ai}`);
  }

  let summary: RunSummary | null = null;
  try {
    summary = JSON.parse(await readFile(join(runDir, RUN_FILES.summary), "utf8")) as RunSummary;
  } catch {
    summary = null; // absent or malformed → reconstruct from the event streams instead.
  }

  return {
    runDir,
    runJsonlPath,
    runEvents: run.events,
    traceEvents: trace?.events ?? [],
    aiEvents: (ai?.events ?? []).filter((e) => e.type === "ai_call"),
    summary,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Derivation — normalize the event streams + summary into one diagnosis object
// ---------------------------------------------------------------------------

/** A per-step rollup assembled from run.jsonl (+ trace.jsonl attribution). */
interface StepView {
  stepId: string;
  do: string;
  intent?: string;
  /** False when a `step_start` was seen but no `step_end` (run crashed mid-step). */
  completed: boolean;
  ok: boolean;
  tier?: LadderTier;
  healed: boolean;
  durationMs: number;
  error?: string;
  assertions: AssertionResultEvent[];
  attempts: ResolutionAttemptEvent[];
  /** Browser actions attributed to this step by trace order (best-effort). */
  actions: BrowserActionEvent[];
}

interface ModelUsageRow {
  role: string;
  model: string;
  calls: number;
  cost_usd: number;
}

/** The normalized diagnosis the text + JSON renderers both consume. */
interface Diagnosis {
  verdict: RunVerdict;
  exitCode: number;
  flowId: string;
  runId: string;
  timestamp: string | null;
  runDir: string;
  runError: string | null;
  steps: StepView[];
  driftCount: number;
  healedSteps: string[];
  advisoryVerdict: AdvisoryVerdictKind | null;
  proposedPatchPath: string | null;
  aiUsed: boolean;
  totalCostUsd: number;
  modelUsage: ModelUsageRow[];
  modelCalls: number;
  screenshots: number;
  failedStep: string | null;
  failedAssertions: Array<{ step: string; type: AssertType; detail: string }>;
  warnings: string[];
}

function findRunStart(events: RunEvent[]): RunStartEvent | undefined {
  return events.find((e): e is RunStartEvent => e.type === "run_start");
}
function findRunEnd(events: RunEvent[]): RunEndEvent | undefined {
  return events.find((e): e is RunEndEvent => e.type === "run_end");
}

/** Pair step_start/step_end/assertion_result into ordered StepViews, attributing trace events. */
function buildStepViews(runEvents: RunEvent[], traceEvents: TraceEvent[]): StepView[] {
  const order: string[] = [];
  const byId = new Map<string, StepView>();

  const ensure = (stepId: string, doVerb: string): StepView => {
    let view = byId.get(stepId);
    if (view === undefined) {
      view = {
        stepId,
        do: doVerb,
        completed: false,
        ok: false,
        healed: false,
        durationMs: 0,
        assertions: [],
        attempts: [],
        actions: [],
      };
      byId.set(stepId, view);
      order.push(stepId);
    } else if (view.do === "" && doVerb !== "") {
      view.do = doVerb;
    }
    return view;
  };

  for (const ev of runEvents) {
    switch (ev.type) {
      case "step_start": {
        const s = ensure(ev.stepId, ev.do);
        if (ev.intent !== undefined) s.intent = ev.intent;
        break;
      }
      case "step_end": {
        // `do` is only on step_start (which precedes this); reuse the existing view's verb.
        const s = ensure(ev.stepId, "");
        s.completed = true;
        s.ok = ev.ok;
        s.healed = ev.healed;
        s.durationMs = ev.durationMs;
        if (ev.tier !== undefined) s.tier = ev.tier;
        if (ev.error !== undefined) s.error = ev.error;
        break;
      }
      case "assertion_result": {
        const s = ensure(ev.stepId, "");
        s.assertions.push(ev);
        break;
      }
      default:
        break;
    }
  }

  // Attribute browser_action events to a step: the runner emits the action FIRST, then the
  // step-keyed resolution_attempt(s); so a pending action is claimed by the next attempt's step.
  let pending: BrowserActionEvent[] = [];
  for (const ev of traceEvents) {
    if (ev.type === "browser_action") {
      pending.push(ev);
    } else if (ev.type === "resolution_attempt") {
      const s = byId.get(ev.stepId);
      if (s !== undefined) {
        s.attempts.push(ev);
        for (const a of pending) s.actions.push(a);
      }
      pending = [];
    }
  }

  return order.map((id) => byId.get(id) as StepView);
}

/** Fallback verdict when neither run_end nor summary recorded one (truncated log). */
function inferVerdict(steps: StepView[]): RunVerdict {
  if (steps.some((s) => !s.completed)) return "error";
  if (steps.some((s) => !s.ok)) return "failed";
  return "passed";
}

function deriveDiagnosis(loaded: LoadedRun): Diagnosis {
  const { runEvents, aiEvents, summary, traceEvents } = loaded;
  const runStart = findRunStart(runEvents);
  const runEnd = findRunEnd(runEvents);
  const steps = buildStepViews(runEvents, traceEvents);

  const verdict: RunVerdict = runEnd?.verdict ?? summary?.verdict ?? inferVerdict(steps);

  const flowId = runStart?.flowId ?? summary?.flow_id ?? "(unknown)";
  const runId = runStart?.runId ?? summary?.run_id ?? basename(loaded.runDir);
  const timestamp = runStart !== undefined ? new Date(runStart.ts).toISOString() : null;
  const runError = runEnd?.error ?? null;

  // --- self-healing ---
  const healedFromEvents = steps.filter((s) => s.healed).map((s) => s.stepId);
  const healedSteps =
    summary?.healed_steps !== undefined && summary.healed_steps.length > 0
      ? summary.healed_steps
      : healedFromEvents;
  const driftCount =
    runEnd?.totals.drift_count ?? summary?.drift_count ?? healedSteps.length;

  // --- cost / AI ---
  const totals = runEnd?.totals;
  let modelUsage: ModelUsageRow[] = totals?.model_usage ?? summary?.model_usage ?? [];
  if (modelUsage.length === 0 && aiEvents.length > 0) {
    // Reconstruct a rollup from ai.jsonl when no totals were recorded.
    const acc = new Map<string, ModelUsageRow>();
    for (const call of aiEvents) {
      const key = `${call.role} ${call.model}`;
      const row = acc.get(key) ?? { role: call.role, model: call.model, calls: 0, cost_usd: 0 };
      row.calls += 1;
      row.cost_usd += call.cost_usd;
      acc.set(key, row);
    }
    modelUsage = [...acc.values()];
  }
  const totalCostUsd =
    totals?.total_cost_usd ??
    summary?.total_cost_usd ??
    aiEvents.reduce((sum, c) => sum + c.cost_usd, 0);
  const modelCalls =
    aiEvents.length > 0 ? aiEvents.length : modelUsage.reduce((sum, r) => sum + r.calls, 0);
  const screenshots =
    summary?.screenshot_paths?.length ?? aiEvents.filter((c) => c.role === "vision").length;
  const aiUsed = modelCalls > 0 || totalCostUsd > 0 || modelUsage.length > 0;

  // --- advisory verdict / proposed patch ---
  let advisoryVerdict: AdvisoryVerdictKind | null = summary?.advisory_verdict ?? null;
  if (advisoryVerdict === null) {
    for (const call of aiEvents) {
      if (call.role === "advisor" && call.advisoryVerdict !== undefined) {
        advisoryVerdict = call.advisoryVerdict;
      }
    }
  }
  const proposedPatchPath = summary?.proposed_patch_path ?? null;

  // --- failed step + assertions ---
  const failedAssertions =
    summary?.failed_assertions ??
    steps.flatMap((s) =>
      s.assertions
        .filter((a) => !a.pass)
        .map((a) => ({ step: s.stepId, type: a.assertType, detail: a.message })),
    );
  const failedStep =
    summary?.failed_step ?? steps.find((s) => !s.ok || !s.completed)?.stepId ?? null;

  return {
    verdict,
    exitCode: VERDICT_EXIT[verdict],
    flowId,
    runId,
    timestamp,
    runDir: loaded.runDir,
    runError,
    steps,
    driftCount,
    healedSteps,
    advisoryVerdict,
    proposedPatchPath,
    aiUsed,
    totalCostUsd,
    modelUsage,
    modelCalls,
    screenshots,
    failedStep,
    failedAssertions,
    warnings: loaded.warnings,
  };
}

// ---------------------------------------------------------------------------
// Rendering — human text
// ---------------------------------------------------------------------------

function usd(n: number): string {
  return `$${n.toFixed(6)}`;
}

function tierTag(tier?: LadderTier): string {
  return tier !== undefined ? `  [${tier}]` : "";
}

/** Render the ladder climb for a step, e.g. `L0 miss -> L1 resolved (role_name)`. */
function climbLine(attempts: ResolutionAttemptEvent[]): string | null {
  if (attempts.length === 0) return null;
  const parts = attempts.map((a) => {
    const strat = a.strategy !== undefined ? ` (${a.strategy})` : "";
    return `${a.tier} ${a.outcome}${strat}`;
  });
  return `resolution: ${parts.join(" -> ")}`;
}

function renderStep(s: StepView): string[] {
  const lines: string[] = [];
  const mark = !s.completed ? "????" : s.ok ? "ok  " : "FAIL";
  const heal = s.healed ? "  self-healed (drift)" : "";
  lines.push(`  ${mark} ${s.stepId} (${s.do})${tierTag(s.tier)}${heal}`);
  if (s.intent !== undefined && s.intent !== "") {
    lines.push(`         intent: ${s.intent}`);
  }
  if (!s.completed) {
    lines.push(`         did not complete (no step_end recorded)`);
  }

  const failed = !s.ok || !s.completed;
  if (failed) {
    if (s.error !== undefined) lines.push(`         error: ${s.error}`);
    const climb = climbLine(s.attempts);
    if (climb !== null) lines.push(`         ${climb}`);
    for (const a of s.actions) {
      if (a.ok) continue;
      const bits: string[] = [];
      if (a.failureReason !== undefined) bits.push(`failureReason=${a.failureReason}`);
      if (a.coveringElement !== undefined) bits.push(`coveringElement=${a.coveringElement}`);
      const detail = bits.length > 0 ? `: ${bits.join(", ")}` : "";
      lines.push(`         browser: ${a.action} failed${detail}`);
    }
  }

  // Assertions: count, then spell out failures (these are the failure evidence).
  if (s.assertions.length > 0) {
    const passed = s.assertions.filter((a) => a.pass).length;
    const failedCount = s.assertions.length - passed;
    lines.push(`         assertions: ${passed} passed, ${failedCount} failed`);
    for (const a of s.assertions) {
      if (a.pass) continue;
      lines.push(`         assertion FAILED: ${a.assertType} — ${a.message}`);
    }
  }
  return lines;
}

/** Render the full human-readable diagnosis report. Pure: no IO. */
export function formatExplainReport(loaded: LoadedRun): string {
  const d = deriveDiagnosis(loaded);
  const out: string[] = [];

  out.push("=== Flightplan run diagnosis ===");
  out.push(`Verdict:  ${d.verdict.toUpperCase()}  (exit ${d.exitCode} — ${exitReason(d.verdict)})`);
  out.push(`Flow:     ${d.flowId}`);
  out.push(`Run:      ${d.runId}${d.timestamp !== null ? `   (${d.timestamp})` : ""}`);
  out.push(`Run dir:  ${d.runDir}`);
  if (d.runError !== null) out.push(`Error:    ${d.runError}`);

  // Steps
  out.push("");
  out.push(`Steps (${d.steps.length}):`);
  if (d.steps.length === 0) {
    out.push("  (no steps executed)");
  } else {
    for (const s of d.steps) out.push(...renderStep(s));
  }

  // Self-healing — surfaced prominently (core philosophy: observable self-healing).
  out.push("");
  out.push("Self-healing:");
  out.push(`  drift_count: ${d.driftCount}`);
  if (d.healedSteps.length > 0) {
    out.push(`  healed steps: ${d.healedSteps.join(", ")}`);
  } else {
    out.push("  no steps healed (no drift)");
  }

  // Cost
  out.push("");
  if (d.aiUsed) {
    out.push("Cost:");
    out.push(`  total: ${usd(d.totalCostUsd)}`);
    out.push(`  model calls: ${d.modelCalls}   screenshots: ${d.screenshots}`);
    for (const r of d.modelUsage) {
      const callWord = r.calls === 1 ? "call" : "calls";
      out.push(`  ${r.role}  ${r.model}  ${r.calls} ${callWord}  ${usd(r.cost_usd)}`);
    }
  } else {
    out.push("Cost: none (deterministic run — no model calls)");
  }

  // Advisory verdict + proposed patch
  if (d.advisoryVerdict !== null || d.proposedPatchPath !== null) {
    out.push("");
    if (d.advisoryVerdict !== null) {
      out.push(`Advisory verdict: ${d.advisoryVerdict} (annotates the run; never overrides it)`);
    }
    if (d.proposedPatchPath !== null) {
      out.push(`Proposed patch:   ${d.proposedPatchPath}`);
    }
  }

  // Failed-assertion consolidation (the agent-handoff surface, mirrors the run summary).
  if (d.failedAssertions.length > 0) {
    out.push("");
    out.push("Failed assertions:");
    for (const a of d.failedAssertions) {
      out.push(`  ${a.step}: ${a.type} — ${a.detail}`);
    }
  } else if (d.failedStep !== null) {
    out.push("");
    out.push(`Failed step: ${d.failedStep}`);
  }

  if (d.warnings.length > 0) {
    out.push("");
    out.push("Notes:");
    for (const w of d.warnings) out.push(`  - ${w}`);
  }

  return out.join("\n");
}

/** Build the machine-readable diagnosis (the `--json` surface). Pure: no IO. */
export function buildExplainJson(loaded: LoadedRun): Record<string, unknown> {
  const d = deriveDiagnosis(loaded);
  return {
    verdict: d.verdict,
    exit_code: d.exitCode,
    flow_id: d.flowId,
    run_id: d.runId,
    timestamp: d.timestamp,
    run_dir: d.runDir,
    error: d.runError,
    steps: d.steps.map((s) => ({
      step: s.stepId,
      do: s.do,
      intent: s.intent ?? null,
      ok: s.ok,
      completed: s.completed,
      tier: s.tier ?? null,
      healed: s.healed,
      duration_ms: s.durationMs,
      error: s.error ?? null,
      failed_assertions: s.assertions
        .filter((a) => !a.pass)
        .map((a) => ({ type: a.assertType, detail: a.message })),
    })),
    drift_count: d.driftCount,
    healed_steps: d.healedSteps,
    advisory_verdict: d.advisoryVerdict,
    proposed_patch_path: d.proposedPatchPath,
    ai_used: d.aiUsed,
    total_cost_usd: d.totalCostUsd,
    model_usage: d.modelUsage,
    model_calls: d.modelCalls,
    screenshots: d.screenshots,
    failed_step: d.failedStep,
    failed_assertions: d.failedAssertions,
    warnings: d.warnings,
  };
}

// ---------------------------------------------------------------------------
// Command entrypoint
// ---------------------------------------------------------------------------

/**
 * `flightplan explain <run-dir | run.jsonl> [--json]` — render a human-readable failure
 * diagnosis for a completed run. The positional may be a run directory or a `run.jsonl` path;
 * the sibling `trace.jsonl` / `ai.jsonl` / `summary.json` are read when present.
 *
 * Exit code: 0 on a rendered report (the run's OWN verdict is NOT this command's exit code —
 * `explain` succeeds whenever it can produce a report); 2 on a usage error (no path) or an
 * IO/parse error (missing or malformed run log). A clear message is printed to stderr, never a
 * stack trace.
 */
export async function runExplain(args: ParsedArgs): Promise<number> {
  const inputPath = args.positionals[0];
  if (inputPath === undefined) {
    console.error("flightplan explain: expected a run directory or run.jsonl path.");
    return 2;
  }

  let loaded: LoadedRun;
  try {
    loaded = await loadRun(inputPath);
  } catch (err) {
    if (err instanceof ExplainError) {
      console.error(`flightplan explain: ${err.message}`);
      return err.exitCode;
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`flightplan explain: ${detail}`);
    return 2;
  }

  if (args.json) {
    console.log(JSON.stringify(buildExplainJson(loaded), null, 2));
  } else {
    console.log(formatExplainReport(loaded));
  }
  return 0;
}
