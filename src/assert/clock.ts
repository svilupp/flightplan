// Flightplan — the injectable clock for assertion polling.
//
// The polling loop (`conditions.ts`) measures elapsed time and sleeps between polls THROUGH an
// `AssertClock`. Production uses `systemClock`; tests use `FakeClock`, whose `sleep` advances a
// virtual clock instantly (no real waiting) so the entire assert suite is fast + deterministic
// (a requirement from the Phase 2 brief: "tests must not actually sleep").

import type { AssertClock } from "./types.ts";

/** The default interval between polls, in milliseconds. Small + fixed (PLAN.md §5 Phase 2). */
export const DEFAULT_POLL_INTERVAL_MS = 50;

/** The real clock: `Date.now()` + a `setTimeout`-backed sleep. Used in production runs. */
export const systemClock: AssertClock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    }),
};

/**
 * A virtual clock for tests. `now()` returns a monotonic virtual time that ONLY advances when
 * `sleep()` is called (or `advance()` is called manually) — so a polling loop that sleeps
 * between polls drives the deadline forward without any real-time delay. `sleep` resolves on a
 * microtask so interleaved async work (e.g. a `MockDriver` snapshot provider mutating state
 * between polls) still runs.
 *
 * Usage in a test:
 *   const clock = new FakeClock();
 *   // ... run an assertion with { clock } ...
 *   // the loop's own sleeps advance clock.now() to the deadline; nothing waits.
 */
export class FakeClock implements AssertClock {
  private current: number;
  /** Number of `sleep()` calls — lets a test assert the loop actually polled (didn't hang). */
  sleeps = 0;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  /** Advance the virtual clock without yielding (synchronous time travel). */
  advance(ms: number): void {
    this.current += Math.max(0, ms);
  }

  /**
   * Advance the virtual clock by `ms` and resolve on a microtask. Resolving asynchronously
   * (rather than synchronously) preserves the await-point semantics of a real sleep so any
   * queued async state changes between polls are observed.
   */
  async sleep(ms: number): Promise<void> {
    this.sleeps += 1;
    this.advance(ms);
    await Promise.resolve();
  }
}
