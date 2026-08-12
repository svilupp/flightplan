// Flightplan — the Driver interface + supporting types.
//
// This module defines the ONE boundary between Flightplan and browser-pilot. The rest of
// the codebase programs against the `Driver` INTERFACE only; it never imports browser-pilot
// directly. If browser-pilot changes, only `src/driver/*` changes.
//
// Canonical references: PLAN.md §3 (driver lifecycle table, connect-config discriminated
// union, wrapped method surface, gotchas-as-defaults) and §4 (the `Strategy` mapping table).
// Source of truth for the browser-pilot API surface:
// docs/research/FINDINGS_browser-pilot.md and browser-pilot's etc/browser-pilot.api.md.
//
// ---------------------------------------------------------------------------------------
// Re-export policy
// ---------------------------------------------------------------------------------------
// browser-pilot's exported types are re-exported HERE (and again from `./index.ts`) so the
// rest of Flightplan imports browser-pilot shapes ONLY through the driver. The two
// exceptions are `FailureReason` and `FailureHint`: both are referenced by `StepResult`
// but are *not* exported from the browser-pilot package root (they are
// `ae-forgotten-export`s — see browser-pilot/etc/browser-pilot.api.md:1237 and :530). We
// therefore re-declare `FailureReason` locally as the documented literal union
// (FINDINGS_browser-pilot §6) and expose the failure-hint shape structurally. This is the
// single justified place where the browser-pilot type surface is reconstructed rather than
// imported (see the report / `any`-cast notes). No `any` is used to do it.

import type {
  AwaitReplyOptions as BpAwaitReplyOptions,
  BatchOptions as BpBatchOptions,
  BatchResult as BpBatchResult,
  CandidateStrategy as BpCandidateStrategy,
  ElementState as BpElementState,
  EmitReply as BpEmitReply,
  EmitResult as BpEmitResult,
  EmitWsOptions as BpEmitWsOptions,
  InteractiveElement as BpInteractiveElement,
  MatchedCondition as BpMatchedCondition,
  PageSnapshot as BpPageSnapshot,
  RankedCandidate as BpRankedCandidate,
  SnapshotNode as BpSnapshotNode,
  SocketCandidate as BpSocketCandidate,
  Step as BpStep,
  StepResult as BpStepResult,
} from "browser-pilot";
import type { ConnectConfig } from "../config/types.ts";
import type { Strategy } from "../types.ts";

// ---------------------------------------------------------------------------
// Re-exported browser-pilot types (the public boundary surface)
// ---------------------------------------------------------------------------

/**
 * browser-pilot's accessibility snapshot. `interactiveElements` is what L1/the fuzzy
 * matcher reads (each carries `ref` + `role` + accessible `name`, plus optional
 * `disabled`/`checked`/`value`). The `selector` field on each element is a SYNTHETIC
 * `[data-backend-node-id="N"]` — NOT a usable DOM selector; resolve by `ref:eN` within a
 * cycle, never persist it (PLAN.md §3 gotchas / FINDINGS §3).
 */
export type PageSnapshot = BpPageSnapshot;

/**
 * The live-DOM state of an arbitrary selector, from browser-pilot's `Page.elementState`. Unlike
 * {@link PageSnapshot} (which is built from the ACCESSIBILITY tree and therefore only surfaces
 * interactive roles), this resolves ANY element — including non-interactive containers like a
 * `<div data-testid="toolbar">` — by plain CSS/attribute selector (`[data-testid='x']`, `#id`,
 * `.class`, descendant combinators) or browser-pilot special selector (`text:`/`role:`, whose
 * `count` is 0 or 1). It pierces shadow roots and honours the current iframe context.
 *  - `exists`      — at least one match in the DOM.
 *  - `visible`     — the first match is visibly rendered (display/visibility/opacity + non-zero box).
 *  - `count`       — number of matches.
 *  - `text`        — first match's trimmed innerText (fallback textContent); `""` if none.
 *  - `boundingBox` — first match's box, or `null` when there is no rendered match.
 */
export type ElementState = BpElementState & {
  /** Optional form/control state exposed by newer browser-pilot builds. */
  checked?: boolean;
  disabled?: boolean;
  selected?: boolean;
};

/**
 * A single interactive element from a snapshot. Exposes role + accessible name (+ optional
 * `disabled`/`checked`/`value`). As of browser-pilot 0.1.0 (Phase 7 Change 3a) it also carries
 * an opt-in `attributes?: Record<string,string>` of real DOM attributes
 * (`data-testid`/`data-test`/`data-qa`/`id`/`class`/`name`/`type`) — populated ONLY when the
 * snapshot was taken with `attributes: true` (see `SnapshotOpts`). The field rides in via the
 * re-exported browser-pilot shape, so no separate declaration is needed.
 */
export type InteractiveElement = BpInteractiveElement;

/** A node in the accessibility tree (role always present; hierarchy; disabled/checked). */
export type SnapshotNode = BpSnapshotNode;

/**
 * A browser-pilot batch step (the union of all action fields keyed by `action`). Exported as
 * `BatchStep` — NOT `Step` — to avoid colliding with Flightplan's flow-level `Step`
 * (`src/flow/types.ts`), which is an entirely different concept (a flow verb). The ladder
 * builds `BatchStep[]` from flow Steps to drive `Driver.batch`.
 */
export type BatchStep = BpStep;

/** The point at which a potentially effectful browser input crossed the page boundary. */
export type DispatchState = "not_dispatched" | "dispatched" | "uncertain";

/** The centralized retry decision emitted by browser-pilot's action executor. */
export type RetryDecisionReason = NonNullable<BpStepResult["retryDecisionReason"]>;

/** Per-step native dialog behavior. `prompt`/`manual` deliberately do not auto-accept. */
export type NativeDialogPolicy = "dismiss" | "accept" | "fail" | "prompt" | "manual";

/** A declarative new-page expectation owned by the triggering action. */
export interface NewPageExpectation {
  opener?: string;
  /** browser-pilot's target identity name; `opener` remains a compatibility alias. */
  openerTargetId?: string;
  url?: string;
  title?: string;
  type?: string | string[];
  targetId?: string;
  timeoutMs?: number;
}

export interface NewPageResult {
  matched: boolean;
  targetId?: string;
  url?: string;
  title?: string;
  type?: string;
  opener?: string;
  openerTargetId?: string;
  reason?: string;
}

/** Runtime identity reported by browser-pilot for the package, source, and generated build. */
export interface BrowserPilotProvenance {
  packageVersion: string;
  gitSourceHash: string;
  buildHash: string;
}

export interface PageStateObservation {
  dialogOpen?: boolean;
  menuOpen?: boolean;
  popupCount?: number;
  activeTargetId?: string;
}

/**
 * Receipt attached to a browser-pilot action when available. The fields are optional at the
 * compatibility boundary because the currently pinned browser-pilot release predates the
 * dispatch receipt, while newer releases may provide richer event-level evidence.
 */
export interface ActionReceipt {
  dispatchState: DispatchState;
  retrySafe?: boolean;
  inputEventsSent?: string[];
  navigationObserved?: boolean;
  attempts?: number;
  /** Compatibility alias for callers that describe the retry decision in the receipt. */
  retryDecisionReason?: RetryDecisionReason;
  retryReason?: string;
}

/** Metadata surfaced by browser-pilot's outcome-aware executor. */
export interface DispatchMetadata {
  dispatchState?: DispatchState;
  retrySafe?: boolean;
  matchedConditions?: BpMatchedCondition[];
  attempts?: number;
  retryDecisionReason?: RetryDecisionReason;
  /** Compatibility alias for early Flightplan metadata consumers. */
  retryReason?: string;
  receipt?: ActionReceipt;
  effect?: "observe" | "idempotent" | "at_most_once";
  anchor?: string;
}

/** The result of one batch step, including optional dispatch-safety metadata. */
export type StepResult = BpStepResult & DispatchMetadata;

/** Browser-pilot outcome-condition evidence, re-exported at the driver boundary. */
export type MatchedCondition = BpMatchedCondition;

/** The result of `batch()` — `{ steps: StepResult[], success, totalDurationMs, ... }`. */
export type BatchResult = Omit<BpBatchResult, "steps"> & { steps: StepResult[] };

/** Options for `batch()` (`onFail`, `record`, `timeout`). */
export type BatchOptions = BpBatchOptions;

/**
 * The per-step outcome from a batch. The fields the escalation ladder cares about:
 *  - `selectorUsed?: string` — which selector in the ordered array actually resolved (L1
 *    reads this to learn the winning strategy; feed it to `selectorUsedToStrategy`).
 *  - `failureReason?: FailureReason` — structured failure category (cheap escalation signal:
 *    `covered` → dismiss-overlay repair, `disabled` → wait/retry, `missing` → re-resolve).
 *  - `coveringElement?: { tag; id?; className? }` — the element blocking a `covered` click.
 *  - `failedSelectors?` — only meaningful on total failure; usually undefined on success.
 *  - `outcomeStatus?` / `retrySafe?` / `matchedConditions?` — outcome-condition evaluation.
 *  - `screenshotPath?` — ONLY populated when `batch(steps, { record })` is configured;
 *    `page.screenshot()` otherwise returns base64 in-memory (FINDINGS §7).
 */
/**
 * The structured failure category on `StepResult.failureReason`. browser-pilot does NOT
 * export the `FailureReason` symbol from its package root (it is an `ae-forgotten-export`,
 * see browser-pilot/etc/browser-pilot.api.md:1237), so this is re-declared from the
 * documented set in FINDINGS_browser-pilot §6. It is kept structurally compatible with
 * `NonNullable<StepResult['failureReason']>` via the compile-time assertion below.
 */
export type FailureReason =
  | "missing"
  | "hidden"
  | "covered"
  | "disabled"
  | "readonly"
  | "detached"
  | "replaced"
  | "notEditable"
  | "timeout"
  | "navigation"
  | "cdpError"
  | "unknown";

// Compile-time guard: our re-declared FailureReason must remain assignable to whatever
// browser-pilot actually types `StepResult.failureReason` as. If browser-pilot widens or
// renames the union, this line fails typecheck and forces us to update the boundary.
type _FailureReasonIsCompatible =
  FailureReason extends NonNullable<BpStepResult["failureReason"]> ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _failureReasonCheck: _FailureReasonIsCompatible = true;

/** The covering-element shape on `StepResult.coveringElement` (a `covered` failure). */
export type CoveringElement = NonNullable<BpStepResult["coveringElement"]>;

// ---------------------------------------------------------------------------
// Connect config (re-exported from the config module — the single source of truth)
// ---------------------------------------------------------------------------

/**
 * The driver connect config — the discriminated union from PLAN.md §3, owned by the config
 * module (`src/config/schema.ts` `ConnectConfigSchema`). The driver re-exports it so callers
 * can `import { ConnectConfig } from '.../driver'` without reaching into config internals.
 *
 *   Mode A (attach): { mode:'attach', wsUrl?, browserURL?, autodiscover?, targetUrl?, sessionName? }
 *   Mode B (launch): { mode:'launch', headless?, channel?, userDataDir?, chromeFlags? }
 *
 * No mismatch with PLAN.md §3 was found — the config module's shape matches the plan
 * verbatim, so the driver reuses it directly (no adaptation needed).
 */
export type { ConnectAttachConfig, ConnectConfig, ConnectLaunchConfig } from "../config/types.ts";

// ---------------------------------------------------------------------------
// Driver-local option shapes
// ---------------------------------------------------------------------------

/**
 * Options for `Driver.snapshot()`.
 *  - `roles` — pass-through to browser-pilot's `SnapshotOptions.roles` (filter the AX tree
 *    to specific roles).
 *  - `attributes` — REAL as of browser-pilot 0.1.0 (Phase 7 Change 3a). When set, the driver
 *    passes `{ attributes: true }` to bp's `snapshot()`, so each `interactiveElements[]` gains
 *    an `attributes?: Record<string,string>` of real DOM attributes
 *    (`data-testid`/`data-test`/`data-qa`/`id`/`class`/`name`/`type`). Omitted/false keeps the
 *    lean default snapshot (no attribute enrichment) — behaviour identical to before the bump.
 */
export interface SnapshotOpts {
  roles?: string[];
  /** Opt-in DOM-attribute enrichment (Phase 7 Change 3a). Default off. */
  attributes?: boolean;
  /**
   * EXTRA DOM attribute names to capture onto `InteractiveElement.attributes` beyond the built-in
   * set (`data-testid`/`data-test`/`data-qa`/`id`/`class`/`name`/`type`), forwarded to
   * browser-pilot's `snapshot({ attributeNames })`. Only meaningful with `attributes: true`. Lets an
   * author-declared hook (`[resolve] attributes`, e.g. `data-cmd`) surface on the snapshot so the
   * ranker + `durableSelectorForElement` can turn a UNIQUE value into a `[data-cmd="c2"]` selector
   * (Fix 2 BONUS). The driver also merges any construction-time `resolveAttributes` here. Default: none.
   */
  attributeNames?: string[];
}

/**
 * Options common to single navigating actions. browser-pilot's `ActionOptions` (the type
 * `click`/`fill`/etc. actually accept) carries ONLY `optional?` and `timeout?` — it has NO
 * `waitForNavigation` field. The driver still exposes `waitForNavigation` here because the
 * wrapper forces navigation settling by routing navigating single-actions through a one-step
 * `batch` whose `Step.waitForNavigation` IS honoured (PLAN.md §3 DRIVER DEFAULT; FINDINGS §5).
 *  - `waitForNavigation` — default `true` for navigating actions (NOT browser-pilot's
 *    `'auto'`), to avoid spurious `ambiguous` outcomes. Set `false`/`'auto'` to override.
 *  - `timeout` — pass-through.
 *  - `optional` — pass-through (a missing element returns `false` instead of throwing).
 */
export interface ActionOpts {
  waitForNavigation?: boolean | "auto";
  timeout?: number;
  optional?: boolean;
}

/** `fill`-specific options (adds `blur`/`verify` over `ActionOpts`). */
export interface FillOpts extends ActionOpts {
  blur?: boolean;
  verify?: boolean;
}

/** `type`-specific options (adds `blur`/`delay` over `ActionOpts`). */
export interface TypeOpts extends ActionOpts {
  blur?: boolean;
  delay?: number;
}

/** `press`-specific options. browser-pilot's `press` takes only `modifiers`. */
export interface PressOpts {
  modifiers?: Array<"Control" | "Shift" | "Alt" | "Meta">;
}

/** `submit`-specific options (`method` + `waitForNavigation`, both real bp `SubmitOptions`). */
export interface SubmitOpts extends ActionOpts {
  method?: "enter" | "click" | "enter+click";
}

// ---------------------------------------------------------------------------
// emit — WebSocket command injection (browser-pilot >=0.2.0 `page.emitMessage`)
// ---------------------------------------------------------------------------

/** A live WebSocket discovered in the page, re-exported from browser-pilot's `emitMessage` surface. */
export type SocketCandidate = BpSocketCandidate;

/** A frame received after an emit, matched by `awaitReply`. */
export type EmitReply = BpEmitReply;

/**
 * How to match a reply frame, the boundary form of browser-pilot's `AwaitReplyOptions`. `where` is
 * a dot-path field-equality map against the parsed JSON reply payload; `match` is a glob against
 * the raw payload text; `timeout` bounds the wait (browser-pilot default 10000ms).
 */
export type EmitAwaitReplyOpts = BpAwaitReplyOptions;

/**
 * Options for `Driver.emitCommand()`. `channel` is restricted to `"ws"` (the only channel
 * browser-pilot currently supports); `payload` is ALWAYS a string here — an inline-table flow
 * payload is JSON-serialized by the caller (the runner) before it reaches the driver, since
 * browser-pilot's `emitMessage` only accepts a string. `match`/`base64`/`awaitReply`/`confirmTimeout`
 * are the boundary form of browser-pilot's `EmitWsOptions`.
 */
export interface EmitCommandOptions extends Omit<BpEmitWsOptions, "awaitReply"> {
  channel: "ws";
  payload: string;
  awaitReply?: EmitAwaitReplyOpts;
}

/**
 * The result of `Driver.emitCommand()` — the boundary form of browser-pilot's `EmitResult`.
 * `delivered` is proven by a `Network.webSocketFrameSent` CDP event, NOT by a normal `send()`
 * return (a closed-socket `send()` silently discards data). `reply` is populated only when
 * `awaitReply` was requested AND a correlated reply frame arrived within its timeout.
 */
export type EmitCommandResult = BpEmitResult;

/** Options for `Driver.screenshot()`. Returns base64 (FINDINGS §7). */
export interface ScreenshotOpts {
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  fullPage?: boolean;
}

/**
 * Options for {@link Driver.startRecording} — opt-in run video / frame capture (Phase 5,
 * Unit F; gated by `[browser] record`, default off).
 *  - `dir` — the directory the driver records into. Against browser-pilot v0.0.18 this is the
 *    `outputDir` for bp's screenshot-frame `record` mode (per-step frames + a `recording.json`
 *    manifest land here); a future webm-capable bp would emit the video into this dir too. The
 *    runner (Unit E) passes the run's `screenshots/` dir (`RunDir.screenshotsDir`) so frames
 *    live alongside the other run evidence.
 */
export interface RecordOpts {
  dir: string;
}

/**
 * Options for `Driver.goto()` — top-level navigation to a URL.
 *  - `timeout` — pass-through to browser-pilot's `page.goto` `ActionOptions.timeout`.
 *  - `waitForNavigation` — DRIVER DEFAULT `true`: after `page.goto` resolves, the driver also
 *    settles any client-side navigation (`page.waitForNavigation`) so the page is quiescent
 *    before the next step's snapshot/assertion runs (mirrors the navigating-action default,
 *    PLAN.md §3 DRIVER DEFAULT; FINDINGS §5/§14 "force navigation settling"). Set `false` to
 *    return as soon as `page.goto` resolves (bp's `goto` already awaits the load event).
 */
export interface GotoOpts {
  timeout?: number;
  waitForNavigation?: boolean;
}

/** Options for `captureStateSignature()`. */
export interface SignatureOpts {
  /**
   * Which page signature to capture (Phase 7 Change 4 — now REAL against browser-pilot 0.1.0):
   *  - `'text'` (default/absent) → bp's text-hash `captureStateSignature` (`"{url}|{hash}"`, a
   *    hash of the first ~2000 chars of visible text). Behaviour identical to before the bump.
   *  - `'structure'` → bp's `captureStructureSignature` (`"{urlPath}|{hash}"`, a pure role-tree
   *    hash that is stable across text/content churn). Selects the structural skeleton.
   * This is the boundary form of browser-pilot's `stateSignatureChanges` `mode?: 'text'|'structure'`.
   */
  mode?: "text" | "structure";
  /**
   * Structural masking selectors, forwarded to browser-pilot's `captureStructureSignature`
   * `maskSelectors` (L0 cache-hit quality — Layer 2 `[cache] ignore_regions`). Only meaningful for
   * `mode: 'structure'`; each entry prunes a node (and its subtree) matched by role/name/ref/
   * role-name from the structural hash, so an `ignore_regions` subtree is excluded from the struct
   * component just as it is from the masked-text component. Omitted → the default structural hash.
   */
  maskSelectors?: string[];
}

/**
 * A page handle. The driver returns the live browser-pilot `Page` as an opaque handle typed
 * via `PageHandle` so callers that only need lifecycle (most of Flightplan) don't couple to
 * the full `Page` surface, while the ladder — which legitimately needs richer page ops — can
 * narrow it. We re-export the concrete `Page` type from `./index.ts` for that use; the
 * interface keeps it abstract.
 */
export type PageHandle = unknown;

/** The ref map exported/imported within a single resolution cycle (`{ "e12": <id> }`). */
export type RefMap = Record<string, number>;

// ---------------------------------------------------------------------------
// resolveAll — native candidate ranking (Phase 7 Change 3)
// ---------------------------------------------------------------------------

/**
 * One ranked candidate from `Driver.resolveAll` — the boundary form of browser-pilot 0.1.0's
 * native `RankedCandidate`. Its fields are deliberately IDENTICAL to Flightplan's own
 * `RankedCandidate` (`src/ladder/types.ts`) — `ref?/role/name/selector/strategy/score`, with
 * `strategy` the shared `Strategy` union (= bp's `CandidateStrategy`) — so a consumer can swap
 * its Flightplan-computed candidates for `driver.resolveAll(...)` results with NO adaptation
 * (structural assignability). The `_RankedCandidate*` guards below enforce the 1:1 shape match
 * against bp so the mapping in `browser-pilot-driver.ts` stays total.
 *
 * NOTE: this type is intentionally NOT re-exported from `./index.ts`. Flightplan's root barrel
 * (`src/index.ts`) `export *`s both the driver and the ladder, and the ladder already owns a
 * public `RankedCandidate` of the same shape; re-exporting a second one would collide there.
 * Callers needing the name import it from `./types.ts` (driver) or the ladder — either works.
 */
export interface RankedCandidate {
  ref?: string;
  role: string;
  name: string;
  selector: string;
  strategy: Strategy;
  score: number;
}

// Compile-time guards: the driver's RankedCandidate (and the Strategy union it uses) must stay
// structurally identical to browser-pilot's native `RankedCandidate` / `CandidateStrategy`, so
// `resolveAll`'s 1:1 field mapping is total and consumers can switch to the native shape with no
// adaptation. If browser-pilot widens/renames either, one of these fails typecheck and forces a
// boundary update (same discipline as `_FailureReasonIsCompatible`).
type _RankedCandidateMatchesBp = RankedCandidate extends BpRankedCandidate
  ? BpRankedCandidate extends RankedCandidate
    ? true
    : never
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _rankedCandidateCheck: _RankedCandidateMatchesBp = true;

type _StrategyMatchesCandidateStrategy = Strategy extends BpCandidateStrategy
  ? BpCandidateStrategy extends Strategy
    ? true
    : never
  : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _strategyCheck: _StrategyMatchesCandidateStrategy = true;

/**
 * Options for `Driver.resolveAll` — the boundary form of browser-pilot's `page.resolveAll`
 * opts, passed through 1:1.
 *  - `action`        — the intended verb (`'click'`/`'fill'`/…), so ranking can prefer
 *                      actionable candidates.
 *  - `limit`         — cap on the number of ranked candidates returned.
 *  - `includeHidden` — include hidden elements in the candidate set (default: only visible).
 *  - `strategies`    — restrict which candidate strategies are considered (the shared
 *                      `Strategy` union = bp's `CandidateStrategy`).
 *  - `minConfidence` — drop candidates scoring below this threshold.
 *  - `snapshot`      — rank against a pre-captured snapshot instead of taking a fresh one.
 */
export interface ResolveAllOpts {
  action?: string;
  limit?: number;
  includeHidden?: boolean;
  strategies?: Strategy[];
  minConfidence?: number;
  snapshot?: PageSnapshot;
  /**
   * EXTRA DOM attribute names the ranker may use as deterministic hooks, in addition to the
   * built-in `data-testid`/`data-test`/`data-qa` set (browser-pilot's `resolveAll({ testIdAttributes })`).
   * A UNIQUE value produces a high-confidence `[attr="value"]` candidate (e.g. `[data-cmd="c2"]`),
   * so an icon-only toolbar can resolve deterministically (Fix 2 BONUS). The driver merges any
   * construction-time `resolveAttributes` here. Default: none (unchanged ranking).
   */
  testIdAttributes?: string[];
}

// ---------------------------------------------------------------------------
// The Driver interface
// ---------------------------------------------------------------------------

/**
 * The single typed boundary to browser-pilot. `BrowserPilotDriver` (real) and `MockDriver`
 * (test seam) both implement it. Everything in Flightplan outside `src/driver/*` programs
 * against THIS interface and never imports browser-pilot.
 *
 * Lifecycle contract: `connect(cfg)` MUST be called before any page op; `page()` returns the
 * live page handle (after connect); `teardown()` releases everything (Mode A: detach-only,
 * never kills a BYO Chrome; Mode B: detach + kill the launched Chrome).
 */
export interface Driver {
  // --- lifecycle ---

  /** Resolve the connection (Mode A attach / Mode B launch) and acquire a page. */
  connect(cfg: ConnectConfig): Promise<void>;

  /** The live page handle. Throws if called before `connect()`. */
  page(): Promise<PageHandle>;

  /** Release the connection. Mode A: detach only (Chrome survives). Mode B: detach + kill. */
  teardown(): Promise<void>;

  /** Change the native-dialog policy for the next logical step, when supported. */
  setDialogPolicy?(policy: NativeDialogPolicy): void | Promise<void>;

  /** Runtime browser-pilot package/source/build identity for run artifacts. */
  provenance?(): BrowserPilotProvenance | undefined;

  /**
   * Observe a new page around one action. Implementations must arm observation before dispatch;
   * a missing capability is a hard observation failure for a declared expectation.
   */
  expectNewPage?(
    expectation: NewPageExpectation,
    action: () => Promise<unknown>,
  ): Promise<NewPageResult>;

  /** Optional read-only page identity/state surface used by state assertions and run artifacts. */
  pageState?(): Promise<PageStateObservation>;

  /**
   * Clear the current origin's client-side state — `localStorage`, `sessionStorage`, and cookies —
   * for per-run/per-scenario ISOLATION so state never leaks between flows in a shared window/sweep.
   * A cross-agent contract point: it MAY be unused for now, but a future isolation hook can call it
   * (e.g. before a flow that assumes a clean session). Best-effort; never part of the resolution
   * path. `MockDriver` implements it as a recorded no-op.
   */
  clearBrowserState(): Promise<void>;

  // --- navigation ---

  /**
   * Navigate the active page to `url` (a `goto` step). Maps to browser-pilot's
   * `page.goto(url, { timeout? })`; with the driver default `waitForNavigation: true` it then
   * settles any follow-on client-side navigation before returning, so the page is quiescent for
   * the next snapshot/assertion (PLAN.md §3 DRIVER DEFAULT). This is the ONE navigation entry
   * point — the runner's `goto` step dispatches here and never touches browser-pilot directly.
   */
  goto(url: string, opts?: GotoOpts): Promise<void>;

  /** The current page URL (browser-pilot `page.url()`). Used for the L0 `match.url_glob` gate
   * and for run context (`ResolveContext.currentUrl`). Throws if called before `connect()`. */
  currentUrl(): Promise<string>;

  // --- frame switching (same-origin iframe / OOPIF context) ---

  /**
   * Enter a same-origin `<iframe>` (and, per browser-pilot, a genuine cross-origin OOPIF) so that
   * SUBSEQUENT page ops — `snapshot`/`batch`/`click`/`fill`/`elementState`/assertions — resolve
   * INSIDE that frame. `selector` identifies the `<iframe>` ELEMENT in the CURRENT document (an
   * ordered CSS/attribute/`ref:`/`role:`/`text:` selector list, tried in order). Delegates to
   * browser-pilot's `Page.switchToFrame`. Returns `true` when the frame was entered; `false` when
   * the iframe element could not be found / attached (a clean step failure — never a throw).
   *
   * Frame context is STATEFUL: it persists across ops until {@link switchToMain}, a {@link goto}
   * navigation, or {@link teardown} — all of which reset to the top document. IMPORTANT: the driver
   * keeps in-frame resolution working ACROSS snapshots. browser-pilot's `snapshot()` reads the
   * top-document accessibility tree and, as a side effect, invalidates the active frame root; the
   * driver therefore re-establishes the frame around each snapshot so the next in-frame action does
   * not silently mis-resolve against the parent document.
   */
  switchToFrame(selector: string | string[]): Promise<boolean>;

  /**
   * Leave the current frame and return to the top document (browser-pilot's `Page.switchToMain`).
   * A no-op-safe counterpart to {@link switchToFrame}; safe to call when already on the top document.
   */
  switchToMain(): Promise<void>;

  /**
   * The selector of the frame currently switched into, or `null` when operating on the top document
   * (browser-pilot's `Page.getCurrentFrame`). L1 reads this to RELAX its iframe mis-resolution guard
   * once a target's frame has been entered: while switched, an in-frame target is legitimately
   * reachable and must not be rejected as "exists only inside an iframe".
   */
  currentFrame(): string | null;

  // --- page operations (thin pass-throughs) ---

  /**
   * One accessibility snapshot. `opts.roles` filters the AX tree; `opts.attributes` opts into
   * real DOM-attribute enrichment (browser-pilot 0.1.0 — Phase 7 Change 3a). The returned
   * `interactiveElements` (role + accessible name + optional state/attributes) are what L1 and
   * the driver's native `resolveAll` ranking consume.
   */
  snapshot(opts?: SnapshotOpts): Promise<PageSnapshot>;

  /**
   * Execute an ordered batch of browser-pilot steps. Returns a `BatchResult` whose
   * `steps: StepResult[]` surface `selectorUsed` / `failureReason` / `coveringElement` (the
   * cheap escalation signals). Navigating steps without an explicit `waitForNavigation` are
   * defaulted to `true` by the wrapper (PLAN.md §3 DRIVER DEFAULT).
   */
  batch(steps: BatchStep[], opts?: BatchOptions): Promise<BatchResult>;

  /**
   * Rank candidate elements for an NL `intent`, delegating to browser-pilot 0.1.0's native
   * `page.resolveAll` (Phase 7 Change 3). Returns candidates best-first, each carrying
   * `ref?/role/name/selector/strategy/score` — the same shape as Flightplan's own
   * `RankedCandidate`, so a consumer can adopt native ranking without changing its downstream
   * types. This is ADDITIVE: Flightplan's own fuzzy matcher (`src/ladder/fuzzy.ts`) is untouched
   * and still the live path; a later wave rewires consumers onto this method.
   */
  resolveAll(intent: string, opts?: ResolveAllOpts): Promise<RankedCandidate[]>;

  /**
   * Inspect the live-DOM {@link ElementState} of an arbitrary `selector`, delegating to
   * browser-pilot's `Page.elementState`. This resolves ARBITRARY DOM — including
   * non-interactive elements (a `<div data-testid="toolbar">`, a table row, a heading) — by
   * plain CSS/attribute selector (`[data-testid='x']`, `#id`, `.class`) or special selector
   * (`text:`/`role:`), UNLIKE {@link snapshot} which is accessibility-tree-only and therefore
   * enumerates just interactive roles. The assertion engine uses it to verify
   * presence/visibility/text/count of synthetic/CSS-selected elements that never appear in the
   * AX snapshot.
   *
   * OPTIONAL so a driver that predates the primitive degrades gracefully: callers MUST
   * feature-detect (`driver.elementState?.(...)`) and fall back to the snapshot path when it is
   * undefined (no regression for AX-resolvable `role:`/`text:`/`plain` targets).
   */
  elementState?(selector: string): Promise<ElementState>;

  /**
   * Probe which browsing context a PLAIN CSS `selector` matches in, delegating to browser-pilot's
   * `Page.locateSelectorFrame`. Returns `'main'` (matches the current document), `'iframe'` (matches
   * ONLY inside a same-origin iframe the AX snapshot does not pierce), or `'none'` (no reachable
   * match). Intended for the FAILURE / not-found path only: it runs one in-page `Runtime.evaluate`
   * and must never touch the happy path. L1 uses it to catch the silent-mis-resolution trap where a
   * testid/attribute hint exists ONLY inside an iframe (so the snapshot can't see it) and resolution
   * would otherwise fall back to a look-alike parent element.
   *
   * `ref:`/`role:`/`text:` selectors are NOT iframe-scoped and always report against the current
   * document, so callers should probe only plain CSS/attribute selectors (leading `[`).
   *
   * OPTIONAL so a driver that predates the primitive (or `MockDriver` in a test that does not opt in)
   * degrades gracefully: callers MUST feature-detect (`driver.locateSelectorFrame?.(...)`) and skip
   * the guard when it is undefined (no regression for AX-resolvable targets).
   */
  locateSelectorFrame?(selector: string): Promise<"main" | "iframe" | "none">;

  // --- single actions (each returns whether the action succeeded) ---

  /** Click. Navigating → defaults to `waitForNavigation: true`. */
  click(sel: string | string[], opts?: ActionOpts): Promise<boolean>;
  /** Fill an input. */
  fill(sel: string | string[], value: string, opts?: FillOpts): Promise<boolean>;
  /** Type text (keypress-by-keypress). */
  type(sel: string | string[], text: string, opts?: TypeOpts): Promise<boolean>;
  /** Select an option (or options) in a `<select>`. */
  select(sel: string | string[], value: string | string[], opts?: ActionOpts): Promise<boolean>;
  /** Check a checkbox/radio. */
  check(sel: string | string[], opts?: ActionOpts): Promise<boolean>;
  /** Hover. */
  hover(sel: string | string[], opts?: ActionOpts): Promise<boolean>;
  /** Press a key (with optional modifiers). Defaults to navigation settling. */
  press(key: string, opts?: PressOpts): Promise<boolean>;
  /** Submit a form. `sel` optional (submits the focused/ambient form). Navigating → settles. */
  submit(sel?: string | string[], opts?: SubmitOpts): Promise<boolean>;

  // --- emit (WebSocket command injection) ---

  /**
   * Send a message on a WebSocket the page itself owns, delegating to browser-pilot's
   * `page.emitMessage` (>=0.2.0). Never retried — a dispatched frame is an irreversible side
   * effect on the server, so this is inherently `effect = "at_most_once"` at the flow level.
   * `EmitTargetError`-shaped ambiguous-socket failures and delivery/reply-timeout failures both
   * surface as a normal rejected promise; the caller (the runner) maps them to a step failure
   * rather than an infra error. OPTIONAL so a driver built against browser-pilot <0.2.0 degrades
   * gracefully: callers MUST feature-detect (`driver.emitCommand?.(...)`) and fail the `emit` step
   * with a clear "browser-pilot >=0.2.0 required" message when absent.
   */
  emitCommand?(opts: EmitCommandOptions): Promise<EmitCommandResult>;

  // --- screenshot ---

  /** Capture a screenshot. Returns base64 (FINDINGS §7) — consumed directly by L3 vision. */
  screenshot(opts?: ScreenshotOpts): Promise<string>;

  // --- video / frame recording (OPT-IN; gated by `[browser] record`, default off) ---
  //
  // These three members are OPTIONAL on the interface so the capability is purely additive and
  // feature-detected (`driver.startRecording?.(...)`). A run with recording disabled (the
  // default) never calls them and behaves exactly as before — video is inert by default.
  // Both `BrowserPilotDriver` and `MockDriver` implement them. Lifecycle wiring (start at run
  // begin, stop + finalize at run end, collect screenshot paths, fill `RunSummary.video_path` /
  // `screenshot_paths`) is Unit E (runner) — see the design's "Runner lifecycle (Unit E)".

  /**
   * Begin opt-in recording into `opts.dir`. Never throws — video must never break a run.
   * Against browser-pilot v0.0.18 this enables bp's screenshot-frame `record` mode on
   * subsequent `batch()` calls (frames + a `recording.json` manifest land in `opts.dir`); a
   * single webm is NOT produced (Risk V1 — graceful degrade). Feature-detect before calling.
   */
  startRecording?(opts: RecordOpts): Promise<void>;

  /**
   * Stop recording and return the produced video file path, or `null` when no single video
   * artifact was produced — the graceful-degrade case for browser-pilot v0.0.18, which captures
   * frames rather than a webm (Risk V1). Captured frames remain on disk regardless. The runner
   * puts this return value into `RunSummary.video_path` (null stays null). Feature-detect.
   */
  stopRecording?(): Promise<string | null>;

  /**
   * Persist a single screenshot frame to `path` (creating parent dirs as needed) and return the
   * written path, or `null` on any failure (never throws). Lets the runner save a per-step /
   * per-failed-step frame into `RunDir.screenshotsDir` and collect the non-null returns into
   * `RunSummary.screenshot_paths`. Feature-detect before calling.
   */
  saveScreenshot?(path: string, opts?: ScreenshotOpts): Promise<string | null>;

  // --- ref persistence (within one resolution cycle only) ---

  /** Export the current ref map (`{ "e12": <backendNodeId> }`). Never persist across loads. */
  exportRefMap(): RefMap;
  /** Import a ref map captured earlier in the SAME cycle. */
  importRefMap(map: RefMap): void;

  // --- page signature ---

  /**
   * The page signature. `opts.mode` selects which (Phase 7 Change 4 — both now REAL against
   * browser-pilot 0.1.0):
   *  - `'text'` (default/absent) → bp's `captureStateSignature` → `"{url}|{hash}"` (hash of the
   *    first ~2000 chars of visible text — FINDINGS §5). Unchanged from the baseline.
   *  - `'structure'` → bp's `captureStructureSignature` → `"{urlPath}|{hash}"` (a pure role-tree
   *    hash, stable across text churn).
   */
  captureStateSignature(opts?: SignatureOpts): Promise<string>;
}
