// Flightplan — the PORTFOLIO RACE: resolve a lock target by racing its remembered strategies over
// ONE shared snapshot (DESIGN §3.2). This generalizes the original Layer-3 single-selector
// revalidation into the learned-playbook race, and both the L0 replay path and the (formerly
// separate) revalidation path now run through it — there is ONE resolution algorithm, not two.
//
// The crack it closes: when the page SIGNATURE no longer matches (a live counter/feed/copy change
// past the volatile-text masking, or any incidental drift), a clean L0 miss escalates to L1 and —
// for a target that needed AI to learn — potentially all the way back to a paid L2/L3
// re-escalation, even though the LOCKED element is still sitting right there, resolvable by SOME
// remembered strategy.
//
// The race (pure, snapshot-only — no driver round-trip; reads the already-taken snapshot's
// `interactiveElements`, respecting single-snapshot discipline):
//
//   1. Parse each remembered strategy's durable selector into an element-identity check.
//   2. Evaluate each against the snapshot: it resolves to exactly ONE element, or 0/many (a miss).
//   3. AGREEMENT — ≥2 strategies resolve to the SAME element → high confidence; act, and mark
//      every agreeing strategy a winner. `agreement = "N/parsed"`.
//   4. SINGLE — exactly one strategy resolves → act (lower confidence); mark it the winner.
//   5. DISAGREEMENT (drift) — strategies resolve to DIFFERENT elements → prefer the one with the
//      best recency-weighted track record whose element's role+name corroborate the locked target;
//      demote (stamp drift on) the strategies that pointed elsewhere.
//   6. NONE resolve → clean miss → the caller escalates to L1.
//
// It does NOT act — the caller (`l0.ts`) replays via the normal batch path once the race picks a
// winner. `revalidateCachedTarget` is kept as a thin adapter over `racePortfolio` for callers that
// still speak the `CachedRecipe` shape (so no parallel code path survives).

import type { InteractiveElement } from "../driver/index.ts";
import { scoreEntry } from "../lock/portfolio.ts";
import type { StrategyEntry } from "../lock/types.ts";
import type { Strategy } from "../types.ts";
import { isInteractiveRole } from "./fuzzy.ts";
import type { CachedRecipe } from "./types.ts";

/** A parsed durable selector: what element identity it asserts (for uniqueness + role/name check). */
interface ParsedSelector {
  /** role_name: `role:Role:Name` (or role-only `role:Role`). */
  role?: string;
  name?: string;
  /** testid: the `data-testid`/`data-test`/`data-qa` value from `[data-testid='…']`. */
  testid?: string;
  /** label: the `aria-label`/`placeholder` value from `[aria-label='…']` / `[placeholder='…']`. */
  attr?: { key: string; value: string };
  /** scoped_text: `text:Name` (interactive-role-only). */
  text?: string;
  /** structural fingerprint: `fingerprint:role=…;name=…`. */
  fingerprint?: { role: string; name: string };
}

/**
 * Parse a durable recipe selector into the identity it asserts. Returns `undefined` for a selector
 * we cannot map to an element-identity check (a bare CSS selector, a ref — refs are never stored).
 * Mirrors the shapes `strategy-array.ts` emits.
 */
export function parseDurableSelector(selector: string): ParsedSelector | undefined {
  const s = selector.trim();

  // testid → `[data-testid='value']` / `[data-test=…]` / `[data-qa=…]`
  const testid = /^\[\s*data-(?:testid|test|qa)\s*=\s*['"]?(.*?)['"]?\s*\]$/i.exec(s);
  if (testid?.[1]) return { testid: testid[1] };

  // label → `[aria-label='value']` / `[placeholder='value']`
  const attr = /^\[\s*(aria-label|placeholder|name)\s*=\s*['"]?(.*?)['"]?\s*\]$/i.exec(s);
  if (attr?.[1] && attr[2] !== undefined)
    return { attr: { key: attr[1].toLowerCase(), value: attr[2] } };

  // scoped_text → `text:Name`
  if (/^text:/i.test(s)) {
    const t = s.slice(s.indexOf(":") + 1);
    return { text: t };
  }

  // structural fingerprint → `fingerprint:role=…;name=…`
  const fp = /^(?:fingerprint|fp|structure):role=(.*?);name=(.*)$/i.exec(s);
  if (fp) return { fingerprint: { role: fp[1] ?? "", name: fp[2] ?? "" } };

  // role_name → `role:Role:Name` (or role-only `role:Role`)
  if (/^role:/i.test(s)) {
    const rest = s.slice(s.indexOf(":") + 1);
    const sep = rest.indexOf(":");
    if (sep < 0) return { role: rest };
    return { role: rest.slice(0, sep), name: rest.slice(sep + 1) };
  }

  return undefined;
}

/** Does a snapshot element satisfy the identity a parsed selector asserts? */
function elementMatches(el: InteractiveElement, p: ParsedSelector): boolean {
  if (p.testid !== undefined) {
    const attrs = el.attributes;
    if (!attrs) return false;
    const v = attrs["data-testid"] ?? attrs["data-test"] ?? attrs["data-qa"];
    return v === p.testid;
  }
  if (p.attr !== undefined) {
    const attrs = el.attributes;
    if (!attrs) return false;
    return attrs[p.attr.key] === p.attr.value;
  }
  if (p.text !== undefined) {
    // scoped_text is interactive-role-only by construction (risk #8).
    return isInteractiveRole(el.role) && el.name === p.text;
  }
  if (p.fingerprint !== undefined) {
    return (
      (el.role ?? "").toLowerCase() === p.fingerprint.role.toLowerCase() &&
      (el.name ?? "") === p.fingerprint.name
    );
  }
  if (p.role !== undefined) {
    if ((el.role ?? "").toLowerCase() !== p.role.toLowerCase()) return false;
    // role-only selector: match on role alone; role+name: require the name too.
    return p.name === undefined ? true : (el.name ?? "") === p.name;
  }
  return false;
}

/** The role + accessible name a parsed selector expects an element to have (when it encodes them). */
function expectedRoleName(p: ParsedSelector): { role?: string; name?: string } {
  if (p.role !== undefined) return { role: p.role, name: p.name };
  if (p.fingerprint !== undefined) return { role: p.fingerprint.role, name: p.fingerprint.name };
  if (p.text !== undefined) return { name: p.text };
  return {};
}

/**
 * Does a parsed selector RESOLVE against the snapshot — i.e. hit EXACTLY ONE element whose role +
 * accessible name corroborate what the selector encodes? Returns that element, or undefined for a
 * miss (0 matches, >1 now-ambiguous matches, or a role/name mismatch). Shared by the whole race.
 */
function resolveSelector(
  selector: string,
  elements: readonly InteractiveElement[],
): InteractiveElement | undefined {
  const parsed = parseDurableSelector(selector);
  if (!parsed) return undefined; // not an identity-bearing selector — can't resolve on it
  const matches = elements.filter((el) => elementMatches(el, parsed));
  if (matches.length !== 1) return undefined; // absent or now-ambiguous
  const el = matches[0]!;
  const exp = expectedRoleName(parsed);
  if (exp.role !== undefined && (el.role ?? "").toLowerCase() !== exp.role.toLowerCase()) {
    return undefined;
  }
  if (exp.name !== undefined && (el.name ?? "") !== exp.name) return undefined;
  return el;
}

/** A single strategy's outcome in the race: what element (if any) it resolved to. */
interface StrategyResolution {
  entry: StrategyEntry;
  element?: InteractiveElement;
}

/** One strategy's verdict, reported back so the caller can update its track record. */
export interface StrategyVerdict {
  kind: Strategy;
  selector: string;
}

/** The result of racing a target's strategy portfolio over one snapshot (DESIGN §3.2). */
export interface PortfolioRaceResult {
  /** True when the race picked a winner (≥1 strategy uniquely resolved the target). */
  ok: boolean;
  /** The winning selector + its strategy (the one to replay) — present iff `ok`. */
  winner?: { kind: Strategy; selector: string };
  /** The winning element (for diagnostics / the L0 replay's role/name check) — present iff `ok`. */
  element?: InteractiveElement;
  /** Every strategy that resolved to the winning element (bump their track records on a green). */
  agreed: StrategyVerdict[];
  /** Strategies that resolved to a DIFFERENT element or failed to resolve (stamp their drift). */
  drifted: StrategyVerdict[];
  /** Agreement summary for the trace: N strategies agreed out of M parseable ones (`"3/4"`). */
  agreement: string;
  /** A short human note for the trace. */
  note: string;
}

/**
 * Race a target's strategy PORTFOLIO over one snapshot (DESIGN §3.2 — the core of the playbook).
 *
 * `strategies` MUST already be in the desired preference order (the ranked portfolio). Each is
 * resolved against the snapshot; then:
 *
 *   - AGREEMENT: the element that the MOST strategies agree on wins (ties → the highest-preference
 *     strategy's element, i.e. the earliest in `strategies`). Every strategy on that element is a
 *     winner (`agreed`); every strategy that resolved ELSEWHERE drifted; a strategy that failed to
 *     resolve while the target still resolved another way ALSO drifted (its selector went stale).
 *   - SINGLE: exactly one strategy resolves → it wins; no others drift (nothing to compare against
 *     — a strategy that simply wasn't tried is not penalized, only one that resolved WRONG is).
 *   - DISAGREEMENT with no majority (every candidate element has exactly one backer): prefer the
 *     backer with the best recency-weighted track record (`scoreEntry`); the others drifted.
 *   - NONE resolve → `ok:false` (clean miss).
 *
 * `now` drives the recency-weighted tie-break for disagreement. Pure: no driver, no clock.
 */
export function racePortfolio(
  strategies: readonly StrategyEntry[],
  elements: readonly InteractiveElement[],
  now: number,
): PortfolioRaceResult {
  const resolutions: StrategyResolution[] = [];
  let parseable = 0;
  for (const entry of strategies) {
    const parsed = parseDurableSelector(entry.selector);
    if (!parsed) continue; // css / ref — not raceable; skip (not counted, not penalized)
    parseable++;
    const element = resolveSelector(entry.selector, elements);
    resolutions.push(element ? { entry, element } : { entry });
  }

  const resolved = resolutions.filter((r): r is Required<StrategyResolution> => !!r.element);
  if (resolved.length === 0) {
    return {
      ok: false,
      agreed: [],
      drifted: [],
      agreement: `0/${parseable}`,
      note: "portfolio miss: no remembered strategy uniquely resolves the target",
    };
  }

  // Group resolutions by element identity (by ref within this snapshot cycle — refs are unique).
  const byElement = new Map<string, Required<StrategyResolution>[]>();
  for (const r of resolved) {
    const key = r.element.ref ?? r.element.selector;
    const list = byElement.get(key) ?? [];
    list.push(r);
    byElement.set(key, list);
  }

  // Pick the winning element: the one the MOST strategies agree on. `resolved` preserves portfolio
  // order, so ties resolve to the highest-preference strategy's element (first seen). On a
  // no-majority disagreement, prefer the element whose best backer has the top recency-weighted
  // score (corroborated by the role/name check that `resolveSelector` already enforced).
  let winners: Required<StrategyResolution>[] = [];
  let bestCount = 0;
  let bestScore = -1;
  for (const group of byElement.values()) {
    const count = group.length;
    const groupScore = Math.max(...group.map((g) => scoreEntry(g.entry, now)));
    if (count > bestCount || (count === bestCount && groupScore > bestScore)) {
      winners = group;
      bestCount = count;
      bestScore = groupScore;
    }
  }

  const winnerEl = winners[0]!.element;
  const winnerKey = winnerEl.ref ?? winnerEl.selector;
  const agreed: StrategyVerdict[] = winners.map((w) => ({
    kind: w.entry.kind,
    selector: w.entry.selector,
  }));
  // A strategy DRIFTED if it resolved to a DIFFERENT element than the winner. A strategy that
  // failed to resolve at all counts as drift ONLY when some OTHER strategy did resolve (the target
  // is present, so this selector went stale) — i.e. whenever we have a winner, which we do here.
  const drifted: StrategyVerdict[] = [];
  for (const r of resolutions) {
    const key = r.element?.ref ?? r.element?.selector;
    if (key === winnerKey) continue; // agreeing winner
    drifted.push({ kind: r.entry.kind, selector: r.entry.selector });
  }

  const topKind = winners[0]!.entry.kind;
  const agreement = `${bestCount}/${parseable}`;
  return {
    ok: true,
    winner: { kind: topKind, selector: winners[0]!.entry.selector },
    element: winnerEl,
    agreed,
    drifted,
    agreement,
    note:
      bestCount >= 2
        ? `portfolio agreement ${agreement}: ${bestCount} strategies resolve the same element (strategy:${topKind})`
        : `portfolio single-resolve ${agreement}: only ${topKind} resolves the target`,
  };
}

/** The result of a revalidation attempt (adapter shape — see {@link revalidateCachedTarget}). */
export interface RevalidateResult {
  /** True when the portfolio race picked a winner in the fresh snapshot. */
  ok: boolean;
  /** The recipe whose selector won (head or a candidate) — the one to replay. */
  recipe?: CachedRecipe;
  /** The winning element (role/name confirmed) — for diagnostics. */
  element?: InteractiveElement;
  /** A short human note for the trace. */
  note: string;
}

/**
 * Revalidate a cached recipe against a fresh snapshot — a THIN ADAPTER over {@link racePortfolio}
 * so callers still speaking the `CachedRecipe` shape (head + ranked candidates) share the ONE race
 * algorithm rather than a parallel code path. The recipe's head + candidates are projected into an
 * ordered strategy portfolio (greens 0, so `scoreEntry` degenerates to the portfolio ORDER, which
 * preserves the original "head first, then ranked candidates" behavior), raced, and the winner
 * mapped back to the head or the matching candidate.
 */
export function revalidateCachedTarget(
  cached: CachedRecipe,
  elements: readonly InteractiveElement[],
  now = 0,
): RevalidateResult {
  const ordered: CachedRecipe[] = [cached, ...(cached.candidates ?? [])];
  const portfolio: StrategyEntry[] = ordered.map((r) => ({
    kind: r.strategy,
    selector: r.selector,
    greens: 0,
  }));
  const race = racePortfolio(portfolio, elements, now);
  if (!race.ok || !race.winner) {
    return {
      ok: false,
      note: "L0 revalidation failed: cached selector no longer uniquely resolves",
    };
  }
  const recipe = ordered.find(
    (r) => r.selector === race.winner!.selector && r.strategy === race.winner!.kind,
  );
  return {
    ok: true,
    ...(recipe ? { recipe } : {}),
    ...(race.element ? { element: race.element } : {}),
    note: `L0 revalidated: cached selector ${race.winner.selector} uniquely resolves the target despite a signature miss`,
  };
}
