// Flightplan — driver-boundary selector normalization.
//
// The LAST line before a selector reaches browser-pilot. Flightplan's own flow/assert layers
// already fold `target` lists (see `flow/normalize-target.ts` + `assert/conditions.ts`), but the
// driver is the single choke point every code path funnels through, so normalizing here is
// defence-in-depth: any selector that reaches an action does so in a form browser-pilot actually
// understands, regardless of how it was authored or which internal path produced it.
//
// Two rewrites, both grounded in verified browser-pilot facts:
//   1. STRIP a leading `css:` prefix. browser-pilot has NO `css:` selector prefix — it is a
//      Flightplan authoring convention. Passed verbatim, `css:button` becomes an invalid CSS
//      argument to querySelector and silently "not found" (~200ms). Plain `button` works and
//      shadow-pierces via deepQuery. The remainder of a `css:` selector is raw CSS, so no further
//      role translation applies.
//   2. TRANSLATE the `role:<role>[name="<name>"]` bracket form to browser-pilot's real
//      `role:<role>:<name>` syntax. browser-pilot's role selector is `role:<role>:<name>` (name =
//      case-insensitive substring); the bracket form silently mis-parses and never matches. A
//      trailing positional index (`[2]`) is preserved (browser-pilot supports it).
//
// Idempotent: a selector already in canonical form is returned unchanged.

/**
 * `role:<role>[name="<name>"]` (or `[name='...']` / `[name=...]`), optionally followed by a
 * trailing positional index like `[2]`. Anchored to the whole string so only the true bracket
 * form matches — a plain CSS attribute selector never does.
 */
const ROLE_BRACKET_NAME =
  /^role:([a-zA-Z]+)\s*\[\s*name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*?))\s*\]\s*(\[\d+\])?\s*$/;

/** Normalize a single selector string into the form browser-pilot understands. */
export function normalizeSelector(selector: string): string {
  const s = selector.trim();

  // (1) `css:` escape hatch — strip the prefix; the remainder is raw CSS, nothing more to do.
  if (/^css:/i.test(s)) {
    return s.slice(s.indexOf(":") + 1).trim();
  }

  // (2) `role:<role>[name="<name>"]` bracket form → `role:<role>:<name>` (keep any positional).
  const m = ROLE_BRACKET_NAME.exec(s);
  if (m) {
    const role = m[1];
    const name = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    const positional = m[5] ?? "";
    return `role:${role}:${name}${positional}`;
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
