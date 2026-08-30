// Flightplan — typed artifact writers + facade.
//
// Thin typed wrappers over the generic JsonlWriter (jsonl.ts) for each stream, plus the
// `ArtifactWriters` facade the runner holds for the whole run, and `writeSummary` for the
// final `summary.json`.
//
// Each `emit*` method takes the event payload WITHOUT `ts`/`type` and stamps both — `type`
// from the method, `ts` from an injected clock (`now()`, default `Date.now`) so tests are
// deterministic. The methods return the underlying `write()` promise; callers can await per
// event or fire-and-forget and `close()` at the end.
//
// REDACTION: the AiWriter does NOT redact. `redactedPrompt`/`redactedResponse` must already be
// redacted by the caller before reaching `emitAiCall` (see events.ts REDACTION CONTRACT and
// PLAN.md §5 Phase 5).

import { writeTextFile } from "../runtime.ts";
import type {
  AiCallEvent,
  AiEvent,
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
} from "./events.ts";
import { JsonlWriter } from "./jsonl.ts";
import type { RunDir } from "./run-dir.ts";

/** A function that stamps an event timestamp (ms epoch). Injectable for deterministic tests. */
export type Clock = () => number;

/** Strips the writer-stamped fields from an event so `emit*` callers only pass the payload. */
type Payload<E extends { ts: number; type: string }> = Omit<E, "ts" | "type">;

// ---------------------------------------------------------------------------
// run.jsonl
// ---------------------------------------------------------------------------

/** Typed writer for `run.jsonl` (run/step/assertion lifecycle). */
export class RunWriter {
  private readonly jsonl: JsonlWriter;
  private readonly now: Clock;

  constructor(path: string, now: Clock = Date.now) {
    this.jsonl = new JsonlWriter(path);
    this.now = now;
  }

  get path(): string {
    return this.jsonl.path;
  }

  /** Emit any pre-shaped RunEvent (escape hatch; prefer the typed helpers below). */
  emit(event: RunEvent): Promise<void> {
    return this.jsonl.write(event);
  }

  emitRunStart(p: Payload<RunStartEvent>): Promise<void> {
    return this.jsonl.write({ type: "run_start", ts: this.now(), ...p });
  }

  emitStepStart(p: Payload<StepStartEvent>): Promise<void> {
    return this.jsonl.write({ type: "step_start", ts: this.now(), ...p });
  }

  emitStepEnd(p: Payload<StepEndEvent>): Promise<void> {
    return this.jsonl.write({ type: "step_end", ts: this.now(), ...p });
  }

  emitAssertionResult(p: Payload<AssertionResultEvent>): Promise<void> {
    return this.jsonl.write({ type: "assertion_result", ts: this.now(), ...p });
  }

  emitRunEnd(p: Payload<RunEndEvent>): Promise<void> {
    return this.jsonl.write({ type: "run_end", ts: this.now(), ...p });
  }

  close(): Promise<void> {
    return this.jsonl.close();
  }
}

// ---------------------------------------------------------------------------
// trace.jsonl
// ---------------------------------------------------------------------------

/** Typed writer for `trace.jsonl` (browser actions + ladder resolution attempts). */
export class TraceWriter {
  private readonly jsonl: JsonlWriter;
  private readonly now: Clock;

  constructor(path: string, now: Clock = Date.now) {
    this.jsonl = new JsonlWriter(path);
    this.now = now;
  }

  get path(): string {
    return this.jsonl.path;
  }

  emit(event: TraceEvent): Promise<void> {
    return this.jsonl.write(event);
  }

  emitBrowserAction(p: Payload<BrowserActionEvent>): Promise<void> {
    return this.jsonl.write({ type: "browser_action", ts: this.now(), ...p });
  }

  emitResolutionAttempt(p: Payload<ResolutionAttemptEvent>): Promise<void> {
    return this.jsonl.write({ type: "resolution_attempt", ts: this.now(), ...p });
  }

  close(): Promise<void> {
    return this.jsonl.close();
  }
}

// ---------------------------------------------------------------------------
// ai.jsonl
// ---------------------------------------------------------------------------

/**
 * Typed writer for `ai.jsonl` (model calls). The underlying file is created lazily on the
 * first `emitAiCall` (Phase 4) — until then no `ai.jsonl` exists on disk. Redaction is the
 * caller's responsibility (see REDACTION CONTRACT in events.ts).
 */
export class AiWriter {
  private readonly jsonl: JsonlWriter;
  private readonly now: Clock;

  constructor(path: string, now: Clock = Date.now) {
    this.jsonl = new JsonlWriter(path);
    this.now = now;
  }

  get path(): string {
    return this.jsonl.path;
  }

  emit(event: AiEvent): Promise<void> {
    return this.jsonl.write(event);
  }

  emitAiCall(p: Payload<AiCallEvent>): Promise<void> {
    return this.jsonl.write({ type: "ai_call", ts: this.now(), ...p });
  }

  close(): Promise<void> {
    return this.jsonl.close();
  }
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/**
 * The bundle of writers for one run, sharing a single injected clock. This is what the runner
 * holds: it emits run/trace/ai events through the typed writers and `close()`s them all at the
 * end (the writers flush and release their fds).
 *
 * Construct via {@link openArtifactWriters} from a {@link RunDir}.
 */
export class ArtifactWriters {
  readonly run: RunWriter;
  readonly trace: TraceWriter;
  readonly ai: AiWriter;
  /** The run dir these writers belong to (paths + runId). */
  readonly runDir: RunDir;

  constructor(runDir: RunDir, now: Clock = Date.now) {
    this.runDir = runDir;
    this.run = new RunWriter(runDir.runJsonl, now);
    this.trace = new TraceWriter(runDir.traceJsonl, now);
    this.ai = new AiWriter(runDir.aiJsonl, now);
  }

  /** Flush and close all three writers. Idempotent per underlying writer. */
  async close(): Promise<void> {
    await Promise.all([this.run.close(), this.trace.close(), this.ai.close()]);
  }
}

/**
 * Open the writer facade for a run directory. Pass the injected clock through to stamp every
 * event deterministically in tests.
 */
export function openArtifactWriters(runDir: RunDir, now: Clock = Date.now): ArtifactWriters {
  return new ArtifactWriters(runDir, now);
}

// ---------------------------------------------------------------------------
// summary.json
// ---------------------------------------------------------------------------

/**
 * Write the final {@link RunSummary} to `<runDir>/summary.json` as pretty-printed JSON. This
 * is the structured surface `--json` mode prints and Phase 5's `explain` reads. Overwrites any
 * existing summary (a run writes it exactly once at the end).
 */
export async function writeSummary(runDir: RunDir, summary: RunSummary): Promise<void> {
  await writeTextFile(runDir.summaryJson, `${JSON.stringify(summary, null, 2)}\n`);
}
