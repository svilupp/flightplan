// Flightplan — assert/ public surface (the deterministic assertion engine).
//
// Wired into the root `src/index.ts` (replacing its P2 TODO stub). Named exports only — no
// `export *` of the condition evaluators (which carry generic names like `text`/`url`/`value`/
// `count` that would collide under the root barrel's `export *`). The six evaluators are
// available namespaced via `conditions` for callers that want them directly.
//
// See PLAN.md §5 Phase 2 (assert/). `ai_judge` is Phase 4 — present in the type switch, routed
// to a clearly-marked `Phase4NotImplementedError` stub.

export type {
  AssertClock,
  AssertContext,
  AssertionResult,
  AssertPhase,
  ConditionOpts,
} from "./types.ts";

export {
  DEFAULT_POLL_INTERVAL_MS,
  FakeClock,
  systemClock,
} from "./clock.ts";

export {
  assertionPhase,
  DEFAULT_ASSERT_TIMEOUT_MS,
  isPhase4NotImplemented,
  Phase4NotImplementedError,
  runAssertion,
  runAssertions,
} from "./engine.ts";

// The six deterministic evaluators + the URL matcher, namespaced to avoid colliding with the
// root barrel's `export *` (names like `text`/`url`/`value`/`count` are too generic to export
// flat). Callers that need a single evaluator: `import { conditions } from '.../assert'`.
export * as conditions from "./conditions.ts";
export { urlMatchesPattern } from "./conditions.ts";
