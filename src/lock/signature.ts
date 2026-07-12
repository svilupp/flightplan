// Flightplan — page signatures (the heart of L0 cache validation).
//
// L0 trusts a locked recipe ONLY when the current page matches the recipe's stored `match`
// gate: the URL matches `url_glob` AND the page signature matches `sig`. This module computes
// and compares those signatures.
//
// Two complementary components make up the composite `match.sig` (PLAN.md §4 / §8 risk #1):
//
//   1. TEXT component — the driver's exported `captureStateSignature()`, which returns
//      `"{url}|{hash}"` where the hash is over the first ~2000 chars of VISIBLE TEXT
//      (FINDINGS_browser-pilot §5). Content-sensitive: it changes when the page's text changes.
//
//   2. STRUCTURE component — browser-pilot's native `captureStructureSignature`, sourced through
//      the driver via `captureStateSignature({ mode: 'structure' })`: a stable hash over the
//      ROLE-TREE SKELETON (roles + structural shape), content-invariant so `name`/`value` churn
//      (usernames, counts, timestamps) does NOT change it. Output shape `"{urlPath}|{hash}"`.
//
// `computeMatchSignature(textSig, structSig)` combines the two into the stored `match.sig`.
// L0 recomputes both at replay time and calls `signatureMatches`.
//
// This module owns the COMPOSITION + MATCHING of the two components; each component is produced
// by the driver (browser-pilot native). NO `Date`, NO `Math.random` here — the composite is a
// pure function of its two inputs, so the same components always compose the same.
//
// Canonical references: PLAN.md §4 (sig = structural + captureStateSignature), §5 Phase 3
// ("Page signatures"), §7 Phase-7 composition note, §8 risk #1.

// ---------------------------------------------------------------------------
// Composite-signature format constants (the documented `match.sig` wire format)
// ---------------------------------------------------------------------------

/**
 * The composite `match.sig` format is:
 *   `text:<textSig>;struct:<structSig>`
 * where `<textSig>` is `captureStateSignature()`'s `"{url}|{hash}"` and `<structSig>` is
 * `captureStateSignature({ mode: 'structure' })`'s `"{urlPath}|{hash}"`. The two parts are
 * joined by `;` and each
 * is prefixed by its component tag so the format is self-describing and forward-extensible
 * (a future component appends `;<tag>:<value>`). The separators (`;`, `:`) never appear in the
 * hex hashes or the prefixes, and a URL containing `;` is tolerated because we split on the FIRST
 * occurrence of each known prefix tag (see `splitMatchSignature`).
 */
const TEXT_PREFIX = "text:";
const STRUCT_PREFIX = "struct:";
const COMPONENT_SEP = ";";

// ---------------------------------------------------------------------------
// Cache options (L0 cache-hit quality — Layer 2 `[cache]` config)
// ---------------------------------------------------------------------------

/**
 * The `[cache]` tuning threaded from config into the signature computation + match (Layer 2).
 *
 *  - `ignoreRegions` — CSS selectors whose subtrees are excluded from BOTH the masked-text and the
 *    structural hashing (see `lock/masked-text.ts` + `ladder/page-signature.ts`). Sourced from
 *    `[cache] ignore_regions`.
 *  - `signature` — `"full"` (default) compares BOTH components; `"struct-only"` compares only the
 *    struct component (`signatureMatches` already degrades to a single component), which trusts a
 *    cached recipe as long as the role-tree skeleton is unchanged even if the (masked) text drifts.
 *    Sourced from `[cache] signature` (flow-level) or a per-step `cache` override.
 */
export interface CacheOptions {
  ignoreRegions?: readonly string[];
  signature?: "full" | "struct-only";
}

// ---------------------------------------------------------------------------
// Composite match signature
// ---------------------------------------------------------------------------

/**
 * Combine the driver's text-hash signature (`captureStateSignature()` → `"{url}|{hash}"`) with
 * the structural signature (`captureStateSignature({ mode: 'structure' })` → `"{urlPath}|{hash}"`)
 * into the full composite `match.sig` the lock stores. Format (documented above):
 *   `text:<textSig>;struct:<structSig>`
 */
export function computeMatchSignature(textSig: string, structSig: string): string {
  return `${TEXT_PREFIX}${textSig}${COMPONENT_SEP}${STRUCT_PREFIX}${structSig}`;
}

/**
 * Parse a composite `match.sig` back into its `{ text, struct }` components. Tolerant of a
 * legacy bare text-only sig (no prefixes): such a value is returned as `{ text, struct: undefined }`.
 * Returns `undefined` components rather than throwing so callers can decide how to degrade.
 */
export function splitMatchSignature(sig: string): { text?: string; struct?: string } {
  if (!sig.startsWith(TEXT_PREFIX)) {
    // Legacy / bare value — treat the whole thing as the text component.
    return { text: sig || undefined };
  }
  const sepIdx = sig.indexOf(`${COMPONENT_SEP}${STRUCT_PREFIX}`);
  if (sepIdx < 0) {
    return { text: sig.slice(TEXT_PREFIX.length) || undefined };
  }
  const text = sig.slice(TEXT_PREFIX.length, sepIdx);
  const struct = sig.slice(sepIdx + COMPONENT_SEP.length + STRUCT_PREFIX.length);
  return { text: text || undefined, struct: struct || undefined };
}

// ---------------------------------------------------------------------------
// Matchers L0 calls (trust-vs-escalate)
// ---------------------------------------------------------------------------

/**
 * Whether a current composite signature matches the cached one. In the default `"full"` mode BOTH
 * the text and structure components must match; if either side is a legacy bare value (no
 * `struct:`), only the text component is compared (graceful degradation — an older lock still
 * validates on text alone).
 *
 * In `"struct-only"` mode (Layer 2 `[cache] signature = "struct-only"`) ONLY the structural
 * component is compared — a cached recipe stays trusted as long as the role-tree skeleton is
 * unchanged, even if the (masked) text drifts. Falls back to text equality only when a side has no
 * struct component at all (a legacy text-only sig), so an old lock never spuriously matches.
 */
export function signatureMatches(
  cachedSig: string,
  currentSig: string,
  mode: "full" | "struct-only" = "full",
): boolean {
  if (cachedSig === currentSig) return true;
  const a = splitMatchSignature(cachedSig);
  const b = splitMatchSignature(currentSig);

  if (mode === "struct-only") {
    // Compare only struct. If BOTH sides carry a struct component, that decides it. If either
    // lacks one (a legacy text-only sig), there is no skeleton to compare → fall back to text.
    if (a.struct !== undefined && b.struct !== undefined) return a.struct === b.struct;
    return a.text === b.text;
  }

  if (a.text !== b.text) return false;
  // If either lacks a structural component, fall back to text-only equality (already true).
  if (a.struct === undefined || b.struct === undefined) return true;
  return a.struct === b.struct;
}

/**
 * Anchored glob match: `url_glob` matches `currentUrl` where `*` is the only wildcard (matches
 * any run of characters, including `/`). The pattern is anchored at both ends (`^…$`). All other
 * regex metacharacters in `url_glob` are escaped, so a literal `?` in a glob matches a literal
 * `?` in the URL.
 *
 * Examples (PLAN.md §5 Phase 3 exit criteria / spec):
 *   urlGlobMatches("/wizard*", "/wizard?x=1")        → true
 *   urlGlobMatches("/wizard*", "/other")             → false
 *   urlGlobMatches("http://h/a*", "http://h/abc")    → true
 */
export function urlGlobMatches(url_glob: string, currentUrl: string): boolean {
  const escaped = url_glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const re = new RegExp(`^${escaped}$`);
  return re.test(currentUrl);
}

/**
 * Derive the `match.url_glob` stored at write time from the page URL a recipe was learned on.
 * Keeps the origin + pathname and replaces any query/fragment with a trailing `*` wildcard, so
 * volatile query params (A/B variant, session ids — masked from the structural signature too)
 * do not pin the recipe to one exact URL. The result is consumed by {@link urlGlobMatches}.
 *
 * Examples:
 *   deriveUrlGlob("http://h/wizard?x=1")  → "http://h/wizard*"
 *   deriveUrlGlob("http://h/drift")        → "http://h/drift*"
 *   deriveUrlGlob("/local/path#frag")      → "/local/path*"
 */
export function deriveUrlGlob(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}*`;
  } catch {
    const cut = [url.indexOf("?"), url.indexOf("#")].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    const base = cut === undefined ? url : url.slice(0, cut);
    return `${base}*`;
  }
}
