// Tests for the advisory-note VOLATILE-TOKEN sanitizer (PLAN_v003 §2 (e) / §6 v003-4).
//
// The sanitizer strips volatile tokens (positional indices, `data-testid` values,
// `aria-label`/`aria-labelledby` label leaks) that would rot as soon as the page shifts, while
// preserving durable positional prose (ordinal words, "top-right", glyph cues). Pure + deterministic.

import { describe, expect, test } from "bun:test";
import { sanitizeNote, VOLATILE_PLACEHOLDER } from "./note-sanitize.ts";

describe("sanitizeNote — volatile-token stripping", () => {
  test("empty / undefined input → undefined", () => {
    expect(sanitizeNote(undefined)).toBeUndefined();
    expect(sanitizeNote("")).toBeUndefined();
    expect(sanitizeNote("   ")).toBeUndefined();
  });

  test("a durable, volatile-free note passes through unchanged (only trimmed)", () => {
    const note = "icon-only toolbar, floppy-disk glyph top-right, no testid";
    expect(sanitizeNote(`  ${note}  `)).toBe(note);
  });

  test("strips a data-testid value leak (quoted and bare)", () => {
    const quoted = sanitizeNote('the save control has data-testid="save-btn-3"');
    expect(quoted).not.toContain("save-btn-3");
    expect(quoted).toContain(VOLATILE_PLACEHOLDER);

    const bare = sanitizeNote("match data-testid=submitForm on the primary action");
    expect(bare).not.toContain("submitForm");
    expect(bare).toContain(VOLATILE_PLACEHOLDER);

    // Also covers the data-test-id / data-test spellings (all-volatile → sanitizes to undefined).
    expect(sanitizeNote('glyph data-test-id="foo"')).not.toContain("foo");
    expect(sanitizeNote('glyph data-test="bar"')).not.toContain("bar");
  });

  test("strips an aria-label / aria-labelledby value leak", () => {
    const label = sanitizeNote('the glyph has aria-label="Save changes now"');
    expect(label).not.toContain("Save changes now");
    expect(label).toContain(VOLATILE_PLACEHOLDER);

    const labelledby = sanitizeNote("resolved via aria-labelledby=heading-42 anchor");
    expect(labelledby).not.toContain("heading-42");
    expect(labelledby).toContain(VOLATILE_PLACEHOLDER);
  });

  test("strips a positional numeric index (index/candidate/#N/[N]/ordinal-number)", () => {
    for (const raw of [
      "pick the button at index 3",
      "it is candidate #2 in the list",
      "use idx: 0",
      "the [5] element",
      "select row 12",
      "the 4th item in the toolbar",
      "nth-child(2) under the panel",
    ]) {
      const out = sanitizeNote(raw)!;
      expect(out).toContain(VOLATILE_PLACEHOLDER);
      // No bare index digits survive.
      expect(/\b\d+\b/.test(out.replace(new RegExp(VOLATILE_PLACEHOLDER, "g"), ""))).toBe(false);
    }
  });

  test("preserves durable positional WORDS (ordinal prose, top-right, Nth-glyph cue)", () => {
    const note = "second glyph from the top-right, unlabeled, needs vision";
    const out = sanitizeNote(note)!;
    expect(out).toContain("second");
    expect(out).toContain("top-right");
    expect(out).toContain("needs vision");
    expect(out).not.toContain(VOLATILE_PLACEHOLDER);
  });

  test("digits inside a stripped data-testid do not survive as orphaned numbers", () => {
    const out = sanitizeNote('anchor data-testid="row-7-cell-2" was used')!;
    expect(out).not.toContain("row-7-cell-2");
    expect(out).not.toMatch(/\b7\b/);
    expect(out).not.toMatch(/\b2\b/);
  });

  test("a note that is ONLY volatile tokens sanitizes to nothing → undefined", () => {
    expect(sanitizeNote("index 3")).toBeUndefined();
    expect(sanitizeNote('data-testid="save-btn"')).toBeUndefined();
    expect(sanitizeNote("#4")).toBeUndefined();
  });

  test("idempotent — sanitizing an already-sanitized note is a no-op", () => {
    const once = sanitizeNote('floppy glyph, data-testid="x-9", index 2')!;
    expect(sanitizeNote(once)).toBe(once);
  });
});
