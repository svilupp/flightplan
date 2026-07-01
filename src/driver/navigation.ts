// Flightplan — navigation-settling defaults (pure, testable).
//
// browser-pilot's single-action `click`/`press`/etc. accept only `ActionOptions`
// (`optional?` + `timeout?`) — there is NO `waitForNavigation` field on that type. Yet the
// `'auto'` default browser-pilot applies on navigating actions can evaluate outcomes BEFORE
// async client-side nav settles → spurious `ambiguous` (FINDINGS §5 / PLAN §3 gotcha).
//
// The driver therefore forces navigation settling by routing navigating single-actions
// through a ONE-STEP `batch`, whose `Step.waitForNavigation` IS honoured by browser-pilot
// (see `Step.waitForNavigation?: boolean | 'auto'` in the api report). This module holds the
// pure logic for deciding the default and shaping that one-step batch; the driver applies it.

import type { Step } from "browser-pilot";
import type { ActionOpts, SubmitOpts } from "./types.ts";

/**
 * The driver default for navigating actions: `true` (force settle), NOT browser-pilot's
 * `'auto'`. A per-call `opts.waitForNavigation` overrides it (including back to `'auto'`).
 */
export function resolveWaitForNavigation(
  opts?: Pick<ActionOpts, "waitForNavigation">,
): boolean | "auto" {
  return opts?.waitForNavigation ?? true;
}

/**
 * Build the one-step `batch` representation of a navigating single-action so the wrapper can
 * force `waitForNavigation`. Returns a `Step` carrying the resolved `waitForNavigation` plus
 * the selector/timeout. Used for `click` (the canonical navigating action).
 */
export function clickStep(
  selector: string | string[],
  opts?: ActionOpts,
): Step {
  const step: Step = {
    action: "click",
    selector,
    waitForNavigation: resolveWaitForNavigation(opts),
  };
  if (opts?.timeout !== undefined) step.timeout = opts.timeout;
  if (opts?.optional !== undefined) step.optional = opts.optional;
  return step;
}

/**
 * Build the one-step `batch` representation of a `press`, forcing navigation settling
 * (Enter/Return frequently submits forms). `key` maps onto `Step.key` with `action:'press'`.
 */
export function pressStep(key: string, waitForNavigation: boolean | "auto" = true): Step {
  return {
    action: "press",
    key,
    waitForNavigation,
  };
}

/**
 * Build the submit options the driver passes to browser-pilot's `page.submit`. Unlike
 * `click`, `submit` DOES take `waitForNavigation` directly on `SubmitOptions`, so the driver
 * passes it through rather than routing via batch. Default `true`.
 */
export function submitOptions(opts?: SubmitOpts): {
  method?: "enter" | "click" | "enter+click";
  waitForNavigation: boolean | "auto";
  timeout?: number;
  optional?: boolean;
} {
  const out: {
    method?: "enter" | "click" | "enter+click";
    waitForNavigation: boolean | "auto";
    timeout?: number;
    optional?: boolean;
  } = { waitForNavigation: resolveWaitForNavigation(opts) };
  if (opts?.method !== undefined) out.method = opts.method;
  if (opts?.timeout !== undefined) out.timeout = opts.timeout;
  if (opts?.optional !== undefined) out.optional = opts.optional;
  return out;
}
