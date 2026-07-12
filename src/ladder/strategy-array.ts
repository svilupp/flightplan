// Flightplan — L1 strategy-array construction (the ordered selector ladder).
//
// From ONE snapshot element (or an author hint), build the candidate selector strings in the
// §4 priority order, and derive the durable (re-resolvable) selector + stored `Strategy` for an
// element. This is the deterministic core of L1: `l1.ts` builds an ordered `StrategyCandidate[]`
// for the targeted element, passes the `.selector`s to `driver.batch`, and reads `selectorUsed`
// to learn which rung won.
//
// §4 priority (PLAN.md §4 / §5 Phase 2):
//   1) testid     — real DOM `data-testid`/`data-test`/`data-qa` attribute  → `[data-testid=…]`
//   2) role_name  — accessible role + accessible name  → `role:Role:Name`
//   3) label      — `aria-label` / `placeholder` attribute  → `[aria-label=…]` / `[placeholder=…]`
//   4) scoped_text— visible text, INTERACTIVE-ROLE-ONLY (role verified; risk #8)  → `text:…`
//   5) structural_fingerprint — a11y-tree structural fingerprint  → `fingerprint:…`
//
// The `testid` and `label` rungs read real DOM attributes off `InteractiveElement.attributes`,
// populated by the enriched `snapshot({ attributes: true })` the ladder now takes (browser-pilot
// 0.1.0, Phase 7 Change 3a). When an element carries a testid it sorts to the TOP of the ladder;
// role_name / scoped_text / structural_fingerprint (built from role + accessible name) cover the
// rest. Author HINTS shaped like a testid still yield a `testid` strategy via `buildHintCandidates`.

import type { InteractiveElement } from "../driver/index.ts";
import type { Strategy } from "../types.ts";
import { isInteractiveRole } from "./fuzzy.ts";
import type { BatchActionVerb, StrategyCandidate } from "./types.ts";

// ---------------------------------------------------------------------------
// Selector escaping
// ---------------------------------------------------------------------------

/** Escape a value for a `[attr='…']` selector (single-quote + backslash). */
function escapeAttrValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// Per-strategy selector builders (each returns a durable selector string or undefined)
// ---------------------------------------------------------------------------

/**
 * testid selector for an element, derived from its real DOM attributes (enriched snapshot):
 * `data-testid` → `data-test` → `data-qa`, first present wins → `[data-testid='…']`. Returns
 * `undefined` when the element carries none (→ the ladder falls to role_name). The synthetic
 * `[data-backend-node-id=…]` in `el.selector` is NOT a testid and is never consulted here.
 */
export function testidSelectorForElement(el: InteractiveElement): string | undefined {
  const attrs = el.attributes;
  if (!attrs) return undefined;
  const testid = attrs["data-testid"] ?? attrs["data-test"] ?? attrs["data-qa"];
  if (testid && testid.trim().length > 0) {
    return `[data-testid='${escapeAttrValue(testid)}']`;
  }
  return undefined;
}

/**
 * Extra context for deriving a DISCRIMINATING durable selector for an element that carries no
 * testid / accessible name / label / scoped text (an icon-only `<button>`). Both fields are
 * OPTIONAL and additive — callers that pass neither get the legacy behaviour verbatim.
 *
 *  - `siblings`       — every interactive element in the snapshot, DOM/AX order. Enables the
 *    POSITIONAL `role:<role>[N]` selector (N = the element's 1-based index among same-role siblings)
 *    and lets the attribute hook verify a value is UNIQUE before emitting it.
 *  - `attributeNames` — author-declared deterministic attribute hooks (`[resolve] attributes`, e.g.
 *    `data-cmd`). When one is present + unique on the element, it yields a `[data-cmd="c2"]` selector
 *    (PREFERRED over positional, per Fix 2). Empty/absent → no attribute hook (default behaviour).
 */
export interface DurableContext {
  siblings?: readonly InteractiveElement[];
  attributeNames?: readonly string[];
}

/**
 * role_name selector: `role:Role:Name` (browser-pilot's interactive role+name special). For a
 * NAMELESS element with sibling context, derive the POSITIONAL `role:Role[N]` (Fix 2) — N = the
 * element's 1-based index among same-role siblings in DOM order — which is DISCRIMINATING (resolves
 * to exactly one element) and L0-replayable. Without context (legacy callers) a nameless element
 * still yields the role-only `role:Role`; that is non-discriminating, so `l0.ts`'s replay gate skips
 * it rather than mis-clicking.
 */
export function roleNameSelectorForElement(
  el: InteractiveElement,
  ctx?: DurableContext,
): string | undefined {
  if (!el.role) return undefined;
  if (el.name && el.name.trim().length > 0) {
    return `role:${el.role}:${el.name}`;
  }
  // Nameless: prefer a POSITIONAL selector when we can compute a stable 1-based DOM index.
  if (ctx?.siblings) {
    const n = positionalIndex(el, el.role, ctx.siblings);
    if (n > 0) return `role:${el.role}[${n}]`;
  }
  return `role:${el.role}`;
}

/**
 * A unique author-declared ATTRIBUTE-hook selector (`[data-cmd="c2"]`) for an element (Fix 2 BONUS,
 * config-gated by `[resolve] attributes`). Returns the first declared attribute the element carries
 * whose value is UNIQUE across `ctx.siblings` (so it resolves to exactly one element). When no
 * siblings are supplied the value is trusted as unique (the author declared it a deterministic hook).
 * Returns `undefined` when no attribute names are declared or none apply — the default (unchanged).
 */
export function attributeSelectorForElement(
  el: InteractiveElement,
  ctx?: DurableContext,
): string | undefined {
  const names = ctx?.attributeNames;
  if (!names || names.length === 0) return undefined;
  const attrs = el.attributes;
  if (!attrs) return undefined;
  for (const name of names) {
    const value = attrs[name];
    if (value === undefined || value.length === 0) continue;
    if (ctx?.siblings) {
      const count = ctx.siblings.filter((s) => s.attributes?.[name] === value).length;
      if (count !== 1) continue; // not unique on this page → not a discriminating hook
    }
    return `[${name}="${escapeAttrValue(value)}"]`;
  }
  return undefined;
}

/** The element's 1-based index among same-role siblings (matched by ref), DOM/AX order; 0 if absent. */
function positionalIndex(
  el: InteractiveElement,
  role: string,
  siblings: readonly InteractiveElement[],
): number {
  const target = role.toLowerCase();
  let n = 0;
  for (const s of siblings) {
    if ((s.role ?? "").toLowerCase() !== target) continue;
    n += 1;
    if (s.ref !== undefined && s.ref === el.ref) return n;
  }
  return 0;
}

/**
 * label selector: read the real `aria-label` (then `placeholder`) attribute off the enriched
 * snapshot element and emit `[aria-label='…']` / `[placeholder='…']` (both fold into the `label`
 * strategy per §4). Returns `undefined` when the element carries neither attribute — we never
 * fabricate a label from the accessible `name` (that would be a guess).
 */
export function labelSelectorForElement(el: InteractiveElement): string | undefined {
  const attrs = el.attributes;
  if (!attrs) return undefined;
  const ariaLabel = attrs["aria-label"];
  if (ariaLabel && ariaLabel.trim().length > 0) {
    return `[aria-label='${escapeAttrValue(ariaLabel)}']`;
  }
  const placeholder = attrs.placeholder;
  if (placeholder && placeholder.trim().length > 0) {
    return `[placeholder='${escapeAttrValue(placeholder)}']`;
  }
  return undefined;
}

/**
 * scoped_text selector: `text:Name` — ONLY for INTERACTIVE roles (role verified here; PLAN.md
 * §8 risk #8 / FINDINGS §8). A bare text match against a non-interactive element (e.g. a `<code>`
 * snippet) is the documented false-positive, so we refuse to emit one.
 */
export function scopedTextSelectorForElement(el: InteractiveElement): string | undefined {
  if (!el.name || el.name.trim().length === 0) return undefined;
  if (!isInteractiveRole(el.role)) return undefined; // ROLE VERIFICATION
  return `text:${el.name}`;
}

/**
 * structural_fingerprint selector: a stable structural token derived from role + name, emitted as
 * a `fingerprint:role=…;name=…` token (the `fingerprint:` prefix is recognised by
 * `selectorUsedToStrategy` so the mapping stays stable). It is the lowest-priority identity rung
 * and durable-selector token of LAST RESORT for the lock — never added to a live batch array;
 * L0 maps a resolved fingerprint to the current snapshot's `ref:eN` before replay.
 */
export function structuralFingerprintForElement(el: InteractiveElement): string {
  const role = el.role ?? "";
  const name = el.name ?? "";
  return `fingerprint:role=${role};name=${name}`;
}

// ---------------------------------------------------------------------------
// Per-element derivation: best strategy + best durable selector
// ---------------------------------------------------------------------------

/**
 * The best DURABLE (re-resolvable, never `ref:eN`) selector for an element, in §4 priority. Used to
 * re-derive a stable selector when bp's `selectorUsed` was a bare ref, and to give each
 * `RankedCandidate` a persistable selector. Falls back to the structural fingerprint token so a
 * durable selector is ALWAYS derivable (the lock invariant: never persist a ref).
 *
 * `ctx` (optional, additive — Fix 2) supplies sibling + author-attribute context so an element with
 * NO testid/name/label/text (an icon-only `<button>`) still gets a DISCRIMINATING durable selector:
 * a unique attribute hook (`[data-cmd="c2"]`, PREFERRED) or a positional `role:<role>[N]`, both
 * L0-replayable. Without `ctx` the result is byte-identical to before.
 */
export function durableSelectorForElement(
  el: InteractiveElement,
  ctx?: DurableContext,
): string | undefined {
  return (
    testidSelectorForElement(el) ??
    attributeSelectorForElement(el, ctx) ??
    roleNameSelectorForElement(el, ctx) ??
    labelSelectorForElement(el) ??
    scopedTextSelectorForElement(el) ??
    structuralFingerprintForElement(el)
  );
}

/** The `Strategy` an element's best durable selector represents (matches `durableSelectorForElement`). */
export function strategyForElement(el: InteractiveElement, ctx?: DurableContext): Strategy {
  if (testidSelectorForElement(el)) return "testid";
  // A unique author-declared attribute hook rides the deterministic `testid` tier (bp's ranker
  // treats extended `testIdAttributes` as the testid strategy).
  if (attributeSelectorForElement(el, ctx)) return "testid";
  if (roleNameSelectorForElement(el, ctx)) return "role_name";
  if (labelSelectorForElement(el)) return "label";
  if (scopedTextSelectorForElement(el)) return "scoped_text";
  return "structural_fingerprint";
}

// ---------------------------------------------------------------------------
// The ordered strategy array for a targeted element
// ---------------------------------------------------------------------------

/**
 * Build the ORDERED `StrategyCandidate[]` for a single targeted element, in §4 priority. This is
 * the array L1 passes (as `.selector`s) to `driver.batch`. Each rung is included only if its
 * selector is derivable off the (attribute-enriched) element: testid → role_name → label →
 * scoped_text, with testid/label present whenever the element carries the corresponding attribute.
 *
 * The `ref:eN` is prepended FIRST (PLAN.md §7 / FINDINGS §4: refs preempt position and resolve
 * in ~3ms) so the action lands on exactly the element we matched THIS cycle, while the durable
 * selectors that follow are what we LEARN the winning strategy from. (If bp resolves via the ref,
 * `selectorUsed` is `ref:eN` → strategy `null` → we re-derive the durable selector for the lock.)
 *
 * The structural-fingerprint rung is intentionally NOT added as a live batch entry (it is a
 * durable-selector token of last resort — see `structuralFingerprintForElement`).
 */
export function buildStrategyArray(
  el: InteractiveElement,
  _action: BatchActionVerb,
): StrategyCandidate[] {
  const candidates: StrategyCandidate[] = [];

  // ref-first short-circuit (resolves the matched element exactly, this cycle only).
  if (el.ref) {
    candidates.push({ selector: `ref:${el.ref}`, strategy: "structural_fingerprint", element: el });
  }

  const testid = testidSelectorForElement(el);
  if (testid) candidates.push({ selector: testid, strategy: "testid", element: el });

  const roleName = roleNameSelectorForElement(el);
  if (roleName) candidates.push({ selector: roleName, strategy: "role_name", element: el });

  const label = labelSelectorForElement(el);
  if (label) candidates.push({ selector: label, strategy: "label", element: el });

  const text = scopedTextSelectorForElement(el);
  if (text) candidates.push({ selector: text, strategy: "scoped_text", element: el });

  return candidates;
}

/**
 * Build strategy candidates from explicit author HINTS (PLAN.md §4 `Step.hints` — "explicit
 * selector/text hints tried in L1"). Hints are tried BEFORE derived strategies. A hint's strategy
 * is inferred from its shape; a testid-shaped hint is the one reliable way to get a `testid`
 * strategy in v0.0.18. The hint has no associated snapshot element.
 */
export function buildHintCandidates(hints: readonly string[]): StrategyCandidate[] {
  return hints.map((h) => ({ selector: h, strategy: inferHintStrategy(h) }));
}

/** Infer the `Strategy` a hint string represents (same shape rules as `selectorUsedToStrategy`). */
function inferHintStrategy(hint: string): Strategy {
  const s = hint.trim();
  if (/\[\s*data-(testid|test-id|test|qa)\s*[~|^$*]?=/i.test(s)) return "testid";
  if (/^role:/i.test(s)) return "role_name";
  if (/\[\s*role\s*=/i.test(s) && /\[\s*aria-label\s*=/i.test(s)) return "role_name";
  if (/^label:/i.test(s)) return "label";
  if (/\[\s*(aria-label|placeholder|name)\s*[~|^$*]?=/i.test(s)) return "label";
  if (/^text:/i.test(s)) return "scoped_text";
  if (/^(fingerprint|fp|structure):/i.test(s)) return "structural_fingerprint";
  return "css";
}
