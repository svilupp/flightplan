// Flightplan — unified `target` locator-list normalization (PLAN_v002 §1).
//
// A targeting step's `target` is one string or an ordered list mixing explicit selectors and
// natural language. Classification is a DETERMINISTIC PREFIX WHITELIST — no shape heuristics:
// `ref:` / `role:` / `text:` / `css:` / leading `[` ⇒ selector; anything else is natural
// language, period. Prose like ".NET downloads" or "Products > Shoes" is NL by construction;
// bare CSS that doesn't start with `[` must be written with the `css:` prefix (stripped here
// before it reaches the driver). The linter warns on NL entries that look like unprefixed
// selectors (`steps/target-unprefixed-selector`).
//
// Ordering semantics (PLAN_v002 v002-1): selector entries keep author order — they become
// browser-pilot's ordered selector array (L1's explicit hints, tried before derived strategies).
// The NL entry's POSITION is not semantic: it feeds fuzzy ranking + the L2/L3 intent, it is not
// an ordered attempt. Convention puts it last, reading "try these, else find this".

/** How one locator entry is classified. Everything non-`nl` feeds the L1 selector array. */
export type LocatorClass = "ref" | "role" | "text" | "css" | "nl";

/** The selector-prefix whitelist (PLAN_v002 v002-2). Anything not matched is natural language. */
const SELECTOR_PREFIXES = [
  ["ref:", "ref"],
  ["role:", "role"],
  ["text:", "text"],
  ["css:", "css"],
] as const satisfies ReadonlyArray<readonly [string, LocatorClass]>;

/** Classify one locator entry. Deterministic; no shape sniffing (misrouting is impossible). */
export function classifyLocator(entry: string): LocatorClass {
  const v = entry.trimStart();
  for (const [prefix, cls] of SELECTOR_PREFIXES) {
    if (prefix === "css:" ? v.toLowerCase().startsWith(prefix) : v.startsWith(prefix)) return cls;
  }
  if (v.startsWith("[")) return "css";
  return "nl";
}

/** A step's `target` folded into exactly what the ladder consumes. */
export interface NormalizedTarget {
  /** Selector-classed entries, author order, `css:` prefix stripped — L1's explicit hints. */
  selectors: string[];
  /** The natural-language query (first `nl` entry; later `nl` entries joined as context). */
  nl?: string;
}

/**
 * Fold a `target` (string | list | absent) into `{ selectors, nl }`. Entries are trimmed;
 * empty entries are skipped. A plain string is a one-entry list, so pure-NL targeting
 * (`target = "the trash icon"`) and pure-selector targeting both normalize through one path.
 */
export function normalizeTarget(target: string | readonly string[] | undefined): NormalizedTarget {
  if (target === undefined) return { selectors: [] };
  const entries = typeof target === "string" ? [target] : target;
  const selectors: string[] = [];
  const nlParts: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    const cls = classifyLocator(entry);
    if (cls === "nl") {
      nlParts.push(entry);
    } else if (/^css:/i.test(entry)) {
      // Explicit `css:` escape hatch for bare CSS (e.g. `css:button.primary`) — strip the prefix
      // so the driver sees a plain CSS selector.
      const stripped = entry.slice(entry.indexOf(":") + 1).trim();
      if (stripped.length > 0) selectors.push(stripped);
    } else {
      selectors.push(entry);
    }
  }
  const out: NormalizedTarget = { selectors };
  if (nlParts.length > 0) out.nl = nlParts.join("; ");
  return out;
}

/**
 * A target's human-readable description (the lock target's `target` field, telemetry, events):
 * the NL entry when present, else the first selector, else `undefined`.
 */
export function describeTarget(target: string | readonly string[] | undefined): string | undefined {
  const n = normalizeTarget(target);
  return n.nl ?? n.selectors[0];
}

/**
 * The stripped selector when `target` carries EXACTLY ONE explicit `css:`-prefixed (case-
 * insensitive) entry and NO OTHER selector-classed entry — the frame-bypass gate (cross-origin
 * `switch_frame` context, PLAN.md ladder-in-frame note). A trailing natural-language fallback
 * entry (the normal authoring convention — "try this selector, else find this") is IGNORED here
 * on purpose: the bypass never consults it (there is no ladder to hand it to while framed), but
 * its mere presence must not disqualify an otherwise-unambiguous `css:` target, since that
 * convention is used throughout the flows this bypass targets (e.g. `checkout-oopif.toml`'s
 * payment steps). Deliberately narrower than `normalizeTarget().selectors`: a bare `[attr=val]`
 * (no `css:` prefix) or a `ref:`/`role:`/`text:` entry does NOT qualify (browser-pilot's OOPIF
 * actions have only been proven against a genuine CSS selector), and MULTIPLE selector-classed
 * entries (however classed) do not qualify either — a frame bypass has no ladder to disambiguate
 * between them. Returns `undefined` when `target` does not qualify.
 */
export function cssOnlyTarget(target: string | readonly string[] | undefined): string | undefined {
  if (target === undefined) return undefined;
  const entries = typeof target === "string" ? [target] : target;
  let cssSelector: string | undefined;
  let selectorCount = 0;
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    if (classifyLocator(entry) === "nl") continue; // ignored — no ladder to hand it to anyway.
    selectorCount += 1;
    if (/^css:/i.test(entry)) {
      const stripped = entry.slice(entry.indexOf(":") + 1).trim();
      if (stripped.length > 0) cssSelector = stripped;
    }
  }
  if (selectorCount !== 1 || cssSelector === undefined) return undefined;
  return cssSelector;
}

/**
 * Heuristic: does an NL-classified `target` entry actually look like an unprefixed selector
 * (CSS id/class, attribute selector, xpath, a CSS combinator)? If so the author probably meant
 * a selector and should use the `css:` prefix — misclassification is otherwise impossible by
 * construction (v002-2), but this catches the likely-a-typo case.
 */
export function looksLikeUnprefixedSelector(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  // xpath
  if (v.startsWith("//") || v.startsWith("(/")) return true;
  // explicit engine prefixes some tools use (not part of flightplan's whitelist)
  if (/^(css=|xpath=)/.test(v)) return true;
  // id / class selectors at the start
  if (/^[#.][A-Za-z_]/.test(v)) return true;
  // attribute selector [data-testid='x'] / [name="y"] mid-string or at the start
  if (/\[[A-Za-z][\w-]*([~|^$*]?=|\])/.test(v)) return true;
  // CSS child combinator: a `>` between selector-ish tokens (NL prose never uses ` > ` this way).
  if (/[\w#.\]]\s*>\s*[\w#.[]/.test(v)) return true;
  return false;
}

// These checks apply only to assertions. Bare action targets can still be natural language.
const ASSERTION_HTML_TAG =
  /^(html|head|body|base|link|meta|style|title|address|article|aside|footer|header|h[1-6]|hgroup|main|nav|section|search|blockquote|dd|div|dl|dt|figcaption|figure|hr|li|menu|ol|p|pre|ul|a|abbr|b|bdi|bdo|br|cite|code|data|dfn|em|i|kbd|mark|q|rp|rt|ruby|s|samp|small|span|strong|sub|sup|time|u|var|wbr|area|audio|img|map|track|video|embed|iframe|object|picture|source|canvas|noscript|script|del|ins|caption|col|colgroup|table|tbody|td|tfoot|th|thead|tr|button|datalist|fieldset|form|input|label|legend|meter|optgroup|option|output|progress|select|textarea|details|dialog|summary|slot|template|svg|path|g|rect|circle|ellipse|line|polyline|polygon|text|defs|symbol|use|clipPath|mask|foreignObject|math|mi|mo|mn|ms|mtext|\*|[a-z][\w]*-[\w-]+)(?=$|[\s.#[:>+~,|])(.*)$/is;

/** Assertion selectors must disambiguate bare tags from names with css: or text:. */
export function looksLikeUnprefixedAssertionSelector(value: string): boolean {
  if (looksLikeUnprefixedSelector(value)) return true;
  const suffix = ASSERTION_HTML_TAG.exec(value.trim())?.[2];
  if (suffix === undefined) return false;
  return (
    suffix === "" ||
    /^[.#[]/.test(suffix) ||
    /^:[\w-]+(?:\(|$)/.test(suffix) ||
    /^\s*[>+~,|]/.test(suffix) ||
    /^\s+[\w*#.[:]/.test(suffix)
  );
}
