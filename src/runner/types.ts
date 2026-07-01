// Flightplan — runner types (RunOptions / RunResult).
//
// The orchestration engine's public contract. `runFlow(opts: RunOptions): Promise<RunResult>`
// loads + templates a flow, resolves config, drives the driver + ladder + assertion engine,
// emits artifacts, and returns the in-memory equivalent of the on-disk `RunSummary`.
//
// Everything the runner needs that touches the outside world (the browser, the wall clock) is
// injectable so the unit tests run with a `MockDriver` + a fake clock — no real Chrome, no real
// server, no real sleeping. Production wiring (the CLI) supplies the real `BrowserPilotDriver`
// factory and the system clock by default.
//
// Canonical references: PLAN.md §4 (RunSummary / RunLimits / connect), §5 Phase 2 (runner is
// the capstone that integrates flow/config/driver/ladder/assert/artifacts).

import type { ResolvedConfig, ConnectConfig } from "../config/types.ts";
import type { Driver } from "../driver/index.ts";
import type { RunSummary } from "../artifacts/index.ts";
import type { AiRuntime, AiRuntimeDeps } from "../ai/index.ts";
import type { TelemetrySink } from "../telemetry/index.ts";

/**
 * A factory that produces a fresh {@link Driver} for one run. Injected so tests pass a
 * `MockDriver` and production passes a `BrowserPilotDriver`. Called exactly once per
 * `runFlow`, BEFORE `connect()`.
 */
export type DriverFactory = (connectCfg: ConnectConfig) => Driver;

/**
 * A factory that produces the {@link AiRuntime} for one run (the L2/L3/L4 hooks, the `ai_judge`
 * oracle, budgets, and cost rollup). Mirrors the `driverFactory` seam: tests inject a factory
 * that builds the runtime around a FAKE `GenerateFn` (no network, no SDK) so the AI tiers run
 * offline; production leaves it unset and the runner builds the real OpenRouter-backed runtime,
 * gated on the configured API-key env var being present.
 *
 * The runner supplies everything EXCEPT the model-call seam (`generate`): the factory provides
 * its own `generate` (a fake in tests). The canonical implementation is
 * `createAiRuntime` — a test factory is typically `(deps) => createAiRuntime({ ...deps, generate })`.
 */
export type AiRuntimeFactory = (deps: Omit<AiRuntimeDeps, "generate">) => AiRuntime;

/**
 * A clock seam for the runner. `now()` stamps artifact events deterministically; `sleep(ms)`
 * backs the `wait` step (and any internal delay) so tests advance time instantly instead of
 * blocking. Mirrors the assert engine's `AssertClock` shape so the same fake clock can drive
 * both the runner and the assertion polling loop.
 */
export interface RunClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Everything `runFlow` needs for one run. The CLI builds this from `ParsedArgs` + a resolved
 * config; tests build it directly with an injected driver factory + clock.
 */
export interface RunOptions {
  /** Absolute or cwd-relative path to the flow .toml to run. */
  flowPath: string;
  /**
   * The fully-resolved config (built-in → global → imported → flow → CLI). The runner reads
   * `run` (budgets / assertion mode / fail_on_assertion / timeout), `connect` (the connect
   * config; defaults to Mode B headless launch when absent), and `redaction`.
   */
  config: ResolvedConfig;
  /** Output base directory for run artifacts (CLI `-o/--out`). Defaults to `.flightplan-runs/`. */
  out?: string;
  /** CI mode: heal at runtime, report drift, do not persist the lock (Phase 3). Accepted in P2. */
  frozen?: boolean;
  /** Suppress all lock writes (Phase 3). Accepted in P2 (no lock is written anyway). */
  noLockWrite?: boolean;
  /** Override the lock file path (Phase 3). Accepted in P2. */
  lockPath?: string;
  /** Resume the run starting at this step id (CLI `--from`); earlier steps are skipped. */
  fromStep?: string;
  /** Machine-readable output mode (the caller prints the summary JSON). */
  json?: boolean;
  /**
   * Which ladder tier `resolveStep` starts at (CLI `--start-tier`; see
   * `ladder/orchestrator.ts` `OrchestratorOptions.startTier`). Defaults to `"L0"` (the normal
   * ladder — omitting this is byte-identical to before). `"L3"` is the "AI-only baseline" mode:
   * every step skips L0 (lock replay) + L1 (deterministic DOM heuristics) and resolves directly
   * via L3 (vision), still falling through to L4 on an L3 escalation. Requires an AI runtime
   * (an API key, or an injected `aiRuntimeFactory`) — otherwise every step fails with a clear
   * error explaining why.
   */
  startTier?: "L0" | "L3";
  /**
   * Environment used to resolve `${env.*}` in inputs/templating. Defaults to `process.env`.
   * Injected by tests so env refs are hermetic.
   */
  env?: Record<string, string | undefined>;

  // --- injectable seams (tests override; production uses the defaults) ---

  /**
   * Factory for the browser {@link Driver}. Defaults to a `BrowserPilotDriver`. Tests pass a
   * factory returning a scripted `MockDriver`.
   */
  driverFactory?: DriverFactory;
  /**
   * Factory for the {@link AiRuntime} (Phase 4). When provided it is used INSTEAD of building the
   * real OpenRouter-backed runtime — this is how tests inject a fake `GenerateFn` with no network.
   * When absent, the runner builds the real runtime ONLY if the configured API-key env var
   * (`[ai].api_key_env`, default `OPENROUTER_API_KEY`) is present in `env`; otherwise AI tiers are
   * unavailable and AI-less runs behave exactly as in P2/P3.
   */
  aiRuntimeFactory?: AiRuntimeFactory;
  /**
   * Test seam for telemetry (Phase 5). When provided, the run's {@link createTelemetry} uses this
   * sink INSTEAD of building a real `LogfireSink`, so tests inject a `FakeSink` and assert
   * spans/events without a token or network. Mirrors `driverFactory`/`aiRuntimeFactory`. When
   * absent, telemetry is gated on `[telemetry.logfire]` + a resolvable token (no-op when off).
   */
  telemetrySink?: TelemetrySink;
  /** Injectable clock for deterministic event timestamps + `wait` sleeps. */
  clock?: RunClock;
  /**
   * Injectable run-id source so the run directory name is reproducible in tests. Passed
   * straight to `createRun`.
   */
  runId?: string;
}

/**
 * The in-memory result of a run. Carries the full {@link RunSummary} (the same object written
 * to `summary.json` and printed under `--json`), plus the resolved run-directory path and the
 * computed process exit code, so the CLI can render output + exit without re-deriving anything.
 */
export interface RunResult {
  /** The structured run summary (identical to the on-disk `summary.json`). */
  summary: RunSummary;
  /** Absolute path to the run directory the artifacts were written under. */
  runDir: string;
  /**
   * The process exit code this run maps to (PLAN.md §4 verdict → exit):
   *   passed → 0 · failed → 1 · error → 2 · inconclusive → 3.
   */
  exitCode: number;
}
