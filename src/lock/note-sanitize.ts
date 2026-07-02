// Flightplan — advisory-note VOLATILE-TOKEN sanitizer (PLAN_v003 §2 (e) / §6 v003-4).
//
// The `TargetMemory.note` is a "note-to-future-self" the AI tiers emit to help a FUTURE resolution
// of the same target (DESIGN §4). It is advisory prose ONLY — never a selector, never a routing
// directive. The benchmark (PLAN_v003 §2 (e)) found that models sometimes bake VOLATILE tokens into
// an otherwise-useful note — positional indices, `data-testid` values, or `aria-label` /
// `aria-labelledby` text lifted straight off the DOM. Those tokens rot the moment the page shifts
// (a re-ordered list, a renamed testid, a translated label), so a note that leans on them actively
// MISLEADS the next resolution. The `ResolverDecisionSchema` already CAPS a note at
// `NOTE_MAX_LENGTH`; this sanitizer is the SEPARATE volatile-token pass the plan calls for — it runs
// in the lock WRITE path (`decideLockWrite`), AFTER redaction, BEFORE the note is folded into the
// committed target, so a leaked index/testid/label never reaches disk.
//
// Approach: a small deny-list of regexes, each replacing the volatile token with a stable neutral
// placeholder (never deleting outright — the note stays readable prose). Order matters: attribute
// leaks (`data-testid="…"`, `aria-label='…'`) are stripped before the bare-number pass, so the
// numbers INSIDE a stripped attribute value don't survive as orphaned digits. Pure function, no
// clock / randomness — deterministic for the committed lock.

/** The neutral placeholder a stripped volatile token is replaced with (kept short + readable). */
export const VOLATILE_PLACEHOLDER = "«volatile»";

/**
 * A stripped `data-testid` / `data-test-id` / `data-test` VALUE leak, e.g. `data-testid="save-btn"`
 * or `data-testid=save-btn`. Testids are an implementation detail that drift between builds — a note
 * must not anchor a future resolution to one. Matches the whole `attr=value` token (quoted or bare).
 */
const TESTID_ATTR = /\bdata-test(?:-?id)?\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;.)\]]+)/gi;

/**
 * A stripped `aria-label` / `aria-labelledby` VALUE leak, e.g. `aria-label="Save changes"`. The
 * label text is exactly the kind of thing that gets re-worded or translated, so pinning a note to it
 * is brittle. Matches the whole `attr=value` token (quoted or bare).
 */
const ARIA_LABEL_ATTR = /\baria-label(?:ledby)?\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;.)\]]+)/gi;

/**
 * A stripped POSITIONAL numeric index — the volatile "Nth element" anchor. Covers the common phrasings
 * a model reaches for: `index 3`, `idx 0`, `candidate #2`, `#4`, `[5]`, `1st`/`2nd`/`3rd`/`nth`,
 * `nth-child(2)`. Row/column counts and DOM positions re-number on any layout change, so an index in
 * a note is a landmine. Ordinal WORDS ("first"/"second"/"top-right") are intentionally LEFT ALONE —
 * they are the durable positional cue the plan wants a note to carry ("Nth glyph", §2 (e)).
 */
const POSITIONAL_INDEX =
  /\b(?:index|idx|position|candidate|item|option|row|col(?:umn)?|element|child|nth-child)\s*[:#=(]?\s*\d+\)?|#\d+\b|\[\s*\d+\s*\]|\b\d+(?:st|nd|rd|th)\b/gi;

/**
 * Collapse the runs of whitespace a substitution can leave behind (e.g. `pick  the` → `pick the`),
 * and tidy a placeholder that ended up adjacent to stray punctuation. Purely cosmetic — keeps the
 * sanitized note readable without changing its meaning.
 */
function tidy(s: string): string {
  return s.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Strip VOLATILE tokens from an advisory note, returning the sanitized prose. Each volatile token
 * (testid value, aria-label/aria-labelledby value, numeric index) is replaced with
 * {@link VOLATILE_PLACEHOLDER}; durable positional prose (ordinal words, "top-right", glyph cues) is
 * preserved. Idempotent and deterministic. Returns `undefined` when the input is empty/undefined or
 * sanitizes down to nothing meaningful, so the caller can decide to persist no note at all.
 */
export function sanitizeNote(note: string | undefined): string | undefined {
  const trimmed = note?.trim();
  if (!trimmed) return undefined;
  // Attribute leaks first (so digits inside a stripped `data-testid="row-3"` don't survive), then
  // bare positional indices.
  let out = trimmed
    .replace(TESTID_ATTR, VOLATILE_PLACEHOLDER)
    .replace(ARIA_LABEL_ATTR, VOLATILE_PLACEHOLDER)
    .replace(POSITIONAL_INDEX, VOLATILE_PLACEHOLDER);
  out = tidy(out);
  // If everything meaningful was stripped (only placeholders / punctuation remain), persist nothing.
  const meaningful = out
    .replace(new RegExp(VOLATILE_PLACEHOLDER, "g"), "")
    .replace(/[\s,;.:#()[\]-]/g, "");
  if (meaningful.length === 0) return undefined;
  return out;
}
