// Flightplan — the portable `./worker` entry (workers-slice-2 §1/U4).
//
// A CURATED barrel (never `export *`) of the run-path surface that is safe to bundle and run
// on hosts with no `node:*`/`bun:*` (e.g. Cloudflare Workers): `runFlow`/`lintText` and the
// types/adapters a host needs to drive them with an injected `FileSystemPort`.
//
// Deliberately NOT exported here: `nodeFileSystem` (Node-only; import from
// `@svilupp/flightplan/adapters/node` instead), anything under `src/cli/**`, the AI provider
// SDK glue (`src/ai/provider.ts`/`default-generate.ts`), and `src/metrics/**`.
//
// This module is on the worker-legal graph, gated by `src/fitness/worker-portability.test.ts`
// (its reachable static import graph must contain zero `node:*`/`bun:*`/AI-SDK/`chrome-launcher`
// specifiers and no bare `process.` token outside the guarded `ambientEnv` helper).

// ---- In-memory FileSystemPort (worker-legal; used in tests + memory-backed hosts) ----
export { memoryFileSystem } from "./adapters/memory.ts";
export type {
  RunEvent,
  RunSummary,
  RunTotals,
  StepSummary,
  TraceEvent,
} from "./artifacts/index.ts";
// ---- Run-summary artifact types (the `--json` / `run.jsonl` contract) ----
export { makeRunId, resolveRunDir } from "./artifacts/index.ts";
export type { Config, ConfigFile, ConnectConfig, ResolvedConfig } from "./config/index.ts";
// ---- Config resolution ----
export {
  BUILTIN_DEFAULTS,
  parseToml,
  resolveConfig,
  resolveConfigWithDefaults,
} from "./config/index.ts";
export type { Driver, DriverCall, MockDriverDefaults } from "./driver/index.ts";
// ---- Driver: types + the Node-free mock, plus the real browser-pilot-backed driver (the
// worker entry ships attach-mode support out of the box — see docs/plans/workers-slice-2.md
// §4 for the chunk-level portability assessment of the installed browser-pilot dist) ----
export { BrowserPilotDriver, MockDriver } from "./driver/index.ts";
// ---- Flow loading / parsing ----
export type {
  AiJudgeAssertion,
  AiPickStep,
  Assertion,
  AssertStep,
  ClickStep,
  EvalStep,
  EvaluateStep,
  FillStep,
  FlowFile,
  GotoStep,
  LoadedFlow,
  PressStep,
  RunStep,
  SelectStep,
  Step,
  WaitStep,
} from "./flow/index.ts";
export {
  computeSourceHash,
  FlowValidationError,
  loadFlowFile,
  loadFlowFileFlattened,
  parseFlowFile,
} from "./flow/index.ts";
export type {
  Diagnostic,
  LintFileOptions,
  LintResult,
  MultiLintResult,
  Severity,
} from "./lint/index.ts";
// ---- Lint (zero-fs entry + the injectable-fs entries) ----
export {
  expandPaths,
  formatHuman,
  formatJson,
  lintFile,
  lintFlowFile,
  lintPaths,
  lintText,
} from "./lint/index.ts";

// ---- Runner: runFlow + its options/result/cancellation types ----
export {
  computeVerdict,
  RunInterruptedError,
  runFlow,
  systemRunClock,
  VERDICT_EXIT_CODES,
} from "./runner/index.ts";
export type {
  AiRuntimeFactory,
  DriverFactory,
  RunClock,
  RunOptions,
  RunResult,
} from "./runner/types.ts";
export type { FileSystemPort } from "./runtime.ts";
// ---- Filesystem port + capability/env primitives ----
export { ambientEnv, CapabilityError, expandGlob, listTomlFiles } from "./runtime.ts";

// ---- Telemetry sink seam (test/host injection point; no Logfire SDK import here) ----
export type { TelemetrySink } from "./telemetry/index.ts";
