// Flightplan — the six deterministic assertion evaluators + the polling loop.
//
// Each evaluator polls the live page (via the `Driver` snapshot) on a fixed interval until the
// condition holds or a per-assertion deadline elapses. They are pure w.r.t. the driver + clock:
// no flow/config knowledge, no healing, no mutation. The engine (`engine.ts`) resolves the
// effective `timeout_ms` and dispatches here.
//
// ---------------------------------------------------------------------------------------
// Why the existing Driver surface is sufficient (no Driver method was added)
// ---------------------------------------------------------------------------------------
// All six conditions are answerable from a single `snapshot()`:
//   - visible/hidden → does an element matching the target exist + render in
//     `snapshot.interactiveElements` / `accessibilityTree` (and, for `hidden`, NOT).
//   - text           → does the scoped element's text (or the whole `snapshot.text`) contain
//     the expected substring.
//   - url            → does `snapshot.url` match the pattern.
//   - value          → does the matched input element's `value` equal the expected string.
//   - count          → how many elements match the target.
// `snapshot()` already exposes `url`, `text`, `interactiveElements` (role + name + selector +
// value + disabled/checked) and `accessibilityTree`. browser-pilot's outcome `Condition`s
// (`elementVisible`/`textAppears`/`urlMatches`/...) cover the same ground but are evaluated as a
// side effect of an ACTION (`batch`/click) — assertions need to evaluate WITHOUT acting and to
// poll on their own schedule, so reading snapshots is the right primitive. Hence NO change to
// `src/driver/*` was required (per the Phase 2 ownership note's "preferred" path).
//
// ---------------------------------------------------------------------------------------
// Match semantics (documented; chosen deliberately)
// ---------------------------------------------------------------------------------------
// TARGET MATCHING (`selector` field on an assertion). A snapshot element matches the target if
// ANY of the following hold (most-specific-ish, but it is an OR — a permissive match suited to
// the accessibility-tree snapshot (browser-pilot 0.1.0) whose `selector` is synthetic):
//   - `ref:eN`            → element.ref === "eN"
//   - `[data-...="v"]`     → element.selector === target (synthetic backend-node selector echo)
//   - `role:button:Name`   → element.role === role AND element.name contains/equals Name
//   - `role:button`        → element.role === role
//   - `text:Foo`           → element.name contains "Foo" (interactive-role-scoped per FINDINGS §8)
//   - plain string         → element.name contains the string (case-insensitive) OR
//                            element.selector === string OR element.ref === string
// When an assertion has NO `selector`, the target is the page as a whole:
//   - visible/hidden with `text` → matches on the WHOLE-page text containing that text.
//   - text                       → matches on `snapshot.text`.
// TEXT match is CONTAINS (case-insensitive substring), not exact — documented + tested. URL
// match is: a `*`-glob if the pattern contains `*`, else a case-sensitive SUBSTRING match
// (so `/checkout` matches `https://x/checkout?ok=1`). VALUE match is EXACT string equality.

import type { Assertion } from "../flow/types.ts";
import type { InteractiveElement, PageSnapshot, SnapshotNode } from "../driver/types.ts";
import type { AssertionResult, ConditionOpts } from "./types.ts";
import type { AssertType } from "../types.ts";

// ---------------------------------------------------------------------------
// The polling loop
// ---------------------------------------------------------------------------

/** What a single evaluation attempt yields: pass/fail + a per-attempt message. */
interface Probe {
  pass: boolean;
  /** Observed-state message, recomputed each poll; surfaced on timeout. */
  message: string;
}

/**
 * Poll `probe()` on a fixed interval until it passes or the deadline elapses, then return the
 * final result. Returns AS SOON AS it passes (first passing poll wins). On timeout returns the
 * last probe's `pass:false` + its message. The clock is injected, so under a `FakeClock` the
 * loop's own sleeps advance virtual time to the deadline with zero real waiting.
 *
 * Always polls at least ONCE (so a `timeoutMs` of 0 still evaluates the condition once). After
 * a failing probe it sleeps `pollIntervalMs`; if that sleep would cross the deadline it still
 * does a final probe at/after the deadline before giving up — guaranteeing we never report a
 * timeout without having checked the end-state.
 */
async function poll(
  type: AssertType,
  selectorOrTarget: string | undefined,
  opts: ConditionOpts,
  probe: (snapshot: PageSnapshot) => Probe,
): Promise<AssertionResult> {
  const { driver, timeoutMs, pollIntervalMs, clock } = opts;
  const start = clock.now();
  const deadline = start + timeoutMs;

  let last: Probe = { pass: false, message: "not evaluated" };

  // First, immediate attempt (so timeoutMs=0 still checks once).
  last = probe(await driver.snapshot());
  if (last.pass) return done(true);

  while (clock.now() < deadline) {
    const remaining = deadline - clock.now();
    await clock.sleep(Math.min(pollIntervalMs, remaining));
    last = probe(await driver.snapshot());
    if (last.pass) return done(true);
  }

  return done(false);

  function done(pass: boolean): AssertionResult {
    return {
      type,
      pass,
      message: pass ? last.message : `${last.message} (timed out after ${timeoutMs}ms)`,
      durationMs: clock.now() - start,
      when: "after", // overwritten by the engine with the resolved phase
      ...(selectorOrTarget !== undefined ? { selectorOrTarget } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Target matching helpers
// ---------------------------------------------------------------------------

/** Lower-cased contains test (the universal text/name comparison). */
function containsCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Flatten the accessibility tree into a list of nodes (for presence checks beyond interactive). */
function flattenTree(nodes: readonly SnapshotNode[]): SnapshotNode[] {
  const out: SnapshotNode[] = [];
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    out.push(node);
    if (node.children && node.children.length > 0) stack.push(...node.children);
  }
  return out;
}

/** Parse a `role:button:Name` / `role:button` / `text:Foo` prefixed target into parts. */
interface ParsedTarget {
  kind: "ref" | "role" | "text" | "synthetic" | "plain";
  role?: string;
  name?: string;
  raw: string;
}
function parseTarget(target: string): ParsedTarget {
  if (target.startsWith("ref:")) return { kind: "ref", raw: target.slice("ref:".length) };
  if (target.startsWith("role:")) {
    const rest = target.slice("role:".length);
    const sep = rest.indexOf(":");
    if (sep === -1) return { kind: "role", role: rest, raw: target };
    return { kind: "role", role: rest.slice(0, sep), name: rest.slice(sep + 1), raw: target };
  }
  if (target.startsWith("text:")) return { kind: "text", name: target.slice("text:".length), raw: target };
  if (target.startsWith("[") || target.startsWith(".") || target.startsWith("#")) {
    return { kind: "synthetic", raw: target };
  }
  return { kind: "plain", raw: target };
}

/** Does a single interactive element match the parsed target? */
function elementMatches(el: InteractiveElement, parsed: ParsedTarget): boolean {
  switch (parsed.kind) {
    case "ref":
      return el.ref === parsed.raw || el.ref === `e${parsed.raw}`;
    case "role":
      if (el.role !== parsed.role) return false;
      return parsed.name === undefined || containsCI(el.name, parsed.name);
    case "text":
      return parsed.name !== undefined && containsCI(el.name, parsed.name);
    case "synthetic":
      return el.selector === parsed.raw;
    case "plain":
      return el.ref === parsed.raw || el.selector === parsed.raw || containsCI(el.name, parsed.raw);
  }
}

/** All interactive elements matching the target selector. */
function matchingElements(snapshot: PageSnapshot, target: string): InteractiveElement[] {
  const parsed = parseTarget(target);
  return snapshot.interactiveElements.filter((el) => elementMatches(el, parsed));
}

/**
 * Is the target present + visible? We treat an element appearing in the snapshot's
 * `interactiveElements` as visible (browser-pilot only surfaces rendered interactive elements
 * there). For non-interactive presence (e.g. a heading), we also scan the accessibility tree by
 * role/name. `disabled` does NOT mean hidden (a disabled-but-rendered button is still visible).
 */
function targetVisible(snapshot: PageSnapshot, target: string): boolean {
  if (matchingElements(snapshot, target).length > 0) return true;
  // Fall back to the AX tree for non-interactive nodes (role:/text:/plain by name).
  const parsed = parseTarget(target);
  if (parsed.kind === "ref" || parsed.kind === "synthetic") return false;
  return flattenTree(snapshot.accessibilityTree).some((node) => {
    if (parsed.kind === "role") {
      if (node.role !== parsed.role) return false;
      return parsed.name === undefined || (node.name !== undefined && containsCI(node.name, parsed.name));
    }
    // text/plain → match by accessible name
    return node.name !== undefined && parsed.name !== undefined
      ? containsCI(node.name, parsed.name)
      : node.name !== undefined && containsCI(node.name, parsed.raw);
  });
}

// ---------------------------------------------------------------------------
// URL matching (glob OR substring)
// ---------------------------------------------------------------------------

/**
 * URL match: if the pattern contains `*` it is treated as a glob (`*` → `.*`, anchored full
 * match); otherwise it is a case-sensitive SUBSTRING test. Documented + tested. A query string
 * in the actual URL does NOT break a substring pattern (`/checkout` ⊂ `/checkout?ok=1`).
 */
export function urlMatchesPattern(actual: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(actual);
  }
  return actual.includes(pattern);
}

// ---------------------------------------------------------------------------
// The six evaluators
// ---------------------------------------------------------------------------

/** `visible` — the target element is present + rendered. */
export function visible(target: string, opts: ConditionOpts): Promise<AssertionResult> {
  return poll("visible", target, opts, (snap) => {
    const ok = targetVisible(snap, target);
    return {
      pass: ok,
      message: ok ? `"${target}" is visible` : `"${target}" not visible (no matching element in snapshot)`,
    };
  });
}

/** `hidden` — the target element is absent or not rendered. */
export function hidden(target: string, opts: ConditionOpts): Promise<AssertionResult> {
  return poll("hidden", target, opts, (snap) => {
    const present = targetVisible(snap, target);
    return {
      pass: !present,
      message: present ? `"${target}" is still visible` : `"${target}" is hidden`,
    };
  });
}

/**
 * `text` — the page (or, if `selector` given, the matched element's accessible name/value)
 * CONTAINS `expected` (case-insensitive substring). With no selector we match the whole
 * `snapshot.text`.
 */
export function text(
  target: string | undefined,
  expected: string,
  opts: ConditionOpts,
): Promise<AssertionResult> {
  return poll("text", target ?? expected, opts, (snap) => {
    let haystack: string;
    let scope: string;
    if (target !== undefined) {
      const els = matchingElements(snap, target);
      haystack = els.map((el) => `${el.name} ${el.value ?? ""}`).join(" ");
      scope = `element "${target}"`;
      if (els.length === 0) {
        // also consider AX-tree node names for non-interactive scoped text
        haystack = flattenTree(snap.accessibilityTree)
          .filter((n) => matchesNodeTarget(n, target))
          .map((n) => `${n.name ?? ""} ${n.value ?? ""}`)
          .join(" ");
      }
    } else {
      haystack = snap.text;
      scope = "page";
    }
    const ok = containsCI(haystack, expected);
    return {
      pass: ok,
      message: ok ? `${scope} contains "${expected}"` : `${scope} does not contain "${expected}"`,
    };
  });
}

/** `url` — the current page URL matches the pattern (glob or substring; see `urlMatchesPattern`). */
export function url(pattern: string, opts: ConditionOpts): Promise<AssertionResult> {
  return poll("url", pattern, opts, (snap) => {
    const ok = urlMatchesPattern(snap.url, pattern);
    return {
      pass: ok,
      message: ok
        ? `url "${snap.url}" matches "${pattern}"`
        : `url "${snap.url}" does not match "${pattern}"`,
    };
  });
}

/** `value` — the matched input element's `value` EXACTLY equals `expected`. */
export function value(
  target: string,
  expected: string,
  opts: ConditionOpts,
): Promise<AssertionResult> {
  return poll("value", target, opts, (snap) => {
    const els = matchingElements(snap, target);
    if (els.length === 0) {
      return { pass: false, message: `no element matched "${target}" to read its value` };
    }
    const observed = els[0]?.value;
    const ok = observed === expected;
    return {
      pass: ok,
      message: ok
        ? `"${target}" value === "${expected}"`
        : `"${target}" value is ${observed === undefined ? "(unset)" : `"${observed}"`}, expected "${expected}"`,
    };
  });
}

/** `count` — the number of elements matching the target EQUALS `n`. */
export function count(target: string, n: number, opts: ConditionOpts): Promise<AssertionResult> {
  return poll("count", target, opts, (snap) => {
    const observed = matchingElements(snap, target).length;
    const ok = observed === n;
    return {
      pass: ok,
      message: ok
        ? `"${target}" count === ${n}`
        : `"${target}" count is ${observed}, expected ${n}`,
    };
  });
}

/** AX-tree node target match (mirror of `elementMatches` for non-interactive scoped text). */
function matchesNodeTarget(node: SnapshotNode, target: string): boolean {
  const parsed = parseTarget(target);
  switch (parsed.kind) {
    case "ref":
      return node.ref === parsed.raw || node.ref === `e${parsed.raw}`;
    case "role":
      if (node.role !== parsed.role) return false;
      return parsed.name === undefined || (node.name !== undefined && containsCI(node.name, parsed.name));
    case "text":
      return node.name !== undefined && parsed.name !== undefined && containsCI(node.name, parsed.name);
    case "synthetic":
      return false;
    case "plain":
      return node.ref === parsed.raw || (node.name !== undefined && containsCI(node.name, parsed.raw));
  }
}

// ---------------------------------------------------------------------------
// Resolving a flow Assertion into the right evaluator call
// ---------------------------------------------------------------------------

/**
 * Dispatch a single deterministic assertion to its evaluator. The engine resolves the effective
 * timeout + clock into `opts` and supplies the discriminated `Assertion`. `ai_judge` is NOT
 * handled here (the engine routes it to the Phase-4 stub before reaching this point).
 *
 * Throws if called with a missing required field — but the zod schema (`flow/schema.ts`)
 * guarantees `text`/`url`/`value`/`count` are present on their variants, so these throws are
 * defensive only.
 */
export function evaluateDeterministic(
  assertion: Assertion,
  opts: ConditionOpts,
): Promise<AssertionResult> {
  switch (assertion.type) {
    case "visible": {
      // visible may scope by `selector` OR assert page-text presence via `text`.
      const target = assertion.selector ?? (assertion.text !== undefined ? `text:${assertion.text}` : undefined);
      if (target === undefined) {
        throw new Error("`visible` assertion requires a `selector` or `text`");
      }
      return visible(target, opts);
    }
    case "hidden": {
      const target = assertion.selector ?? (assertion.text !== undefined ? `text:${assertion.text}` : undefined);
      if (target === undefined) {
        throw new Error("`hidden` assertion requires a `selector` or `text`");
      }
      return hidden(target, opts);
    }
    case "text":
      return text(assertion.selector, assertion.text, opts);
    case "url":
      return url(assertion.url, opts);
    case "value": {
      if (assertion.selector === undefined) {
        throw new Error("`value` assertion requires a `selector`");
      }
      return value(assertion.selector, assertion.value, opts);
    }
    case "count": {
      if (assertion.selector === undefined) {
        throw new Error("`count` assertion requires a `selector`");
      }
      return count(assertion.selector, assertion.count, opts);
    }
    case "ai_judge":
      throw new Error("ai_judge is not a deterministic assertion (route via the engine to the Phase-4 stub)");
  }
}
