// Tests for the advisory "note-to-future-self" persistence + redaction (DESIGN §4).
//
// Covers the LOCK side of the note lifecycle: `decideLockWrite` persists an AI-emitted note in
// `auto` mode (with `note_updated`), never persists under `--frozen`, redacts the note through the
// injected `redactNote` sink BEFORE it reaches the target, and preserves a prior note across a
// no-note green run. The AI-tier read/emit path is covered in `ai/note.test.ts`.

import { describe, expect, test } from "bun:test";
import type { StepExecution } from "../ladder/index.ts";
import { createRedactor } from "../redaction/index.ts";
import type { Strategy } from "../types.ts";
import type { LockFile, LockMatch, LockTarget } from "./types.ts";
import { decideLockWrite, serializeLock } from "./write.ts";

const inferStrategy = (_s: string): Strategy | null => "role_name";
const MATCH: LockMatch = { url_glob: "http://h/p*", sig: "text:http://h/p|t;struct:/p|s" };
const NOW = () => Date.parse("2026-07-01T00:00:00.000Z");
const NOW_ISO = "2026-07-01T00:00:00.000Z";
const STEP = { id: "s1", target: "the button" };

/** A successful L2 resolution whose durable winner is `selector`, carrying an emitted `note`. */
function execWithNote(note: string | undefined, selector = "role:button:Save"): StepExecution {
  const e: StepExecution = {
    ok: true,
    tier: "L2",
    durableSelector: selector,
    strategy: "role_name",
    escalate: false,
  };
  if (note !== undefined) e.note = note;
  return e;
}

describe("decideLockWrite — advisory note persistence (DESIGN §4)", () => {
  test("auto mode: an emitted note is persisted with note_updated (first learn)", () => {
    const d = decideLockWrite({
      mode: "auto",
      existing: undefined,
      resolvedAtL0: false,
      step: STEP,
      execution: execWithNote("icon-only toolbar, floppy-disk glyph, no testid"),
      match: MATCH,
      inferStrategy,
      now: NOW,
    });
    expect(d.target?.memory?.note).toBe("icon-only toolbar, floppy-disk glyph, no testid");
    expect(d.target?.memory?.note_updated).toBe(NOW_ISO);
  });

  test("no emitted note → no memory block is created", () => {
    const d = decideLockWrite({
      mode: "auto",
      existing: undefined,
      resolvedAtL0: false,
      step: STEP,
      execution: execWithNote(undefined),
      match: MATCH,
      inferStrategy,
      now: NOW,
    });
    expect(d.target).toBeDefined();
    expect(d.target?.memory).toBeUndefined();
  });

  test("--frozen: the note is NEVER written (portfolio + memory read-only) on an L0 hit", () => {
    const existing: LockTarget = {
      step: "s1",
      target: "the button",
      match: MATCH,
      strategies: [{ kind: "role_name", selector: "role:button:Save", greens: 2 }],
    };
    const d = decideLockWrite({
      mode: "frozen",
      existing,
      resolvedAtL0: true,
      step: STEP,
      execution: {
        ...execWithNote("should not persist"),
        tier: "L0",
        portfolio: {
          winner: { kind: "role_name", selector: "role:button:Save" },
          agreed: [{ kind: "role_name", selector: "role:button:Save" }],
          drifted: [],
          agreement: "1/1",
        },
      },
      match: MATCH,
      inferStrategy,
      now: NOW,
    });
    // Frozen L0 hit is read-only: no target write at all.
    expect(d.target).toBeUndefined();
  });

  test("REDACTION: a note echoing a secret is masked before it reaches the target", () => {
    const SECRET = "SECRET-TOKEN-9999";
    const redactor = createRedactor({ maskText: false, secrets: [SECRET] });
    const d = decideLockWrite({
      mode: "auto",
      existing: undefined,
      resolvedAtL0: false,
      step: STEP,
      execution: execWithNote(`the field pre-filled ${SECRET} last time`),
      match: MATCH,
      inferStrategy,
      now: NOW,
      redactNote: (n) => redactor.redactText(n),
    });
    const note = d.target?.memory?.note ?? "";
    expect(note).not.toContain(SECRET);
    expect(note).toContain("«redacted»");
    // And nothing in the serialized lock leaks the secret.
    const lock: LockFile = {
      version: 2,
      source: "f",
      source_hash: "h",
      description: "",
      targets: [d.target as LockTarget],
    };
    expect(serializeLock(lock)).not.toContain(SECRET);
  });

  test("a prior note is preserved across a no-note green run (until overwritten or decayed)", () => {
    const existing: LockTarget = {
      step: "s1",
      target: "the button",
      match: MATCH,
      strategies: [{ kind: "role_name", selector: "role:button:Save", greens: 2 }],
      memory: { note: "prior hint", note_updated: "2026-06-01T00:00:00.000Z" },
    };
    // A plain L1 re-resolve with NO new note: the prior note survives.
    const d = decideLockWrite({
      mode: "auto",
      existing,
      resolvedAtL0: false,
      step: STEP,
      execution: execWithNote(undefined),
      match: MATCH,
      inferStrategy,
      now: NOW,
    });
    expect(d.target?.memory?.note).toBe("prior hint");
    expect(d.target?.memory?.note_updated).toBe("2026-06-01T00:00:00.000Z");
  });

  test("SANITIZATION: a volatile token in a note is stripped before persistence (v003-4)", () => {
    const d = decideLockWrite({
      mode: "auto",
      existing: undefined,
      resolvedAtL0: false,
      step: STEP,
      execution: execWithNote('floppy-disk glyph, data-testid="save-btn-3", index 4'),
      match: MATCH,
      inferStrategy,
      now: NOW,
    });
    const note = d.target?.memory?.note ?? "";
    // The durable prose survives; the testid value and the numeric index are gone.
    expect(note).toContain("floppy-disk glyph");
    expect(note).not.toContain("save-btn-3");
    expect(note).not.toMatch(/\bindex 4\b/);
    expect(note).not.toMatch(/\b3\b/);
    expect(note).not.toMatch(/\b4\b/);
    // And nothing in the serialized lock leaks the volatile testid value.
    const lock: LockFile = {
      version: 2,
      source: "f",
      source_hash: "h",
      description: "",
      targets: [d.target as LockTarget],
    };
    expect(serializeLock(lock)).not.toContain("save-btn-3");
  });

  test("SANITIZATION: an all-volatile note persists NO memory block", () => {
    const d = decideLockWrite({
      mode: "auto",
      existing: undefined,
      resolvedAtL0: false,
      step: STEP,
      execution: execWithNote('data-testid="save-btn" index 2'),
      match: MATCH,
      inferStrategy,
      now: NOW,
    });
    expect(d.target).toBeDefined();
    expect(d.target?.memory).toBeUndefined();
  });

  test("SANITIZATION runs AFTER redaction (secret masked AND volatile token stripped)", () => {
    const SECRET = "SECRET-TOKEN-9999";
    const redactor = createRedactor({ maskText: false, secrets: [SECRET] });
    const d = decideLockWrite({
      mode: "auto",
      existing: undefined,
      resolvedAtL0: false,
      step: STEP,
      execution: execWithNote(`prefilled ${SECRET} at index 3, glyph top-right`),
      match: MATCH,
      inferStrategy,
      now: NOW,
      redactNote: (n) => redactor.redactText(n),
    });
    const note = d.target?.memory?.note ?? "";
    expect(note).not.toContain(SECRET);
    expect(note).toContain("«redacted»");
    expect(note).not.toMatch(/\bindex 3\b/);
    expect(note).toContain("glyph top-right");
  });

  test("a freshly-emitted note overwrites the prior note (with a new timestamp)", () => {
    const existing: LockTarget = {
      step: "s1",
      target: "the button",
      match: MATCH,
      strategies: [{ kind: "role_name", selector: "role:button:Save", greens: 2 }],
      memory: { note: "prior hint", note_updated: "2026-06-01T00:00:00.000Z" },
    };
    const d = decideLockWrite({
      mode: "auto",
      existing,
      resolvedAtL0: false,
      step: STEP,
      execution: execWithNote("newer hint"),
      match: MATCH,
      inferStrategy,
      now: NOW,
    });
    expect(d.target?.memory?.note).toBe("newer hint");
    expect(d.target?.memory?.note_updated).toBe(NOW_ISO);
  });
});
