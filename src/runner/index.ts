// Flightplan — runner/ public surface.
//
// The run orchestration engine: `runFlow(opts)` integrates flow/config/driver/ladder/assert/
// artifacts to execute a flow end-to-end (the Phase 2 capstone). The CLI's `run` command and
// the unit tests program against these exports. Canonical reference: PLAN.md §5 Phase 2.

export { runFlow } from "./runner.ts";
export {
  computeVerdict,
  DEFAULT_CONNECT_CONFIG,
  resolveConnectConfig,
  systemRunClock,
  trimFromStep,
  VERDICT_EXIT_CODES,
} from "./runner.ts";
export type { DriverFactory, RunClock, RunOptions, RunResult } from "./types.ts";
