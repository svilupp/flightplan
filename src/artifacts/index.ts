// Flightplan — artifacts/ public surface.
//
// run.jsonl / trace.jsonl / ai.jsonl writers, run-id + run-dir management, and the final
// summary.json. Phase 2 ships run/trace + run-dir; the ai.jsonl writer + its event type are
// defined now so Phase 4 only imports them; screenshots/ + proposed-patches/ dirs are created
// eagerly for Phase 5. See PLAN.md §5.
//
// The runner holds an {@link ArtifactWriters} facade (via {@link openArtifactWriters}) created
// from a {@link RunDir} (via {@link createRun}), emits events through the typed writers, and
// writes the final summary via {@link writeSummary}.

// ---- Run directory management ----
export {
  createRun,
  resolveRunDir,
  makeRunId,
  DEFAULT_BASE_DIR,
  RUN_FILES,
  RUN_DIRS,
} from "./run-dir.ts";
export type { RunDir, CreateRunOptions } from "./run-dir.ts";

// ---- Generic JSONL primitive ----
export { JsonlWriter } from "./jsonl.ts";
export type { JsonlValue } from "./jsonl.ts";

// ---- Typed writers + facade + summary ----
export {
  RunWriter,
  TraceWriter,
  AiWriter,
  ArtifactWriters,
  openArtifactWriters,
  writeSummary,
} from "./writers.ts";
export type { Clock } from "./writers.ts";

// ---- Event schemas + run-summary type (the cross-agent contract) ----
export { LADDER_TIERS, AI_CALL_ROLES } from "./events.ts";
export type {
  // shared
  LadderTier,
  ModelUsage,
  RunTotals,
  AiCallRole,
  // run.jsonl
  RunEvent,
  RunStartEvent,
  StepStartEvent,
  StepEndEvent,
  AssertionResultEvent,
  RunEndEvent,
  // trace.jsonl
  TraceEvent,
  BrowserActionEvent,
  ResolutionAttemptEvent,
  // ai.jsonl
  AiEvent,
  AiCallEvent,
  // summary
  RunSummary,
  StepSummary,
} from "./events.ts";
