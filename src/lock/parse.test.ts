// Lock parse tests: valid load, MISSING → empty (no throw), malformed → clear error.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyLock, LockParseError, loadLockFile, parseLockFile } from "./parse.ts";
import { LOCK_VERSION } from "./types.ts";
import { serializeLock } from "./write.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fp-lock-"));
}

describe("emptyLock", () => {
  test("builds a fresh empty lock with header fields", () => {
    const lock = emptyLock("flows/wizard.flow.toml", "sha256:abc", "Wizard flow");
    expect(lock).toEqual({
      version: LOCK_VERSION,
      source: "flows/wizard.flow.toml",
      source_hash: "sha256:abc",
      description: "Wizard flow",
      targets: [],
    });
  });
});

describe("parseLockFile (valid)", () => {
  test("loads a valid lock with a full v2 portfolio target (round-trips)", () => {
    const lock = emptyLock("f.flow.toml", "sha256:x", "desc");
    lock.targets.push({
      step: "submit",
      target: "the submit button",
      match: { url_glob: "/wizard*", sig: "text:/w|aa;struct:/w|bb" },
      last_seen: "2026-06-29T00:00:00.000Z",
      strategies: [
        {
          kind: "role_name",
          selector: "role:button:Submit",
          greens: 3,
          last_ok: "2026-06-29T00:00:00.000Z",
        },
        {
          kind: "label",
          selector: "[aria-label='Submit']",
          greens: 1,
          last_ok: "2026-06-28T00:00:00.000Z",
        },
      ],
    });
    const text = serializeLock(lock);
    // Normalize on load with a fixed clock so ranking is deterministic (an already-ranked portfolio
    // stays put — the winner has the higher greens + fresher last_ok).
    const parsed = parseLockFile(text, "f.lock.toml", () => Date.parse("2026-06-30T00:00:00.000Z"));
    expect(parsed).toEqual(lock);
  });

  test("loads an ai_pick target with pinned_choice", () => {
    const lock = emptyLock("f.flow.toml", "sha256:x", "");
    lock.targets.push({
      step: "pick",
      target: "the cheapest plan",
      kind: "ai_pick",
      match: { url_glob: "/plans*", sig: "text:/p|aa;struct:/p|bb" },
      pinned_choice: { strategy: "role_name", selector: "role:button:Basic", label: "Basic" },
      strategies: [{ kind: "role_name", selector: "role:button:Basic", greens: 1 }],
    });
    const parsed = parseLockFile(serializeLock(lock), "f.lock.toml", () => 0);
    expect(parsed.targets[0]?.kind).toBe("ai_pick");
    expect(parsed.targets[0]?.pinned_choice?.label).toBe("Basic");
    expect(parsed).toEqual(lock);
  });

  test("MIGRATION: a v1 lock (winner + candidates + green_runs) auto-migrates to a portfolio", () => {
    // A hand-written v1 lock: single winner + ranked candidates, no `strategies`.
    const toml = [
      "version = 1",
      'source = "f.flow.toml"',
      'source_hash = "sha256:x"',
      'description = "d"',
      "[[targets]]",
      'step = "submit"',
      'target = "the submit button"',
      'selector = "role:button:Submit"',
      'strategy = "role_name"',
      "green_runs = 3",
      'last_seen = "2026-06-29T00:00:00.000Z"',
      "[targets.match]",
      'url_glob = "/wizard*"',
      'sig = "text:/w|aa;struct:/w|bb"',
      "[[targets.candidates]]",
      'strategy = "label"',
      "selector = \"[aria-label='Submit']\"",
      "green_runs = 1",
    ].join("\n");
    const parsed = parseLockFile(toml, "f.lock.toml", () => Date.parse("2026-06-30T00:00:00.000Z"));
    const t = parsed.targets[0]!;
    // v1 fields are gone; the portfolio carries the HOW.
    expect(t.selector).toBeUndefined();
    expect(t.strategy).toBeUndefined();
    expect(t.candidates).toBeUndefined();
    expect(t.green_runs).toBeUndefined();
    // Winner migrated first (greens 3, last_ok = the old last_seen); candidate seeded at greens 0.
    expect(t.strategies?.[0]).toEqual({
      kind: "role_name",
      selector: "role:button:Submit",
      greens: 3,
      last_ok: "2026-06-29T00:00:00.000Z",
    });
    // The v1 candidate carried `green_runs = 1`, so it migrates with greens 1 (no v1 last_seen → no last_ok).
    expect(t.strategies?.[1]).toEqual({
      kind: "label",
      selector: "[aria-label='Submit']",
      greens: 1,
    });
  });
});

describe("loadLockFile (missing file)", () => {
  test("returns a fresh empty lock, does NOT throw", async () => {
    const dir = tmpDir();
    try {
      const path = join(dir, "does-not-exist.lock.toml");
      const lock = await loadLockFile(path, { source: "w.flow.toml", source_hash: "sha256:z" });
      expect(lock.targets).toEqual([]);
      expect(lock.source).toBe("w.flow.toml");
      expect(lock.source_hash).toBe("sha256:z");
      expect(lock.version).toBe(LOCK_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadLockFile (present + valid)", () => {
  test("reads + parses an existing lock file", async () => {
    const dir = tmpDir();
    try {
      const path = join(dir, "w.lock.toml");
      const lock = emptyLock("w.flow.toml", "sha256:1", "W");
      lock.targets.push({
        step: "go",
        target: "go",
        match: { url_glob: "/*", sig: "text:/|h;struct:/|s" },
        strategies: [{ kind: "role_name", selector: "role:link:Go", greens: 1 }],
      });
      writeFileSync(path, serializeLock(lock));
      const loaded = await loadLockFile(path, undefined, () => 0);
      expect(loaded).toEqual(lock);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("malformed lock → clear error", () => {
  test("bad TOML throws LockParseError with a clear message", () => {
    expect(() => parseLockFile("this is = = not toml", "bad.lock.toml")).toThrow(LockParseError);
    try {
      parseLockFile("this is = = not toml", "bad.lock.toml");
    } catch (err) {
      expect(err).toBeInstanceOf(LockParseError);
      expect((err as LockParseError).message).toContain("Malformed lock file");
      expect((err as LockParseError).path).toBe("bad.lock.toml");
    }
  });

  test("schema violation (missing required field) throws LockParseError", () => {
    // Valid TOML, but `targets` entry lacks `match`.
    const toml = [
      "version = 1",
      'source = "f"',
      'source_hash = "sha256:x"',
      'description = "d"',
      "[[targets]]",
      'step = "s"',
      'target = "t"',
      'selector = "role:button:X"',
      'strategy = "role_name"',
    ].join("\n");
    expect(() => parseLockFile(toml, "bad2.lock.toml")).toThrow(LockParseError);
  });

  test("strict schema rejects an unknown key", () => {
    const toml = [
      "version = 1",
      'source = "f"',
      'source_hash = "sha256:x"',
      'description = "d"',
      "targets = []",
      'bogus_key = "nope"',
    ].join("\n");
    expect(() => parseLockFile(toml, "bad3.lock.toml")).toThrow(LockParseError);
  });
});
