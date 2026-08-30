// Flightplan — the six deterministic assertion evaluators + the polling loop.
//
// Each evaluator polls the live page (via the `Driver` snapshot) on a fixed interval until the
// condition holds or a per-assertion deadline elapses. They are pure w.r.t. the driver + clock:
// no flow/config knowledge, no healing, no mutation. The engine (`engine.ts`) resolves the
// effective `timeout_ms` and dispatches here.
//
// ---------------------------------------------------------------------------------------
// Which Driver primitive answers each condition
// ---------------------------------------------------------------------------------------
// Most conditions are answerable from a single `snapshot()`:
//   - visible/hidden → does an element matching the target exist + render in
//     `snapshot.interactiveElements` / `accessibilityTree` (and, for `hidden`, NOT).
//   - text           → does the scoped element's text (or the whole `snapshot.text`) contain
//     the expected substring.
//   - url            → does `snapshot.url` match the pattern.
//   - value          → does the matched input element's `value` equal the expected string.
//   - count          → how many elements match the target.
// `snapshot()` exposes `url`, `text`, `interactiveElements` (role + name + selector + value +
// disabled/checked) and `accessibilityTree`. browser-pilot's outcome `Condition`s
// (`elementVisible`/`textAppears`/`urlMatches`/...) cover the same ground but are evaluated as a
// side effect of an ACTION (`batch`/click) — assertions need to evaluate WITHOUT acting and to
// poll on their own schedule, so reading snapshots is the right primitive.
//
// BUT the AX snapshot only enumerates INTERACTIVE roles: a synthetic/CSS target
// (`[data-testid='toolbar']`, `.row`, `#total`) selecting a non-interactive element never appears
// there. For those, visible/hidden/text/count DELEGATE to the driver's live-DOM primitive
// `driver.elementState(selector)` (browser-pilot's `Page.elementState`) via `resolveTargetState`.
// It is feature-detected (optional on `Driver`): when absent, synthetic targets fall back to the
// snapshot path and behave exactly as before. The DOM matching lives in browser-pilot; this module
// only reads the returned `ElementState`.
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

import type {
  InteractiveElement,
  PageSnapshot,
  PageStateObservation,
  SnapshotNode,
} from "../driver/types.ts";
import type { Assertion } from "../flow/types.ts";
import type { AssertType } from "../types.ts";
import type { AssertionResult, ConditionOpts } from "./types.ts";

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
 * A lazily-fetched, memoized page snapshot for ONE poll iteration. A probe reads the snapshot
 * through this thunk, so a probe that resolves entirely via `driver.elementState` (a synthetic/CSS
 * target) never triggers a `driver.snapshot()` round-trip at all; probes that DO need the snapshot
 * (url, semantic targets, whole-page text) fetch it on first use and share the one result.
 */
type SnapshotSource = () => Promise<PageSnapshot>;

/** Build a per-iteration snapshot source that fetches at most once, only if a probe reads it. */
function makeSnapshotSource(driver: ConditionOpts["driver"]): SnapshotSource {
  let cached: Promise<PageSnapshot> | undefined;
  return () => {
    cached ??= driver.snapshot();
    return cached;
  };
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
  probe: (source: SnapshotSource) => Probe | Promise<Probe>,
): Promise<AssertionResult> {
  const { driver, timeoutMs, pollIntervalMs, clock } = opts;
  const start = clock.now();
  const deadline = start + timeoutMs;

  let last: Probe = { pass: false, message: "not evaluated" };

  // First, immediate attempt (so timeoutMs=0 still checks once). The probe fetches the snapshot
  // LAZILY through the source — a pure synthetic/CSS target (resolved via `driver.elementState`)
  // never triggers a snapshot round-trip; see `makeSnapshotSource` + `resolveTargetState`.
  last = await probe(makeSnapshotSource(driver));
  if (last.pass) return done(true);

  while (clock.now() < deadline) {
    const remaining = deadline - clock.now();
    await clock.sleep(Math.min(pollIntervalMs, remaining));
    last = await probe(makeSnapshotSource(driver));
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

/** Parse a `role:button:Name` / `role:button` / `text:Foo` / `css:…` prefixed target into parts. */
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
  if (target.startsWith("text:"))
    return { kind: "text", name: target.slice("text:".length), raw: target };
  // Explicit `css:` escape hatch for bare CSS (e.g. `css:tr`, `css:div.card`) — mirror
  // `flow/normalize-target.ts`: STRIP the prefix and treat it as synthetic so it resolves via
  // `driver.elementState` (real DOM) rather than being name-matched against the AX snapshot.
  if (target.startsWith("css:")) {
    return { kind: "synthetic", raw: target.slice("css:".length).trim() };
  }
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
      return (
        parsed.name === undefined || (node.name !== undefined && containsCI(node.name, parsed.name))
      );
    }
    // text/plain → match by accessible name
    return node.name !== undefined && parsed.name !== undefined
      ? containsCI(node.name, parsed.name)
      : node.name !== undefined && containsCI(node.name, parsed.raw);
  });
}

/**
 * The resolved presence/visibility/count/text/value of a target, from whichever source can answer
 * it. The fields are the union of everything the visible/hidden/count/text/value evaluators need.
 * `value` is the form-control value (`<input>`/`<select>`/`<textarea>`), or `null` when the target
 * has none / no element matched.
 */
interface TargetState {
  present: boolean;
  visible: boolean;
  count: number;
  text: string;
  value: string | null;
  checked?: boolean;
  disabled?: boolean;
  selected?: boolean;
}

/**
 * Resolve a target's live state via the RIGHT source:
 *  - SYNTHETIC / raw-CSS targets (`[data-testid=…]`, `.class`, `#id`) are NOT in the AX snapshot
 *    (which only enumerates interactive roles), so — when the driver exposes the live-DOM
 *    primitive — we DELEGATE to `driver.elementState(rawSelector)`. This is how flightplan can now
 *    verify presence/visibility/text/count of arbitrary, incl. non-interactive, DOM elements. The
 *    DOM work lives in browser-pilot; flightplan just reads the returned `ElementState`.
 *  - SEMANTIC targets (`role:`/`text:`/`plain`) and `ref:` — or ANY target when `elementState` is
 *    unavailable (feature-detected) — keep the EXACT snapshot-based behaviour: presence/visibility
 *    from {@link targetVisible}, count from {@link matchingElements}, text derived from matched
 *    element names/values (with the same AX-tree fallback `text()` uses). This guarantees no
 *    regression for the AX-resolvable targets every existing test exercises.
 */
async function resolveTargetState(
  target: string,
  source: SnapshotSource,
  opts: ConditionOpts,
): Promise<TargetState> {
  const parsed = parseTarget(target);
  if (parsed.kind === "synthetic" && opts.driver.elementState) {
    // Pure synthetic/CSS target with the live-DOM primitive: answered WITHOUT a snapshot fetch.
    const s = await opts.driver.elementState(parsed.raw);
    return {
      present: s.exists,
      visible: s.visible,
      count: s.count,
      text: s.text,
      value: s.value,
      ...(s.checked !== undefined ? { checked: s.checked } : {}),
      ...(s.disabled !== undefined ? { disabled: s.disabled } : {}),
      ...(s.selected !== undefined ? { selected: s.selected } : {}),
    };
  }
  // Snapshot path (semantic targets, or `elementState` unavailable → no behaviour change).
  const snapshot = await source();
  const els = matchingElements(snapshot, target);
  const present = targetVisible(snapshot, target);
  let text: string;
  if (els.length > 0) {
    text = els.map((el) => `${el.name} ${el.value ?? ""}`).join(" ");
  } else {
    // Mirror text()'s fallback: derive scoped text from matching AX-tree node names.
    text = flattenTree(snapshot.accessibilityTree)
      .filter((n) => matchesNodeTarget(n, target))
      .map((n) => `${n.name ?? ""} ${n.value ?? ""}`)
      .join(" ");
  }
  // `value` mirrors the current `value` evaluator: the first matching element's value (or null).
  const first = els[0];
  const attrs = first?.attributes;
  const selected = attrs?.["aria-selected"] === "true";
  return {
    present,
    visible: present,
    count: els.length,
    text,
    value: first?.value ?? null,
    ...(first?.checked !== undefined ? { checked: first.checked } : {}),
    ...(first?.disabled !== undefined ? { disabled: first.disabled } : {}),
    ...(first && attrs?.["aria-selected"] !== undefined ? { selected } : {}),
  };
}

// ---------------------------------------------------------------------------
// URL matching (glob OR substring)
// ---------------------------------------------------------------------------

/**
 * URL match: if the pattern contains `*` it is treated as a glob (`*` → `.*`, anchored full
 * match); otherwise it is a case-sensitive SUBSTRING test. Documented + tested. A query string
 * in the actual URL does NOT break a substring pattern (`/checkout` ⊂ `/checkout?ok=1`).
 */
export function urlMatchesPattern(
  actual: string,
  pattern: string,
  mode: "exact" | "origin_path" | "glob" | "contains" = pattern.includes("*") ? "glob" : "contains",
): boolean {
  if (mode === "exact") return actual === pattern;
  if (mode === "origin_path") {
    try {
      const a = new URL(actual);
      const p = new URL(pattern, actual);
      return a.origin === p.origin && a.pathname === p.pathname;
    } catch {
      return false;
    }
  }
  if (mode === "contains") return actual.includes(pattern);
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(actual);
  }
  return actual.includes(pattern);
}

// ---------------------------------------------------------------------------
// The six evaluators
// ---------------------------------------------------------------------------

/**
 * `visible` — the target element is present + rendered, AND (when `expectedText` is given — i.e.
 * the assertion supplied BOTH a `selector` and a `text`) its text CONTAINS `expectedText`
 * (case-insensitive). Honouring `expectedText` here is the fix for the silent-ignore bug where a
 * `{ selector, text }` visible/hidden assertion dropped the text check entirely.
 */
export function visible(
  target: string,
  opts: ConditionOpts,
  expectedText?: string,
): Promise<AssertionResult> {
  return poll("visible", target, opts, async (source) => {
    const state = await resolveTargetState(target, source, opts);
    const textOk = expectedText === undefined || containsCI(state.text, expectedText);
    const ok = state.visible && textOk;
    let message: string;
    if (ok) {
      message =
        expectedText === undefined
          ? `"${target}" is visible`
          : `"${target}" is visible and contains "${expectedText}"`;
    } else if (!state.visible) {
      message = `"${target}" not visible (no matching element in snapshot)`;
    } else {
      message = `"${target}" is visible but does not contain "${expectedText}"`;
    }
    return { pass: ok, message };
  });
}

/**
 * `hidden` — the NEGATION of `visible`: the target is not (visible AND, when `expectedText` is
 * given, containing that text). So `{ selector, text }` passes when either the element is not
 * rendered OR its text does not contain the expected substring.
 */
export function hidden(
  target: string,
  opts: ConditionOpts,
  expectedText?: string,
): Promise<AssertionResult> {
  return poll("hidden", target, opts, async (source) => {
    const state = await resolveTargetState(target, source, opts);
    const textOk = expectedText === undefined || containsCI(state.text, expectedText);
    const consideredVisible = state.visible && textOk;
    return {
      pass: !consideredVisible,
      message: consideredVisible ? `"${target}" is still visible` : `"${target}" is hidden`,
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
  match: "exact" | "contains" | "regex" = "contains",
): Promise<AssertionResult> {
  return poll("text", target ?? expected, opts, async (source) => {
    // Synthetic/CSS target with a live-DOM primitive → read the element's text directly (the AX
    // snapshot never surfaces non-interactive containers), with NO snapshot fetch. Semantic targets
    // + whole-page text keep the existing snapshot-based behaviour below.
    if (
      target !== undefined &&
      opts.driver.elementState &&
      parseTarget(target).kind === "synthetic"
    ) {
      const state = await resolveTargetState(target, source, opts);
      const ok = matchText(state.text, expected, match);
      return {
        pass: ok,
        message: ok
          ? `element "${target}" contains "${expected}"`
          : `element "${target}" does not contain "${expected}"`,
      };
    }
    const snap = await source();
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
    const ok = matchText(haystack, expected, match);
    return {
      pass: ok,
      message: ok ? `${scope} contains "${expected}"` : `${scope} does not contain "${expected}"`,
    };
  });
}

/** `url` — the current page URL matches the pattern (glob or substring; see `urlMatchesPattern`). */
export function url(
  pattern: string,
  opts: ConditionOpts,
  match: "exact" | "origin_path" | "glob" | "contains" = pattern.includes("*")
    ? "glob"
    : "contains",
): Promise<AssertionResult> {
  return poll("url", pattern, opts, async (source) => {
    const snap = await source();
    const ok = urlMatchesPattern(snap.url, pattern, match);
    return {
      pass: ok,
      message: ok
        ? `url "${snap.url}" matches "${pattern}"`
        : `url "${snap.url}" does not match "${pattern}"`,
    };
  });
}

function matchText(
  actual: string,
  expected: string,
  match: "exact" | "contains" | "regex",
): boolean {
  if (match === "exact") return actual === expected;
  if (match === "regex") {
    try {
      return new RegExp(expected).test(actual);
    } catch {
      return false;
    }
  }
  return containsCI(actual, expected);
}

/** Evaluate a deterministic element state without invoking an action. */
export function state(
  target: string | undefined,
  expected: "visible" | "hidden" | "enabled" | "disabled" | "checked" | "unchecked" | "selected",
  opts: ConditionOpts,
  expectedValue?: string,
): Promise<AssertionResult> {
  return poll("state", target ?? expected, opts, async (source) => {
    const current = target ? await resolveTargetState(target, source, opts) : undefined;
    let ok = false;
    if (!current) ok = false;
    else if (expected === "visible") ok = current.visible;
    else if (expected === "hidden") ok = !current.visible;
    else if (expected === "enabled") ok = current.present && current.disabled !== true;
    else if (expected === "disabled") ok = current.disabled === true;
    else if (expected === "checked") ok = current.checked === true;
    else if (expected === "unchecked") ok = current.checked === false;
    else if (expected === "selected") ok = current.selected === true;
    if (ok && expectedValue !== undefined) ok = current?.value === expectedValue;
    return {
      pass: ok,
      message: ok
        ? `state ${expected} holds for ${target ?? "page"}`
        : `state ${expected} does not hold for ${target ?? "page"}`,
    };
  });
}

/** Evaluate browser-level state that is not represented by an element snapshot. */
export function pageState(
  expected: "dialog" | "menu" | "new_page",
  opts: ConditionOpts,
): Promise<AssertionResult> {
  return poll("state", expected, opts, async () => {
    let observed: PageStateObservation | undefined;
    try {
      observed = opts.driver.pageState ? await opts.driver.pageState() : undefined;
    } catch {
      observed = undefined;
    }
    const pass =
      expected === "dialog"
        ? observed?.dialogOpen === true
        : expected === "menu"
          ? observed?.menuOpen === true
          : (observed?.popupCount ?? 0) > 0;
    return {
      pass,
      message: pass ? `page state ${expected} holds` : `page state ${expected} was not observed`,
    };
  });
}

/** Compare the current page/field value with a before-state or named capture. */
export function transition(
  kind: "url_changed" | "text_changed" | "value_changed" | "state_changed",
  target: string | undefined,
  opts: ConditionOpts,
  from?: string,
): Promise<AssertionResult> {
  return poll("transition", target ?? kind, opts, async (source) => {
    const snap = await source();
    const before = opts.beforeState;
    let currentValue: string | null = null;
    let beforeValue: string | null | undefined;
    if (kind === "url_changed") {
      currentValue = snap.url;
      beforeValue = from ? opts.captures?.[from] : before?.url;
    } else if (kind === "text_changed") {
      const current = target
        ? await resolveTargetState(target, () => Promise.resolve(snap), opts)
        : undefined;
      currentValue = current?.text ?? snap.text;
      beforeValue = from ? opts.captures?.[from] : before?.text;
    } else if (kind === "value_changed") {
      if (!target) return { pass: false, message: "value_changed requires a selector" };
      const current = await resolveTargetState(target, () => Promise.resolve(snap), opts);
      currentValue = current.value;
      beforeValue = from ? opts.captures?.[from] : before?.values?.[target];
    } else {
      if (!target) return { pass: false, message: "state_changed requires a selector" };
      const current = await resolveTargetState(target, () => Promise.resolve(snap), opts);
      currentValue = `${current.visible}:${current.value}:${current.checked}:${current.disabled}:${current.selected}`;
      beforeValue = from ? opts.captures?.[from] : before?.states?.[target];
    }
    const ok = beforeValue !== undefined && currentValue !== beforeValue;
    return {
      pass: ok,
      message: ok
        ? `${kind} observed (${String(beforeValue)} → ${String(currentValue)})`
        : `${kind} not observed (before=${String(beforeValue)}, current=${String(currentValue)})`,
    };
  });
}

/**
 * `value` — the matched form control's `value` EXACTLY equals `expected`. For synthetic/CSS targets
 * the value comes from `driver.elementState` (`<input>`/`<select>`/`<textarea>` value), so a
 * `[data-testid=…]` input the AX snapshot never surfaces is now readable; semantic targets keep the
 * existing snapshot behaviour. In both cases a missing element fails with a clear message.
 */
/** Resolve a dot-path against a structured WebMCP result. */
function resultAtPath(
  root: unknown,
  path: string | undefined,
): { exists: boolean; value: unknown } {
  if (path === undefined || path === ".") return { exists: root !== undefined, value: root };
  const parts = path.split(".").filter((part) => part.length > 0);
  let value: unknown = root;
  for (const part of parts) {
    if (value === null || value === undefined || typeof value !== "object") {
      return { exists: false, value: undefined };
    }
    if (!(part in (value as object))) return { exists: false, value: undefined };
    value = (value as Record<string, unknown>)[part];
  }
  return { exists: value !== undefined, value };
}

/** Assert a path/value or path/existence predicate against the current WebMCP result. */
export function result(
  path: string | undefined,
  equals: string | number | boolean | null | undefined,
  exists: boolean | undefined,
  opts: ConditionOpts,
): Promise<AssertionResult> {
  const target = path ?? ".";
  const observed = resultAtPath(opts.actionResult, path);
  const pass =
    equals !== undefined
      ? observed.exists && observed.value === equals
      : observed.exists === (exists === true);
  const message = pass
    ? `WebMCP result path ${JSON.stringify(target)} satisfied`
    : `WebMCP result path ${JSON.stringify(target)} did not satisfy its predicate`;
  return Promise.resolve({
    type: "result",
    pass,
    message,
    durationMs: 0,
    when: "after",
    selectorOrTarget: target,
  });
}

export function value(
  target: string,
  expected: string,
  opts: ConditionOpts,
): Promise<AssertionResult> {
  return poll("value", target, opts, async (source) => {
    const state = await resolveTargetState(target, source, opts);
    if (state.count === 0) {
      return { pass: false, message: `no element matched "${target}" to read its value` };
    }
    const observed = state.value;
    const ok = observed === expected;
    return {
      pass: ok,
      message: ok
        ? `"${target}" value === "${expected}"`
        : `"${target}" value is ${observed === null ? "(unset)" : `"${observed}"`}, expected "${expected}"`,
    };
  });
}

/**
 * `count` — the number of elements matching the target EQUALS `n`. For synthetic/CSS targets the
 * count comes from `driver.elementState` (so non-interactive rows the AX snapshot omits are
 * counted correctly); semantic targets keep counting matching interactive snapshot elements.
 */
export function count(target: string, n: number, opts: ConditionOpts): Promise<AssertionResult> {
  return poll("count", target, opts, async (source) => {
    const state = await resolveTargetState(target, source, opts);
    const observed = state.count;
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
      return (
        parsed.name === undefined || (node.name !== undefined && containsCI(node.name, parsed.name))
      );
    case "text":
      return (
        node.name !== undefined && parsed.name !== undefined && containsCI(node.name, parsed.name)
      );
    case "synthetic":
      return false;
    case "plain":
      return (
        node.ref === parsed.raw || (node.name !== undefined && containsCI(node.name, parsed.raw))
      );
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
      // visible may scope by `selector` OR assert page-text presence via `text`. When BOTH are
      // given, the element at `selector` must be visible AND its text must contain `text` — the
      // `text` is passed through as an extra substring check (fixes the silent-ignore bug where
      // supplying both dropped the text check entirely).
      const target =
        assertion.selector ?? (assertion.text !== undefined ? `text:${assertion.text}` : undefined);
      if (target === undefined) {
        throw new Error("`visible` assertion requires a `selector` or `text`");
      }
      const expectedText = assertion.selector !== undefined ? assertion.text : undefined;
      return visible(target, opts, expectedText);
    }
    case "hidden": {
      const target =
        assertion.selector ?? (assertion.text !== undefined ? `text:${assertion.text}` : undefined);
      if (target === undefined) {
        throw new Error("`hidden` assertion requires a `selector` or `text`");
      }
      const expectedText = assertion.selector !== undefined ? assertion.text : undefined;
      return hidden(target, opts, expectedText);
    }
    case "text":
      return text(assertion.selector ?? assertion.landmark, assertion.text, opts, assertion.match);
    case "url":
      return url(assertion.url, opts, assertion.match);
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
    case "state": {
      if (
        assertion.state === "dialog" ||
        assertion.state === "menu" ||
        assertion.state === "new_page"
      ) {
        return pageState(assertion.state, opts);
      }
      return state(assertion.selector, assertion.state, opts, assertion.value);
    }
    case "transition":
      return transition(
        assertion.kind,
        assertion.selector,
        opts,
        assertion.from ?? assertion.capture,
      );
    case "result":
      return result(assertion.path, assertion.equals, assertion.exists, opts);
    case "ai_judge":
      throw new Error(
        "ai_judge is not a deterministic assertion (route via the engine to the Phase-4 stub)",
      );
  }
}
