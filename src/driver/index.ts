// Flightplan — driver module barrel.
//
// The single boundary to browser-pilot. Everything outside `src/driver/*` imports from HERE
// (or transitively via `src/index.ts`), never from browser-pilot directly. Canonical
// reference: PLAN.md §3.

// --- the interface + supporting types ---
export type {
  ActionOpts,
  BatchOptions,
  BatchResult,
  BatchStep,
  ConnectAttachConfig,
  ConnectConfig,
  ConnectLaunchConfig,
  CoveringElement,
  Driver,
  FailureReason,
  FillOpts,
  GotoOpts,
  InteractiveElement,
  PageHandle,
  PageSnapshot,
  PressOpts,
  RefMap,
  ResolveAllOpts,
  ScreenshotOpts,
  SignatureOpts,
  SnapshotNode,
  SnapshotOpts,
  StepResult,
  SubmitOpts,
  TypeOpts,
} from "./types.ts";

// Re-export the concrete browser-pilot `Page` type for the (rare) callers — chiefly the
// ladder — that legitimately need the richer page surface behind `PageHandle`. This keeps
// the `import ... from 'browser-pilot'` confined to the driver module.
export type { Page } from "browser-pilot";

// --- the selector→strategy mapping (ladder + lock depend on it) ---
export { selectorUsedToStrategy, strategyFromStepResult } from "./selector-strategy.ts";

// --- the real implementation ---
export {
  BrowserPilotDriver,
  type BrowserPilotDriverOptions,
  type DialogPolicy,
  withNavigationDefault,
} from "./browser-pilot-driver.ts";

// --- connect-resolution helpers (pure, unit-testable) ---
export {
  attachWsResolutionSource,
  buildAttachConnectArgs,
  buildLaunchPlan,
  connectMode,
  DEFAULT_CHROME_FLAGS,
  normalizeBrowserUrl,
  type ResolvedAttachConnectArgs,
  type ResolvedLaunchPlan,
} from "./connect-resolution.ts";

// --- navigation-settling helpers (pure) ---
export {
  clickStep,
  pressStep,
  resolveWaitForNavigation,
  submitOptions,
} from "./navigation.ts";

// --- the mock testing seam ---
export {
  type DriverCall,
  MockDriver,
  type MockDriverDefaults,
  MOCK_PAGE_HANDLE,
} from "./mock-driver.ts";

// --- fixture factories for tests ---
export {
  makeBatchResult,
  makeFailureBatch,
  makeInteractiveElement,
  makeRankedCandidate,
  makeSnapshot,
  makeStepResult,
  makeSuccessBatch,
} from "./mock-fixtures.ts";
