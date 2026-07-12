// Flightplan — driver-boundary selector normalization.
//
// The LAST line before a selector reaches browser-pilot. Flightplan's own flow/assert layers
// already fold `target` lists (see `flow/normalize-target.ts` + `assert/conditions.ts`), but the
// driver is the single choke point every code path funnels through, so normalizing here is
// defence-in-depth: any selector that reaches an action does so in a form browser-pilot actually
// understands, regardless of how it was authored or which internal path produced it.
//
// The one authoring rewrite is grounded in a verified browser-pilot fact:
//   1. STRIP a leading `css:` prefix. browser-pilot has NO `css:` selector prefix — it is a
//      Flightplan authoring convention. Passed verbatim, `css:button` becomes an invalid CSS
//      argument to querySelector and silently "not found" (~200ms). Plain `button` works and
//      shadow-pierces via deepQuery. The remainder of a `css:` selector is raw CSS.
//
// Role selectors are otherwise passed through unchanged. browser-pilot 0.1.0 natively accepts
// both `role:button:Save` and `role:button[name="Save"]`, including `[N]` positional suffixes.
//
// Idempotent: a selector already in canonical form is returned unchanged.

/** Normalize a single selector string into the form browser-pilot understands. */
export function normalizeSelector(selector: string): string {
  const s = selector.trim();

  // `css:` escape hatch — strip the prefix; the remainder is raw CSS, nothing more to do.
  if (/^css:/i.test(s)) {
    return s.slice(s.indexOf(":") + 1).trim();
  }

  return s;
}

/**
 * Normalize a selector argument that may be a single selector or an ordered fallback list,
 * preserving the input's array-vs-string shape and author order.
 */
export function normalizeSelectorArg(selector: string): string;
export function normalizeSelectorArg(selector: string[]): string[];
export function normalizeSelectorArg(selector: string | string[]): string | string[];
export function normalizeSelectorArg(selector: string | string[]): string | string[] {
  return Array.isArray(selector) ? selector.map(normalizeSelector) : normalizeSelector(selector);
}
