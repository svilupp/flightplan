import { jevUsageCost } from "./cost.ts";
// Flightplan — budget tracking + the budget-exceeded error (PLAN.md §4 "Budgets and verdicts" /
// §5 Phase 4; PROPOSAL "Budgets and verdicts"). Hard ceilings: exceeding any one makes the run
// fail fast. This module provides the tracker + the error type only — `max_steps` enforcement and
// the `BudgetExceededError → inconclusive` (exit 3) verdict mapping are Round 2's runner job.

/** The budget ceilings a run enforces. Any `undefined` ceiling is unlimited. */
export interface BudgetLimits {
  /** Max steps (NOT enforced here — Round 2's runner loop owns it; exposed for the runner). */
  max_steps?: number;
  /** Max logical model calls (one per tier call / judge; fallback retries do NOT re-count). */
  max_model_calls?: number;
  /** Max screenshots (each L3 / screenshot-judge consumes one). */
  max_screenshots?: number;
  /** Max aggregate model spend in USD. */
  max_cost_usd?: number;
  /**
   * Max L5 path-repair replans across the whole run (PLAN_v003 v003-6). Each time the planner is
   * invoked for a divergence counts as one replan (a cheap→capable escalation for the SAME
   * divergence is a re-issue within one `runPathRepair`, NOT a new replan). A run-level hard stop so
   * a pathological page cannot drive unbounded planner spend. `undefined` → unlimited.
   */
  max_replans?: number;
}

/** The ceiling that was hit, named exactly as the limit key (for the run summary / verdict). */
export type BudgetLimitName =
  | "max_steps"
  | "max_model_calls"
  | "max_screenshots"
  | "max_cost_usd"
  | "max_replans";

/**
 * Raised when a hard ceiling would be (or has been) exceeded. The runner (Round 2) catches this,
 * maps it to the distinct `inconclusive` verdict (exit 3), and reports partial evidence. `limit`
 * names which ceiling tripped.
 */
export class BudgetExceededError extends Error {
  constructor(
    readonly limit: BudgetLimitName,
    message?: string,
  ) {
    super(message ?? `Budget exceeded: ${limit}`);
    this.name = "BudgetExceededError";
  }
}

/** Type guard for {@link BudgetExceededError}. */
export function isBudgetExceeded(err: unknown): err is BudgetExceededError {
  return err instanceof BudgetExceededError;
}

/**
 * Resolve the effective {@link BudgetLimits} from config. Per the design, `max_model_calls` and
 * `max_screenshots` fall back from `[run]` to `[ai]`; `max_cost_usd` + `max_steps` live only on
 * `[run]`.
 */
export function resolveBudgetLimits(config: {
  ai?: { max_model_calls?: number; max_screenshots?: number };
  run?: {
    max_steps?: number;
    max_model_calls?: number;
    max_screenshots?: number;
    max_cost_usd?: number;
    max_replans?: number;
  };
  plan?: { max_replans?: number };
}): BudgetLimits {
  const run = config.run ?? {};
  const ai = config.ai ?? {};
  const plan = config.plan ?? {};
  const limits: BudgetLimits = {};
  if (run.max_steps !== undefined) limits.max_steps = run.max_steps;
  const modelCalls = run.max_model_calls ?? ai.max_model_calls;
  if (modelCalls !== undefined) limits.max_model_calls = modelCalls;
  const screenshots = run.max_screenshots ?? ai.max_screenshots;
  if (screenshots !== undefined) limits.max_screenshots = screenshots;
  if (run.max_cost_usd !== undefined) limits.max_cost_usd = run.max_cost_usd;
  // `max_replans` may live on `[run]` (flow-local) or `[plan]` (planner-scoped); `[run]` wins.
  const replans = run.max_replans ?? plan.max_replans;
  if (replans !== undefined) limits.max_replans = replans;
  return limits;
}

/**
 * Tracks running counters against the ceilings. `noteModelCall`/`noteScreenshot` are PRE-checks
 * (call BEFORE the work; they throw if the work would push past the ceiling, then increment).
 * `addCost` records spend and throws if the new total exceeds `max_cost_usd` (the cost is still
 * recorded — the call already happened). `max_steps` is exposed but NOT enforced here.
 */
export class BudgetTracker {
  modelCalls = 0;
  screenshots = 0;
  cost_usd = 0;
  /** L5 path-repair replans counted this run (PLAN_v003 v003-6). Read into the run summary. */
  replans = 0;

  constructor(readonly limits: BudgetLimits = {}) {}

  /** Pre-check + increment the model-call counter. */
  noteModelCall(): void {
    const max = this.limits.max_model_calls;
    if (max !== undefined && this.modelCalls + 1 > max) {
      throw new BudgetExceededError("max_model_calls", `Budget exceeded: max_model_calls (${max})`);
    }
    this.modelCalls += 1;
  }

  /**
   * Pre-check + increment the replan counter (PLAN_v003 v003-6). Called ONCE per divergence, BEFORE
   * `runPathRepair` issues any planner call, so the ceiling stops the (maxReplans+1)-th replan
   * before it spends anything. Throws `BudgetExceededError('max_replans')`, which the runner maps to
   * the `inconclusive` verdict via the same path as the other budget ceilings.
   */
  noteReplan(): void {
    const max = this.limits.max_replans;
    if (max !== undefined && this.replans + 1 > max) {
      throw new BudgetExceededError("max_replans", `Budget exceeded: max_replans (${max})`);
    }
    this.replans += 1;
  }

  /** Pre-check + increment the screenshot counter. */
  noteScreenshot(): void {
    const max = this.limits.max_screenshots;
    if (max !== undefined && this.screenshots + 1 > max) {
      throw new BudgetExceededError("max_screenshots", `Budget exceeded: max_screenshots (${max})`);
    }
    this.screenshots += 1;
  }

  /** Record spend; throw if it pushes the total past `max_cost_usd` (cost is still recorded). */
  addCost(usd: number): void {
    this.cost_usd += usd;
    const max = this.limits.max_cost_usd;
    if (max !== undefined && this.cost_usd > max) {
      throw new BudgetExceededError("max_cost_usd", `Budget exceeded: max_cost_usd (${max})`);
    }
  }
}

/** A reservation is single-use and remains charged when a request's billing is unknown. */
export interface JevRequestReservation {
  recordBytes?(bytes: number): void;
  readonly signal: AbortSignal;
  settle(inputTokens: number | null, servedModel: string): void;
  fail(): void;
}
const jevReservations = new WeakSet<JevRequestReservation>();
/** Transport-only one-shot claim: rejects forged or reused reservations before any HTTP call. */
export function claimJevReservation(reservation: JevRequestReservation): void {
  if (!jevReservations.delete(reservation)) throw new Error("jev_reservation_invalid");
}
export class JevRequestBudget {
  requests = 0;
  unknownCostRequests = 0;
  bytes = 0;
  private readonly steps = new Map<string, { requests: number; deadline: number }>();
  constructor(
    private readonly options: {
      maxCallsPerStep: number;
      maxRequestsPerRun: number;
      budget: BudgetTracker;
      timeoutMs?: number;
      now?: () => number;
    },
  ) {}
  private now(): number {
    return this.options.now?.() ?? performance.now();
  }
  /** Call before first evidence capture; repeated calls never reset the allowance or deadline. */
  beginStep(stepId: string, enclosingDeadlineMs?: number): void {
    if (!this.steps.has(stepId))
      this.steps.set(stepId, {
        requests: 0,
        deadline: Math.min(this.now() + 8000, enclosingDeadlineMs ?? Infinity),
      });
  }
  /** Bound browser evidence work by the same deadline as HTTP reservations. */
  async withinStep<T>(
    stepId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    this.beginStep(stepId);
    const deadline = this.steps.get(stepId)!.deadline;
    const remaining = deadline - this.now();
    if (remaining <= 0) throw new Error("jev_timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("jev_timeout")), remaining);
        abort = () => reject(signal!.reason);
        signal?.addEventListener("abort", abort, { once: true });
      });
      const value = await Promise.race([operation(), expired]);
      signal?.throwIfAborted();
      if (this.now() >= deadline) throw new Error("jev_timeout");
      return value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  reserve(stepId: string, model: string, signal?: AbortSignal): JevRequestReservation {
    signal?.throwIfAborted();
    this.beginStep(stepId);
    const step = this.steps.get(stepId)!;
    const remaining = step.deadline - this.now();
    if (remaining <= 0) throw new Error("jev_timeout");
    if (
      step.requests >= this.options.maxCallsPerStep ||
      this.requests >= this.options.maxRequestsPerRun
    )
      throw new Error("jev_budget_exhausted");
    // Default API context is capped at 64k; long-context headers are never enabled.
    const bound = jevUsageCost(model, 64000);
    const budget = this.options.budget;
    if (
      budget.limits.max_cost_usd !== undefined &&
      (bound === null || budget.cost_usd + bound > budget.limits.max_cost_usd)
    )
      throw new BudgetExceededError("max_cost_usd");
    budget.noteModelCall();
    step.requests++;
    this.requests++;
    if (bound !== null) budget.addCost(bound);
    let settled = false;
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.floor(Math.min(remaining, this.options.timeoutMs ?? 3000))),
    );
    const reservation: JevRequestReservation = {
      recordBytes: (bytes) => {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || settled)
          throw new Error("jev_reservation_invalid");
        this.bytes += bytes;
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      settle: (tokens, servedModel) => {
        if (settled) throw new Error("jev_reservation_consumed");
        settled = true;
        jevReservations.delete(reservation);
        const cost = jevUsageCost(servedModel, tokens);
        if (cost === null) {
          this.unknownCostRequests++;
          return;
        }
        budget.addCost(cost - (bound ?? 0));
      },
      fail: () => {
        if (!settled) {
          settled = true;
          jevReservations.delete(reservation);
          this.unknownCostRequests++;
        }
      },
    };
    jevReservations.add(reservation);
    return reservation;
  }
}
