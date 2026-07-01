// Flightplan — `selectorUsed` → `Strategy` mapping.
//
// browser-pilot's `StepResult.selectorUsed` reports WHICH selector in the ordered array
// actually resolved. Flightplan's L1 builds that array from its strategy ladder, so the
// returned string lets us learn the winning strategy and store the matching `Strategy` enum
// in the lock recipe. Both the ladder (to rank candidates) and the lock (to persist the
// winning recipe) depend on this, so the helper is exported and lives in its own file.
//
// The mapping is the EXACT table from PLAN.md §4 (and `src/types.ts` STRATEGIES doc):
//   testid                                  → 'testid'
//   role/name                               → 'role_name'
//   label  (aria-label | placeholder | name | label:)  → 'label'
//     (placeholder is a labelling attribute, folded into 'label' per §4)
//   visible text (interactive-role-only)    → 'scoped_text'
//   scoped accessible tree / structural     → 'structural_fingerprint'
//   raw CSS fallback                        → 'css'
//
// Selector string FORMS recognised (verified against browser-pilot
// src/browser/special-selectors.ts + selector-generator.ts):
//   testid : [data-testid=...] | [data-test-id=...] | [data-test=...] | [data-qa=...]
//   role   : role:Role:Name (special)  |  [role="..."][aria-label="..."] (generated)
//   label  : [aria-label=...] | [placeholder=...] | [name=...] | label:...
//   text   : text:...  (browser-pilot's interactive-text special)
//   struct : fingerprint:... | fp:... | structure:...  (Flightplan structural fingerprint)
//   ref    : ref:eN  → resolved WITHIN a cycle; ephemeral, NOT a persistable Strategy → null
//   css    : anything else (#id, .class, tag, attribute combos, descendant paths)

import type { Strategy } from "../types.ts";

/** Normalise a selector for prefix/shape checks (trim only; keep case for attr names). */
function norm(sel: string): string {
  return sel.trim();
}

/**
 * Map a single browser-pilot `selectorUsed` string onto the stored Flightplan `Strategy`.
 *
 * Returns `null` for a `ref:eN` selector: refs are ephemeral, page-scoped backendNodeIds
 * (FINDINGS §3) and must NEVER be persisted as a recipe. A `null` return tells the caller
 * "this resolution was ref-based; re-derive a durable selector before writing the lock."
 *
 * @param selectorUsed the value of `StepResult.selectorUsed` (or any selector string)
 * @returns the matching `Strategy`, or `null` if the selector is a non-persistable ref
 */
export function selectorUsedToStrategy(selectorUsed: string): Strategy | null {
  const sel = norm(selectorUsed);

  // ref:eN — resolved within the cycle; never a durable strategy.
  if (/^ref:/i.test(sel)) {
    return null;
  }

  // testid family — any data-test* / data-qa attribute selector.
  if (/\[\s*data-(testid|test-id|test|qa)\s*[~|^$*]?=/i.test(sel)) {
    return "testid";
  }

  // role/name — the `role:` special OR the generated [role][aria-label] pair.
  if (/^role:/i.test(sel)) {
    return "role_name";
  }
  if (/\[\s*role\s*=/i.test(sel) && /\[\s*aria-label\s*=/i.test(sel)) {
    return "role_name";
  }

  // label family — aria-label / placeholder / name / explicit label: special.
  // (placeholder folds into 'label' per PLAN.md §4.)
  if (/^label:/i.test(sel)) {
    return "label";
  }
  if (/\[\s*(aria-label|placeholder|name)\s*[~|^$*]?=/i.test(sel)) {
    return "label";
  }

  // interactive visible text.
  if (/^text:/i.test(sel)) {
    return "scoped_text";
  }

  // structural fingerprint (Flightplan-emitted; browser-pilot 0.1.0 supplies native fingerprints).
  if (/^(fingerprint|fp|structure):/i.test(sel)) {
    return "structural_fingerprint";
  }

  // Everything else is a raw CSS selector.
  return "css";
}

/**
 * Convenience: map a `StepResult`-like `{ selectorUsed?: string }` to a `Strategy`.
 * Returns `null` when there is no `selectorUsed` (nothing resolved) OR it was a ref.
 */
export function strategyFromStepResult(result: {
  selectorUsed?: string | undefined;
}): Strategy | null {
  if (!result.selectorUsed) return null;
  return selectorUsedToStrategy(result.selectorUsed);
}
