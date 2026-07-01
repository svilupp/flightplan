// Flightplan — auto-repair (Unit D): deterministic, pre-model page recovery.
//
// Cheap, deterministic recovery that keeps many failures off the L2/L3/L4 model tiers
// (PLAN.md §5 Phase 5 deliverable; §7 "Auto-repair via failureReason/coveringElement"). When L1
// fails carrying a structured `failureReason`, the orchestrator calls `attemptRepair` BEFORE the
// AI climb. Three failure classes are repaired:
//
//   covered  → dismiss the covering overlay (Escape, then click the overlay by #id/.class), retry L1.
//   disabled → poll the target's enabled state (bounded by pollMaxTicks × pollIntervalMs), retry L1.
//   missing  → short settle, then re-run L1 (L1 always takes a fresh snapshot — l1.ts:215).
//
// =========================================================================================
// Repair ≠ heal ≠ drift (PLAN P5 §1 design decision; Risk R2)
// =========================================================================================
// A repair is a PRE-ACTION page recovery that lets L1 resolve at all; it does NOT by itself imply
// the resolved recipe changed. Heal/`drift_count` is detected independently by
// `LockSession.recordResolution` (via `signatureBasis`). So repair is ORTHOGONAL to heal/drift:
// it is surfaced ONLY as observability — extra `resolution_attempt` entries (with a `repair:` note)
// that the runner already emits as trace events — never as a verdict or drift signal. This module
// therefore RETURNS attempts; it never writes artifacts and never touches `drift_count`.
//
// =========================================================================================
// Bounds (Risk R1 — repair must never loop/hang; repairs are FREE of model budget)
// =========================================================================================
// Repairs make NO model calls (no L2/L3/L4), so they do NOT touch `max_model_calls`/`max_cost_usd`/
// `max_screenshots`/`max_steps`. They consume wall-clock only, and that is hard-bounded:
//   - `maxAttempts` (default 2): total repair iterations across this call.
//   - `pollMaxTicks` (default 8) × `pollIntervalMs` (default 250ms): the `disabled` poll ceiling.
//   - `settleMs` (default 150ms): the `missing` settle.
// All delays go through `ctx.sleep` (injectable → fake clock in tests; defaults to a real timer).
// An exhausted repair simply escalates to the AI tiers exactly as today.

import type { Step } from "../flow/types.ts";
import type { CoveringElement, InteractiveElement } from "../driver/index.ts";
import { type L1Options, resolveL1 } from "./l1.ts";
import type { ResolutionAttempt, ResolveContext, StepExecution } from "./types.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The three repairable L1 failure classes. */
export type RepairKind = "covered" | "disabled" | "missing";

/** Tunables for auto-repair. All defaulted; the orchestrator threads these from its options. */
export interface RepairOptions {
  /** Max total repair iterations (covered/disabled/missing) before escalating. Default 2. */
  maxAttempts?: number;
  /** Delay between `disabled` poll ticks, in ms. Default 250. */
  pollIntervalMs?: number;
  /** Max `disabled` poll ticks before giving up. Default 8. */
  pollMaxTicks?: number;
  /** Settle delay before a `missing` re-resolve, in ms. Default 150. */
  settleMs?: number;
}

/**
 * The outcome of an auto-repair attempt.
 *  - `execution` — the latest `StepExecution` (the repaired-and-retried L1 result, or the original
 *                  `l1Exec` when nothing was repairable). The orchestrator inspects this: if it
 *                  resolved (ok) or no longer escalates, return it; otherwise feed it to the AI climb.
 *  - `attempts`  — the `ResolutionAttempt[]` produced by the repair (one per retry, each carrying a
 *                  `repair:` note). Empty when no repair was attempted. The runner emits these as
 *                  `resolution_attempt` trace events for free.
 *  - `repaired`  — true iff a repair attempt made the step resolve (`execution.ok`).
 *  - `kind`      — the last repair class attempted (for observability), if any.
 */
export interface RepairResult {
  execution: StepExecution;
  attempts: ResolutionAttempt[];
  repaired: boolean;
  kind?: RepairKind;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_MAX_TICKS = 8;
const DEFAULT_SETTLE_MS = 150;

/** A real `setTimeout`-based sleep, used when `ctx.sleep` is not injected (no runner change needed). */
function realSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map a StepResult `failureReason` onto the repair class that handles it. Anything outside the
 * three repairable classes returns `undefined` → no repair, escalate as today. `detached`/`replaced`
 * are treated as `missing` (the element went away → settle + re-resolve).
 */
export function mapFailureReason(
  failureReason: StepExecution["failureReason"],
): RepairKind | undefined {
  switch (failureReason) {
    case "covered":
      return "covered";
    case "disabled":
      return "disabled";
    case "missing":
    case "detached":
    case "replaced":
      return "missing";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Per-kind repair actions
// ---------------------------------------------------------------------------

/** Build a stable CSS selector for a covering overlay, or undefined if it has no stable handle. */
function coveringSelector(el: CoveringElement | undefined): string | undefined {
  if (!el) return undefined;
  if (el.id) return `#${el.id}`;
  if (el.className) {
    const first = el.className.split(/\s+/).filter(Boolean)[0];
    if (first) return `.${first}`;
  }
  return undefined;
}

/**
 * Dismiss the covering overlay: press Escape, then (if the overlay has a stable selector) click it
 * optionally. Returns a human note describing what was tried (for the `resolution_attempt`).
 */
async function dismissCovering(exec: StepExecution, ctx: ResolveContext): Promise<string> {
  const parts: string[] = ["escape"];
  await ctx.driver.press("Escape");
  const sel = coveringSelector(exec.coveringElement);
  if (sel) {
    await ctx.driver.click(sel, { optional: true });
    parts.push(`click ${sel}`);
  }
  return `repair:covered→${parts.join("+")}; retry`;
}

/** The target identity (role + accessible name) carried by the failed L1 exec, for re-finding it. */
function identifyTarget(exec: StepExecution): { role: string; name: string } | undefined {
  const c = exec.candidates?.[0];
  if (c) return { role: c.role, name: c.name };
  const m = exec.handoff?.topMatches?.[0];
  if (m) return { role: m.role, name: m.name };
  return undefined;
}

/** Find the target element in a fresh snapshot's interactive elements by role + accessible name. */
function findTarget(
  elements: InteractiveElement[],
  target: { role: string; name: string },
): InteractiveElement | undefined {
  return elements.find((e) => e.role === target.role && e.name === target.name);
}

/**
 * Poll the target element's enabled state up to `pollMaxTicks` times (sleep → snapshot → check).
 * Returns whether it became enabled and how many ticks elapsed. Bounded — never loops unbounded.
 */
async function pollUntilEnabled(
  exec: StepExecution,
  ctx: ResolveContext,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
  pollMaxTicks: number,
): Promise<{ enabled: boolean; ticks: number }> {
  const target = identifyTarget(exec);
  for (let tick = 1; tick <= pollMaxTicks; tick++) {
    await sleep(pollIntervalMs);
    const snapshot = await ctx.driver.snapshot();
    // No identity to check against → we can only settle; re-resolve will re-decide.
    if (!target) return { enabled: false, ticks: tick };
    const el = findTarget(snapshot.interactiveElements, target);
    if (el && !el.disabled) return { enabled: true, ticks: tick };
  }
  return { enabled: false, ticks: pollMaxTicks };
}

// ---------------------------------------------------------------------------
// The repair engine
// ---------------------------------------------------------------------------

/**
 * Attempt a bounded auto-repair on a failed L1 execution, re-running L1 after each repair action.
 *
 * Loops up to `maxAttempts` times. Each iteration: classify the current `failureReason`
 * (`mapFailureReason`); if unrepairable, stop and escalate. Otherwise perform the class's repair
 * action, re-run L1, and record a `ResolutionAttempt` carrying a `repair:` note. Stops early when
 * L1 resolves (or returns a terminal non-escalating result), or when a `disabled` poll exhausts
 * without the element ever enabling (re-polling a never-enabling element is pointless).
 *
 * Returns the latest execution + the repair attempts. NEVER makes a model call; NEVER touches the
 * model budget; ALL waits go through `ctx.sleep` (injectable).
 */
export async function attemptRepair(
  step: Step,
  l1Exec: StepExecution,
  ctx: ResolveContext,
  l1Opts: L1Options = {},
  opts: RepairOptions = {},
): Promise<RepairResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollMaxTicks = opts.pollMaxTicks ?? DEFAULT_POLL_MAX_TICKS;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? realSleep;

  const attempts: ResolutionAttempt[] = [];
  let current = l1Exec;
  let lastKind: RepairKind | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const kind = mapFailureReason(current.failureReason);
    if (!kind) break; // unrepairable failure (or a clean escalation) → escalate as today.
    lastKind = kind;

    const t0 = now();
    let note: string;
    let stop = false; // after this retry, stop attempting further repair (exhausted recovery).

    if (kind === "covered") {
      note = await dismissCovering(current, ctx);
    } else if (kind === "disabled") {
      const poll = await pollUntilEnabled(current, ctx, sleep, pollIntervalMs, pollMaxTicks);
      note = `repair:disabled→poll(${poll.ticks} tick${poll.ticks === 1 ? "" : "s"}, enabled=${poll.enabled}); retry`;
      if (!poll.enabled) stop = true; // never enabled within the bound → don't re-poll.
    } else {
      await sleep(settleMs);
      note = `repair:missing→settle(${settleMs}ms)+re-snapshot; retry`;
    }

    // Re-run L1 (which always takes a fresh snapshot — l1.ts:215 — so this is settle + re-resolve).
    const retried = await resolveL1(step, ctx, l1Opts);
    const a: ResolutionAttempt = {
      tier: "L1",
      ok: retried.ok,
      escalated: retried.escalate,
      note,
      durationMs: now() - t0,
    };
    if (retried.selectorUsed !== undefined) a.selectorUsed = retried.selectorUsed;
    if (retried.strategy !== undefined) a.strategy = retried.strategy;
    if (retried.failureReason !== undefined) a.failureReason = retried.failureReason;
    attempts.push(a);

    current = retried;
    if (retried.ok || !retried.escalate) break; // resolved (or terminal) → stop repairing.
    if (stop) break;
  }

  return {
    execution: current,
    attempts,
    repaired: attempts.length > 0 && current.ok,
    ...(lastKind !== undefined ? { kind: lastKind } : {}),
  };
}
