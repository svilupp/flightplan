// Tests for the learned strategy PORTFOLIO (DESIGN §3): scoring, ranking, decay/prune,
// normalization / v1→v2 migration, and track-record updates.

import { describe, expect, test } from "bun:test";
import { loadLockFile } from "./parse.ts";
import {
  activeNote,
  applyOutcome,
  isDriftCapped,
  isNoteStale,
  isStale,
  K_MAX,
  normalizeMemory,
  normalizeTarget,
  rankPortfolio,
  scoreEntry,
} from "./portfolio.ts";
import type { LockTarget, StrategyEntry } from "./types.ts";
import { NOTE_TTL_DAYS } from "./types.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function entry(
  over: Partial<StrategyEntry> & Pick<StrategyEntry, "kind" | "selector">,
): StrategyEntry {
  return { greens: 1, ...over };
}

describe("scoreEntry — recency-weighted success score", () => {
  test("a fresh green scores its green count (recency factor ~1)", () => {
    const e = entry({ kind: "testid", selector: "[data-testid='x']", greens: 4, last_ok: iso(T0) });
    expect(scoreEntry(e, T0)).toBeCloseTo(4, 5);
  });

  test("a green one half-life old scores half", () => {
    const e = entry({ kind: "testid", selector: "a", greens: 4, last_ok: iso(T0 - 30 * DAY) });
    expect(scoreEntry(e, T0)).toBeCloseTo(2, 5); // 4 * 2^(-30/30)
  });

  test("a drift-capped entry is heavily penalized (× 0.1)", () => {
    const e = entry({
      kind: "role_name",
      selector: "role:button:X",
      greens: 10,
      last_ok: iso(T0 - DAY),
      last_drift: iso(T0), // drift newer than last green → capped
    });
    const uncapped = entry({ ...e, last_drift: undefined });
    expect(scoreEntry(e, T0)).toBeCloseTo(scoreEntry(uncapped, T0) * 0.1, 5);
  });
});

describe("isDriftCapped / isStale", () => {
  test("drift newer than (or equal to) the last green caps the entry", () => {
    expect(
      isDriftCapped(
        entry({ kind: "css", selector: ".a", last_ok: iso(T0 - DAY), last_drift: iso(T0) }),
      ),
    ).toBe(true);
    expect(
      isDriftCapped(
        entry({ kind: "css", selector: ".a", last_ok: iso(T0), last_drift: iso(T0 - DAY) }),
      ),
    ).toBe(false);
    expect(isDriftCapped(entry({ kind: "css", selector: ".a", last_ok: iso(T0) }))).toBe(false);
  });
  test("no green within the staleness window is stale", () => {
    expect(isStale(entry({ kind: "css", selector: ".a", last_ok: iso(T0 - 200 * DAY) }), T0)).toBe(
      true,
    );
    expect(isStale(entry({ kind: "css", selector: ".a", last_ok: iso(T0 - DAY) }), T0)).toBe(false);
    expect(isStale(entry({ kind: "css", selector: ".a" }), T0)).toBe(true); // never green
  });
});

describe("rankPortfolio — self-ordering + decay/prune", () => {
  test("orders by recency-weighted score DESC", () => {
    const ranked = rankPortfolio(
      [
        entry({ kind: "css", selector: "stale", greens: 100, last_ok: iso(T0 - 365 * DAY) }),
        entry({ kind: "testid", selector: "fresh", greens: 3, last_ok: iso(T0) }),
      ],
      T0,
    );
    expect(ranked[0]?.selector).toBe("fresh"); // fresh 3 > century-stale 100
  });

  test("a drift-capped entry sinks below a non-capped one even when scores decay to ~0", () => {
    // Both greens are ancient (score ≈ 0) — the drift cap must still dominate the tie-break.
    const ranked = rankPortfolio(
      [
        entry({
          kind: "role_name",
          selector: "aaa-drifted",
          greens: 9,
          last_ok: iso(T0 - 999 * DAY),
          last_drift: iso(T0 - 998 * DAY),
        }),
        entry({
          kind: "role_name",
          selector: "zzz-clean",
          greens: 1,
          last_ok: iso(T0 - 999 * DAY),
        }),
      ],
      T0,
    );
    expect(ranked[0]?.selector).toBe("zzz-clean");
  });

  test("ties broken by strategy-kind priority (testid > role_name > … > structural)", () => {
    const ranked = rankPortfolio(
      [
        entry({ kind: "structural_fingerprint", selector: "fp", greens: 2, last_ok: iso(T0) }),
        entry({ kind: "testid", selector: "tid", greens: 2, last_ok: iso(T0) }),
        entry({ kind: "role_name", selector: "rn", greens: 2, last_ok: iso(T0) }),
      ],
      T0,
    );
    expect(ranked.map((e) => e.kind)).toEqual(["testid", "role_name", "structural_fingerprint"]);
  });

  test("caps the portfolio at K_MAX, dropping the lowest-scored", () => {
    const many = Array.from({ length: K_MAX + 3 }, (_, i) =>
      entry({ kind: "css", selector: `s${i}`, greens: i, last_ok: iso(T0) }),
    );
    const ranked = rankPortfolio(many, T0);
    expect(ranked).toHaveLength(K_MAX);
    // The highest-greens entries survive; the lowest (greens 0,1,2) are pruned.
    expect(ranked.every((e) => e.greens >= 3)).toBe(true);
  });

  test("deterministic across repeated ranking (stable committed diffs)", () => {
    const p = [
      entry({ kind: "label", selector: "b", greens: 2, last_ok: iso(T0) }),
      entry({ kind: "testid", selector: "a", greens: 2, last_ok: iso(T0) }),
    ];
    expect(rankPortfolio(p, T0)).toEqual(rankPortfolio(rankPortfolio(p, T0), T0));
  });
});

describe("normalizeTarget — v1 → v2 migration", () => {
  const v1Target: LockTarget = {
    step: "save",
    target: "the save button",
    match: { url_glob: "/*", sig: "text:/|a;struct:/|b" },
    selector: "[data-testid='save']",
    strategy: "testid",
    green_runs: 12,
    last_seen: iso(T0),
    candidates: [
      { strategy: "role_name", selector: "role:button:Save", green_runs: 8 },
      { strategy: "label", selector: "[aria-label='Save']" },
    ],
  };

  test("winner → first strategy (green_runs→greens, last_seen→last_ok); candidates → rest", () => {
    const t = normalizeTarget(v1Target, T0);
    expect(t.strategies?.[0]).toEqual({
      kind: "testid",
      selector: "[data-testid='save']",
      greens: 12,
      last_ok: iso(T0),
    });
    // Candidates seeded from their green_runs (or 0), no last_ok.
    const byKind = Object.fromEntries((t.strategies ?? []).map((s) => [s.kind, s]));
    expect(byKind.role_name?.greens).toBe(8);
    expect(byKind.label?.greens).toBe(0);
    // v1 fields stripped.
    expect(t.selector).toBeUndefined();
    expect(t.candidates).toBeUndefined();
    expect(t.green_runs).toBeUndefined();
  });

  test("idempotent — a v2 target normalizes to itself (aside from re-rank)", () => {
    const once = normalizeTarget(v1Target, T0);
    const twice = normalizeTarget(once, T0);
    expect(twice).toEqual(once);
  });

  test("BACKWARD-COMPAT: the committed examples/flows/wizard.lock.toml (v1) loads + migrates", async () => {
    const lock = await loadLockFile("examples/flows/wizard.lock.toml", undefined, () => T0);
    expect(lock.targets.length).toBeGreaterThan(0);
    for (const t of lock.targets) {
      // Every target migrated to a non-empty portfolio; no v1 fields survive.
      expect(t.strategies && t.strategies.length > 0).toBe(true);
      expect(t.selector).toBeUndefined();
      expect(t.candidates).toBeUndefined();
      expect((t.strategies ?? []).length).toBeLessThanOrEqual(K_MAX);
    }
    // The wizard's steps each learned a testid winner — it must stay the migrated winner.
    const enterName = lock.targets.find((t) => t.step === "enter_name");
    expect(enterName?.strategies?.[0]?.selector).toBe("[data-testid='wizard-name']");
    expect(enterName?.strategies?.[0]?.kind).toBe("testid");
  });
});

describe("applyOutcome — track-record updates", () => {
  const portfolio: StrategyEntry[] = [
    entry({ kind: "testid", selector: "[data-testid='x']", greens: 3, last_ok: iso(T0 - DAY) }),
    entry({ kind: "role_name", selector: "role:button:X", greens: 3, last_ok: iso(T0 - DAY) }),
    entry({ kind: "label", selector: "[aria-label='X']", greens: 1, last_ok: iso(T0 - DAY) }),
  ];

  test("agreed strategies bump greens + refresh last_ok; drifted stamp last_drift", () => {
    const next = applyOutcome(
      portfolio,
      {
        agreed: [
          { kind: "testid", selector: "[data-testid='x']" },
          { kind: "role_name", selector: "role:button:X" },
        ],
        drifted: [{ kind: "label", selector: "[aria-label='X']" }],
      },
      T0,
    );
    const byKind = Object.fromEntries(next.map((e) => [e.kind, e]));
    expect(byKind.testid?.greens).toBe(4);
    expect(byKind.testid?.last_ok).toBe(iso(T0));
    expect(byKind.role_name?.greens).toBe(4);
    expect(byKind.label?.last_drift).toBe(iso(T0));
    expect(byKind.label?.greens).toBe(1); // NOT bumped
    // The drifted label sinks to the bottom.
    expect(next[next.length - 1]?.kind).toBe("label");
  });

  test("a learned selector not in the portfolio is added fresh (greens 1)", () => {
    const next = applyOutcome(
      portfolio,
      { agreed: [], drifted: [], learned: [{ kind: "css", selector: "#new" }] },
      T0,
    );
    const added = next.find((e) => e.selector === "#new");
    expect(added).toEqual({ kind: "css", selector: "#new", greens: 1, last_ok: iso(T0) });
  });
});

// ---------------------------------------------------------------------------
// Advisory note decay (the note-to-future-self, DESIGN §4)
// ---------------------------------------------------------------------------

describe("note decay — isNoteStale / activeNote / normalizeMemory", () => {
  const target = (over: Partial<LockTarget> = {}): LockTarget => ({
    step: "save",
    target: "the save button",
    match: { url_glob: "http://x/*", sig: "s1" },
    strategies: [entry({ kind: "role_name", selector: "role:button:Save", last_ok: iso(T0) })],
    ...over,
  });

  test("a fresh note is not stale and is surfaced by activeNote", () => {
    const t = target({ memory: { note: "icon-only toolbar", note_updated: iso(T0 - DAY) } });
    expect(isNoteStale(t.memory, T0)).toBe(false);
    expect(activeNote(t, T0)).toBe("icon-only toolbar");
  });

  test("a note older than NOTE_TTL_DAYS is stale and NOT surfaced", () => {
    const old = iso(T0 - (NOTE_TTL_DAYS + 1) * DAY);
    const t = target({ memory: { note: "icon-only toolbar", note_updated: old } });
    expect(isNoteStale(t.memory, T0)).toBe(true);
    expect(activeNote(t, T0)).toBeUndefined();
  });

  test("a note with no timestamp is treated as stale (never leaks forward)", () => {
    const t = target({ memory: { note: "no timestamp" } });
    expect(isNoteStale(t.memory, T0)).toBe(true);
    expect(activeNote(t, T0)).toBeUndefined();
  });

  test("absent memory → no note", () => {
    expect(isNoteStale(undefined, T0)).toBe(true);
    expect(activeNote(target(), T0)).toBeUndefined();
  });

  test("normalizeMemory drops a stale note and keeps a fresh one", () => {
    const fresh = { note: "keep me", note_updated: iso(T0 - DAY) };
    expect(normalizeMemory(fresh, T0)).toEqual(fresh);
    const stale = { note: "drop me", note_updated: iso(T0 - (NOTE_TTL_DAYS + 1) * DAY) };
    expect(normalizeMemory(stale, T0)).toBeUndefined();
  });

  test("normalizeTarget carries a fresh note and drops a stale one on load", () => {
    const fresh = normalizeTarget(
      target({ memory: { note: "keep", note_updated: iso(T0 - DAY) } }),
      T0,
    );
    expect(fresh.memory?.note).toBe("keep");
    const stale = normalizeTarget(
      target({ memory: { note: "drop", note_updated: iso(T0 - (NOTE_TTL_DAYS + 1) * DAY) } }),
      T0,
    );
    expect(stale.memory).toBeUndefined();
  });
});
