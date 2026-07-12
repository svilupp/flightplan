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

export type {
  AiCallEvent,
  AiCallRole,
  // ai.jsonl
  AiEvent,
  ArtifactProvenance,
  AssertionResultEvent,
  BrowserActionEvent,
  // shared
  LadderTier,
  ModelUsage,
  ResolutionAttemptEvent,
  RunEndEvent,
  // run.jsonl
  RunEvent,
  RunStartEvent,
  // summary
  RunSummary,
  RunTotals,
  StepEndEvent,
  StepStartEvent,
  StepSummary,
  // trace.jsonl
  TraceEvent,
} from "./events.ts";
// ---- Event schemas + run-summary type (the cross-agent contract) ----
export { AI_CALL_ROLES, LADDER_TIERS } from "./events.ts";
export type { JsonlValue } from "./jsonl.ts";
// ---- Generic JSONL primitive ----
export { JsonlWriter } from "./jsonl.ts";
export type { CreateRunOptions, RunDir } from "./run-dir.ts";
// ---- Run directory management ----
export {
  createRun,
  DEFAULT_BASE_DIR,
  makeRunId,
  RUN_DIRS,
  RUN_FILES,
  resolveRunDir,
} from "./run-dir.ts";
export type { Clock } from "./writers.ts";
// ---- Typed writers + facade + summary ----
export {
  AiWriter,
  ArtifactWriters,
  openArtifactWriters,
  RunWriter,
  TraceWriter,
  writeSummary,
} from "./writers.ts";
