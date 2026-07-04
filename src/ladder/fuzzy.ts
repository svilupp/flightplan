// Flightplan — the ladder's role guard, ambiguity policy, and L2 handoff.
//
// Candidate RANKING is delegated to the driver's native `resolveAll` (browser-pilot's L1 race
// over one snapshot — see `l1.ts`). Flightplan no longer runs its own fuzzy scorer; this module
// keeps the three pieces that are POLICY rather than scoring:
//
//   1. the interactive-role guard (`isInteractiveRole` / `INTERACTIVE_ROLES`) — used by the
//      `scoped_text` builder so a bare `text:` match never lands on a non-interactive `<code>`
//      element (PLAN.md §8 risk #8),
//   2. the ambiguity test (`isAmbiguous`) — the L1→L2 escalation trigger when the top two native
//      candidates are too close (PLAN.md §7), and
//   3. the L2 handoff packet (`buildHandoff`) — the compact projection of the native ranked
//      candidates handed to the Phase-4 L2 resolver.
//
// This is a pure, dependency-free module (no zod, no browser-pilot runtime).

import type { BatchActionVerb, L2Handoff, RankedCandidate } from "./types.ts";

// ---------------------------------------------------------------------------
// Role matching (the role guard)
// ---------------------------------------------------------------------------

/**
 * The interactive roles the ladder considers actionable. Used by the `scoped_text`
 * role-verification guard (PLAN.md §8 risk #8 — never let `text:` match a non-interactive
 * `<code>` element).
 */
export const INTERACTIVE_ROLES = new Set<string>([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "slider",
  "spinbutton",
  "listbox",
]);

/** Whether an element's role is interactive (actionable). */
export function isInteractiveRole(role: string): boolean {
  return INTERACTIVE_ROLES.has(role.toLowerCase());
}

// ---------------------------------------------------------------------------
// Ambiguity
// ---------------------------------------------------------------------------

/**
 * Whether a ranked list is AMBIGUOUS: the top two candidates are close in score AND both are
 * plausible (above a floor). Ambiguity is an L1→L2 escalation trigger (PLAN.md §7) even when L1
 * "succeeded", because a close call means we may have acted on the wrong element.
 */
export function isAmbiguous(
  ranked: RankedCandidate[],
  opts: { gap?: number; floor?: number } = {},
): boolean {
  const gap = opts.gap ?? 0.1;
  const floor = opts.floor ?? 0.4;
  if (ranked.length < 2) return false;
  const top = ranked[0]!;
  const second = ranked[1]!;
  return top.score >= floor && second.score >= floor && top.score - second.score < gap;
}

/**
 * Whether `ref` names an element inside the CLOSE-SCORING TOP CLUSTER of the ranked list: the top
 * candidate plus any following candidate that is above the `floor` AND within `gap` of the top
 * score (the same window `isAmbiguous` reasons about, but as a membership test rather than a pairwise
 * one). Because `ranked` is sorted best-first the cluster is a prefix, so we scan from the top and
 * stop at the first candidate that drops below the floor or outside the gap.
 *
 * This is the WINNER gate for the L1 ambiguity veto (l1.ts): the fuzzy ranking says nothing about
 * which element actually got clicked, so the veto must only fire when the element that WON the batch
 * is itself one of the close-scoring contenders. A winner that is out-of-cluster — or absent from
 * `ranked` entirely, e.g. an author hint that hit an AX-`ignored` element (`ref` undefined here) —
 * has nothing to disambiguate against, so this returns `false` and the click stands.
 */
export function isInTopCluster(
  ranked: RankedCandidate[],
  ref: string | undefined,
  opts: { gap?: number; floor?: number } = {},
): boolean {
  if (ref === undefined) return false;
  const gap = opts.gap ?? 0.1;
  const floor = opts.floor ?? 0.4;
  const top = ranked[0];
  if (!top) return false;
  for (const c of ranked) {
    if (c.score < floor) break;
    if (top.score - c.score >= gap) break;
    if (c.ref === ref) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// L2 handoff
// ---------------------------------------------------------------------------

/**
 * Build the L2 handoff packet (PLAN.md §3 "L1→L2 fuzzy-match handoff"). Projects the top ranked
 * candidates to the compact `topMatches` shape and attaches the cheap escalation signals.
 */
export function buildHandoff(args: {
  intent?: string;
  action: BatchActionVerb;
  ranked: RankedCandidate[];
  failureReason?: L2Handoff["failureReason"];
  coveringElement?: L2Handoff["coveringElement"];
  maxMatches?: number;
}): L2Handoff {
  const max = args.maxMatches ?? 5;
  const handoff: L2Handoff = {
    action: args.action,
    topMatches: args.ranked.slice(0, max).map((c) => ({
      role: c.role,
      name: c.name,
      selector: c.selector,
      score: c.score,
    })),
  };
  if (args.intent !== undefined) handoff.intent = args.intent;
  if (args.failureReason !== undefined) handoff.failureReason = args.failureReason;
  if (args.coveringElement !== undefined) handoff.coveringElement = args.coveringElement;
  return handoff;
}
