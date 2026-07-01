// Flightplan — shared L2/L3 resolution helpers (the index-numbered candidate flow).
//
// L2 (text) and L3 (vision) both: take a FRESH snapshot (the page is unchanged after a failed L1
// action — never trust stale L1 handoff refs; PLAN.md §5 Phase 4 "Re-snapshot"), rank candidates
// via the driver's NATIVE `resolveAll` (browser-pilot's L1 ranking over that snapshot — executes
// nothing), present them to the model as an INDEX-numbered packet (the model picks by index — raw
// selectors are never sent), and on a confident pick ACT via `driver.batch` exactly as L1 does —
// producing the SAME `StepExecution` shape so the runner's existing heal/learn path works
// unchanged. This module factors that shared spine.

import type { Step } from "../flow/types.ts";
import { selectorUsedToStrategy } from "../driver/index.ts";
import type { InteractiveElement } from "../driver/index.ts";
import type { SnapshotNode } from "browser-pilot";
import type {
  BatchActionVerb,
  RankedCandidate,
  ResolveContext,
  StepExecution,
} from "../ladder/index.ts";
import type { LadderTier } from "../ladder/types.ts";
import { buildHandoff } from "../ladder/index.ts";
import { durableSelectorForElement, strategyForElement } from "../ladder/index.ts";
import { actionVerbForStep, buildBatchStep } from "../ladder/l1.ts";
import { capturePageSignature } from "../ladder/page-signature.ts";

/** The intent/target text used for fuzzy matching + the model prompt. */
export function intentTextForStep(step: Step): string {
  if ("intent" in step && step.intent) return step.intent;
  if ("target" in step && step.target) return step.target;
  return step.id;
}

/** The action verb an AI tier drives (defaults to `click` for non-targeting/ai_pick steps). */
export function actionForStep(step: Step): BatchActionVerb {
  return actionVerbForStep(step) ?? "click";
}

/** A compact, index-numbered candidate the model picks from (NO raw selectors are sent). */
export interface CandidatePacketEntry {
  index: number;
  role: string;
  name: string;
  score: number;
  /**
   * Nearest named ancestor(s) (heading/landmark/labelled container), e.g. "Billing address >
   * form", so near-identical candidates (same role+name+score) can be disambiguated by
   * surrounding context. Human-readable text only — never a selector (module header invariant).
   * `undefined` when no such ancestor was found.
   */
  context?: string;
}

/**
 * Accessibility-tree roles treated as "named context" when walking up from a candidate — headings
 * and landmark-ish containers whose accessible `name` describes the surrounding section.
 */
const CONTEXT_ROLES = new Set([
  "heading",
  "region",
  "form",
  "group",
  "navigation",
  "main",
  "article",
  "section",
  "dialog",
  "tabpanel",
]);

/** Max named ancestors to join into a single `context` string (nearest-first, joined `>` outer-first). */
const MAX_CONTEXT_ANCESTORS = 2;

/**
 * Build a `ref -> context` lookup by walking `accessibilityTree` once and, for every node,
 * recording the nearest named ancestor(s) (per `CONTEXT_ROLES`) on the way down. Human-readable
 * text only (no selectors) — this is what lets L2 disambiguate visually-identical candidates by
 * "surrounding context" (P6 plan item #3).
 *
 * Real-world markup rarely wraps a heading + its section's controls in a landmark element with
 * an accessible name (e.g. plain `<div class="panel"><h3>Billing address</h3>…<button>Save
 * </button></div>` — the div has no name/role that survives to the a11y tree, so heading and
 * button end up as FLAT SIBLINGS, not ancestor/descendant). To cover that common case, a
 * `heading` sibling also acts as an *implicit* section label for its later siblings (and their
 * descendants) at the same tree level, until the next `heading` sibling resets it — mirroring how
 * a sighted user reads "the nearest heading above this control".
 */
export function buildAncestorContextMap(tree: SnapshotNode[]): Map<string, string> {
  const map = new Map<string, string>();

  function walk(nodes: SnapshotNode[], ancestors: string[]): void {
    let sectionHeading: string | undefined;
    for (const node of nodes) {
      if (node.role === "heading" && node.name) {
        sectionHeading = node.name;
      }

      let nextAncestors = ancestors;
      if (CONTEXT_ROLES.has(node.role) && node.name) {
        nextAncestors = [...ancestors, node.name];
      } else if (sectionHeading && node.role !== "heading") {
        // Implicit section label from a preceding sibling heading (no named landmark ancestor).
        nextAncestors = [...ancestors, sectionHeading];
      }

      if (nextAncestors.length) {
        map.set(node.ref, nextAncestors.slice(-MAX_CONTEXT_ANCESTORS).join(" > "));
      }
      if (node.children?.length) walk(node.children, nextAncestors);
    }
  }

  walk(tree, []);
  return map;
}

/** Project ranked candidates into the index-numbered packet, attaching ancestor context by `ref`. */
export function buildCandidatePacket(
  ranked: RankedCandidate[],
  contextByRef?: Map<string, string>,
): CandidatePacketEntry[] {
  return ranked.map((c, index) => {
    const entry: CandidatePacketEntry = {
      index,
      role: c.role,
      name: c.name,
      score: Math.round(c.score * 100) / 100,
    };
    const context = c.ref ? contextByRef?.get(c.ref) : undefined;
    if (context) entry.context = context;
    return entry;
  });
}

/** The freshly-gathered resolution inputs for an AI tier. */
export interface GatheredCandidates {
  elements: InteractiveElement[];
  ranked: RankedCandidate[];
  signatureBasis: { sig: string; url: string };
  intentText: string;
  action: BatchActionVerb;
  /** `ref -> nearest named ancestor(s)`, for `buildCandidatePacket`'s `context` field. */
  contextByRef: Map<string, string>;
}

/**
 * Take ONE fresh snapshot, rank candidates via the driver's native `resolveAll`, and capture the
 * pre-action signature basis. Shared by L2 and L3 (L3 takes its screenshot first, then calls this
 * for refs/candidates/basis).
 */
export async function gatherCandidates(
  step: Step,
  ctx: ResolveContext,
  opts: { maxResults?: number } = {},
): Promise<GatheredCandidates> {
  const action = actionForStep(step);
  const intentText = intentTextForStep(step);
  // Deliberate FRESH snapshot per AI tier — the page is unchanged after a failed L1/L2 action, but
  // AI tiers NEVER trust stale L1 handoff refs (PLAN.md §5 Phase 4 "Re-snapshot"). Ask for
  // `attributes: true` so browser-pilot enriches `interactiveElements` with real DOM attributes
  // (testid/label/id/…), letting native ranking surface testid/label candidates.
  const snapshot = await ctx.driver.snapshot({ attributes: true });
  const elements = snapshot.interactiveElements;
  // Rank via the driver's NATIVE `resolveAll` over THIS snapshot (a pure L1 race — executes
  // nothing). The returned `RankedCandidate[]` is the SAME `{ ref?/role/name/selector/strategy/
  // score }` shape Flightplan's own matcher produced, so the packet / `actOnPick` /
  // `StepExecution.candidates` path downstream is unchanged.
  const ranked = await ctx.driver.resolveAll(intentText, {
    snapshot,
    action,
    minConfidence: 0,
    limit: opts.maxResults ?? 8,
  });
  const signatureBasis = await capturePageSignature(ctx.driver, snapshot);
  const contextByRef = buildAncestorContextMap(snapshot.accessibilityTree);
  return { elements, ranked, signatureBasis, intentText, action, contextByRef };
}

/**
 * Act on a confidently-chosen candidate (mirrors L1: ordered `[durableSelector, ref:eN]` array →
 * `driver.batch`). Returns the SAME success `StepExecution` shape as L1 (tagged `tier`), or an
 * escalating result when the action failed / was ambiguous. Carries the chosen candidate `name`
 * as `pinnedLabel` (for Round-2 `ai_pick` labeling).
 */
export async function actOnPick(
  step: Step,
  ctx: ResolveContext,
  args: {
    tier: LadderTier;
    chosen: RankedCandidate;
    elements: InteractiveElement[];
    ranked: RankedCandidate[];
    signatureBasis: { sig: string; url: string };
    intentText: string;
    action: BatchActionVerb;
  },
): Promise<StepExecution> {
  const { tier, chosen, elements, ranked, signatureBasis, intentText, action } = args;
  const element = elements.find((e) => e.ref === chosen.ref);

  // Build the ordered selector array exactly like L1: durable selector first, ref as fallback.
  const selectors = chosen.ref ? [chosen.selector, `ref:${chosen.ref}`] : [chosen.selector];
  const batchStep = buildBatchStep(step, action, selectors);
  const result = await ctx.driver.batch([batchStep], { onFail: "stop" });
  const sr = result.steps[0];

  const succeeded = !!sr && sr.success && sr.outcomeStatus !== "ambiguous";
  if (!succeeded) {
    const exec: StepExecution = {
      ok: false,
      tier,
      candidates: ranked,
      escalate: true,
      handoff: buildHandoff({ intent: intentText, action, ranked }),
      error: sr?.error ?? `${tier}: chosen candidate did not resolve/act`,
    };
    if (sr?.failureReason !== undefined) exec.failureReason = sr.failureReason;
    if (sr?.coveringElement !== undefined) exec.coveringElement = sr.coveringElement;
    return exec;
  }

  // Learn the winning strategy + a DURABLE selector (mirrors L1 `learnFromResult`).
  let strategy = chosen.strategy;
  let durableSelector = chosen.selector;
  const selectorUsed = sr.selectorUsed;
  if (selectorUsed) {
    const mapped = selectorUsedToStrategy(selectorUsed);
    if (mapped !== null) {
      strategy = mapped;
      durableSelector = selectorUsed;
    } else if (element) {
      strategy = strategyForElement(element);
      durableSelector = durableSelectorForElement(element) ?? chosen.selector;
    }
  } else if (element) {
    strategy = strategyForElement(element);
    durableSelector = durableSelectorForElement(element) ?? chosen.selector;
  }

  const exec: StepExecution = {
    ok: true,
    tier,
    strategy,
    durableSelector,
    candidates: ranked,
    escalate: false,
    signatureBasis,
  };
  if (selectorUsed !== undefined) exec.selectorUsed = selectorUsed;
  if (chosen.name) exec.pinnedLabel = chosen.name;
  return exec;
}

/** An escalating (could-not-resolve) AI-tier result carrying the handoff + a note. */
export function escalateExecution(
  tier: LadderTier,
  args: {
    ranked: RankedCandidate[];
    intentText: string;
    action: BatchActionVerb;
    error: string;
  },
): StepExecution {
  return {
    ok: false,
    tier,
    candidates: args.ranked,
    escalate: true,
    handoff: buildHandoff({ intent: args.intentText, action: args.action, ranked: args.ranked }),
    error: args.error,
  };
}
