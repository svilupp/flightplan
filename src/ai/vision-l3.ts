// Flightplan — L3: the vision tier (PLAN.md §2 (b) / §5 Phase 4; FINDINGS §3, spike 12/17).
//
// Fires when the resolver lost or explicitly asked for a screenshot. It consumes a
// `max_screenshots` budget unit FIRST, captures a JPEG screenshot (`format:'jpeg', quality:60`),
// builds a `data:image/jpeg;base64,...` URL, takes a fresh snapshot for refs/candidates/signature,
// and calls the vision model with a multimodal `messages` payload (a `text` part + a `file` part)
// (Gemini thinking tokens count against the output-token cap — load-bearing). On a confident pick it
// acts and returns `tier:'L3'`; otherwise it escalates → L4.

import { z } from "zod";
import type { Step } from "../flow/types.ts";
import type { ResolveContext, StepExecution } from "../ladder/index.ts";
import type { BudgetTracker } from "./budget.ts";
import { isBudgetExceeded } from "./budget.ts";
import type { AiCallRuntime } from "./call.ts";
import { aiCall } from "./call.ts";
import type { CandidatePacketEntry, GatheredCandidates } from "./resolve-common.ts";
import {
  actOnPick,
  attachEmittedNote,
  buildCandidatePacket,
  escalateExecution,
  gatherCandidates,
  storedNoteForStep,
} from "./resolve-common.ts";
import { AI_DEFAULT_OUTPUT_TOKENS, L2_MIN_CONFIDENCE } from "./resolver-l2.ts";
import { NOTE_MAX_LENGTH, ResolverDecisionSchema } from "./schemas.ts";
import type { AiMessage } from "./types.ts";

/**
 * Build the vision prompt text (the screenshot is attached as a separate `file` part). When a FRESH
 * stored `note` exists (the note-to-future-self, DESIGN §4), it is prepended as advisory context so
 * the model spends fewer tokens rediscovering the page. Advisory only — never a directive.
 */
export function buildVisionPrompt(
  intent: string,
  action: string,
  packet: CandidatePacketEntry[],
  note?: string,
): string {
  const list = packet.length
    ? packet.map((c) => `  [${c.index}] role=${c.role} name=${JSON.stringify(c.name)}`).join("\n")
    : "  (no interactive candidates)";
  const lines = [
    `Look at the screenshot to resolve the target of a browser "${action}" step.`,
    `Intent: ${JSON.stringify(intent)}`,
  ];
  if (note) {
    lines.push(
      `Note from a previous resolution of this target (advisory context only): ${JSON.stringify(note)}`,
    );
  }
  lines.push(
    "Numbered interactive candidates (pick the single best by index, using the image):",
    list,
    "",
    'Respond with decision="pick" and the index + a confidence (0..1) for the candidate that matches the intent in the image.',
    'If none match, respond decision="give_up". Keep reason under 12 words.',
    'Optionally set "note": a short (<160 char) hint for a FUTURE resolution of this target (e.g. layout/glyph/no-testid cues). Emit it ONLY when genuinely useful; never a selector or secret.',
  );
  return lines.join("\n");
}

/** The vision tier needs the budget tracker (for the screenshot pre-check) plus the call runtime. */
export interface VisionRuntime extends AiCallRuntime {
  budget: BudgetTracker;
}

/** The `ResolverDecision`-shaped pick a vision call (single or per-target batch) produces. */
type VisionPick = {
  decision: string;
  index?: number;
  confidence?: number;
  reason?: string;
  note?: string;
};

/**
 * Apply one vision decision (the shared {@link ResolverDecisionSchema} shape) to a gathered target:
 * on a confident, in-range `pick` → `actOnPick` (tagged `tier:'L3'`) + the confidence-/corroboration-
 * gated note; otherwise → an escalating `StepExecution` (climb to L4). Shared by the single-target
 * {@link resolveL3} and the per-target unpacking in {@link resolveBatchL3}, so both map a model pick
 * back onto the SAME concrete ranked candidate and produce the SAME `StepExecution` shape.
 */
async function actOnVisionDecision(
  step: Step,
  ctx: ResolveContext,
  gathered: GatheredCandidates,
  d: VisionPick,
): Promise<StepExecution> {
  const { elements, ranked, signatureBasis, intentText, action } = gathered;
  if (
    d.decision !== "pick" ||
    d.index === undefined ||
    (d.confidence ?? 0) < L2_MIN_CONFIDENCE ||
    !ranked[d.index]
  ) {
    return escalateExecution("L3", {
      ranked,
      intentText,
      action,
      error: `L3: ${d.decision}${d.reason ? ` — ${d.reason}` : ""} (confidence ${d.confidence ?? 0})`,
    });
  }

  const exec = await actOnPick(step, ctx, {
    tier: "L3",
    chosen: ranked[d.index]!,
    elements,
    ranked,
    signatureBasis,
    intentText,
    action,
  });
  // note_out: attach the model's emitted note (if any) so the write-back can sanitize + redact +
  // persist it. Confidence-gated (PLAN_v003 §6 v003-4): a note survives only from a CORROBORATED
  // pick (the model chose the deterministic fuzzy #1) OR a HIGH-CONFIDENCE pick. `ranked` is sorted
  // best-first, so `index === 0` with a real fuzzy score means text ranking and the model agree.
  const corroborated = d.index === 0 && (ranked[0]?.score ?? 0) > 0;
  return attachEmittedNote(exec, d.note, {
    corroborated,
    ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
  });
}

/** L3 vision: screenshot + fresh snapshot → pick by index → act. */
export async function resolveL3(
  rt: VisionRuntime,
  step: Step,
  _prior: StepExecution,
  ctx: ResolveContext,
): Promise<StepExecution> {
  // Consume a screenshot budget unit FIRST. Throws BudgetExceededError('max_screenshots').
  rt.budget.noteScreenshot();
  const shot = await ctx.driver.screenshot({ format: "jpeg", quality: 60 });
  const dataUrl = shot.startsWith("data:") ? shot : `data:image/jpeg;base64,${shot}`;

  // Fresh snapshot for valid refs / candidates / signatureBasis (page unchanged after failed L1/L2).
  const gathered = await gatherCandidates(step, ctx, { maxResults: 12 });
  const { ranked, intentText, action } = gathered;
  const packet = buildCandidatePacket(ranked);
  // note_in: the FRESH stored note (advisory context) for this target, if any (DESIGN §4).
  const noteIn = await storedNoteForStep(step, ctx);

  const messages: AiMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: buildVisionPrompt(intentText, action, packet, noteIn) },
        { type: "file", mediaType: "image/jpeg", data: dataUrl },
      ],
    },
  ];

  let decision: Awaited<ReturnType<typeof aiCall<typeof ResolverDecisionSchema>>>;
  try {
    decision = await aiCall(rt, {
      modelRole: "vision",
      callRole: "vision",
      purpose: `vision:${step.id}`,
      schema: ResolverDecisionSchema,
      maxOutputTokens: AI_DEFAULT_OUTPUT_TOKENS, // Gemini thinking tokens count against this cap (FINDINGS §3)
      messages,
    });
  } catch (err) {
    if (isBudgetExceeded(err)) throw err;
    return escalateExecution("L3", {
      ranked,
      intentText,
      action,
      error: `L3 vision call failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return actOnVisionDecision(step, ctx, gathered, decision.output);
}

// ===========================================================================
// L3 vision — BATCHING (PLAN_v003 §4 v003-3 / pillar (c))
// ===========================================================================
//
// When ≥2 targets on the SAME page are routed to vision, one screenshot serves all of them and one
// vision call answers all of them (measured: 1 batch for 8 icons == 8 singles at 8/8 quality,
// ~79.5% cheaper / ~74.7% faster). We take ONE screenshot, gather per-target candidates from the
// unchanged page, and send ONE multi-target prompt keyed by a stable per-target `key`. The model
// answers each key with a geometry-anchored pick (its index into that target's numbered candidate
// packet — the packet entry carries the concrete ref/selector, so the answer maps back to a real
// element).
//
// PARSE ROBUSTNESS (a malformed model response must never break the run): the call is validated
// against a LENIENT envelope (`{ picks: [ ...unknown ] }`) so the provider does NOT reject the whole
// batch over a single off-contract pick — the pre-fix `.strict()` schema forced ALL targets to fall
// back on one bad key. The real per-pick contract (`BatchTargetPickSchema`) is then re-enforced
// INDIVIDUALLY in `indexByKey` via `safeParse`: a malformed / missing / duplicated key is dropped
// and resolved by a single-call-per-target `resolveL3` (its well-formed siblings still resolve from
// the one batch call), and an entirely unparseable batch (no `picks` array at all) still throws
// inside `aiCall` → the try/catch below falls EVERY target back per-target. Either way, one bad key
// never throws out of the batch.

/** One target's pick inside a batch response — the single-target decision shape plus its `key`. */
const BatchTargetPickSchema = z
  .object({
    key: z.string().min(1),
    decision: z.enum(["pick", "screenshot_needed", "give_up"]),
    index: z.number().int().min(0).optional(),
    confidence: z.number().min(0).max(1).optional(),
    reason: z.string().optional(),
    note: z.string().max(NOTE_MAX_LENGTH).optional(),
  })
  .strict();

/**
 * The batch vision output: one `picks[]` entry per target, keyed back to the concrete target by
 * `key`. Strict (`.strict()`) — this is the IDEAL, fully-validated shape (kept for the public
 * surface + its inferred type). The actual model call validates against {@link BatchVisionEnvelope}
 * (a lenient envelope) and re-enforces THIS per-pick contract individually in {@link indexByKey}, so
 * one off-contract pick can't reject the whole batch. See the PARSE ROBUSTNESS note above.
 */
export const BatchVisionSchema = z.object({ picks: z.array(BatchTargetPickSchema) }).strict();

export type BatchVisionOutput = z.infer<typeof BatchVisionSchema>;

/** One validated per-target pick (the strict per-pick contract re-enforced in {@link indexByKey}). */
type BatchTargetPick = z.infer<typeof BatchTargetPickSchema>;

/**
 * The LENIENT envelope actually handed to the batch model call. Only the OUTER shape is validated
 * (`{ picks: [...] }`) and each pick is left UNKNOWN, so a single mis-typed / off-contract / non-
 * object pick can NOT reject the whole batch at the provider's validation boundary (the real
 * per-pick contract, {@link BatchTargetPickSchema}, is re-applied individually in {@link indexByKey}).
 * The detailed pick shape is carried to the model by {@link buildBatchVisionPrompt}, not this schema.
 * A response with no `picks` array still fails validation → the batch falls back per-target for ALL
 * targets (the documented whole-batch fallback).
 */
const BatchVisionEnvelope = z.object({ picks: z.array(z.unknown()) });

/** A step + its freshly-gathered candidates + prompt inputs, carried through the batch flow. */
interface BatchTarget {
  key: string;
  step: Step;
  gathered: GatheredCandidates;
  packet: CandidatePacketEntry[];
  noteIn?: string;
}

/**
 * Build the ONE multi-target vision prompt. Each target is a keyed block with its own intent, its
 * optional advisory note, and its own index-numbered candidate packet (indices are LOCAL to the
 * target). The model must answer EVERY key. Mirrors {@link buildVisionPrompt}'s per-target contract
 * (pick by index, `give_up` when none match, optional advisory note) — just repeated per key inside
 * a single screenshot.
 */
export function buildBatchVisionPrompt(targets: BatchTarget[]): string {
  const lines: string[] = [
    `Look at the ONE screenshot and resolve ${targets.length} independent browser targets on it.`,
    "Each target below has a stable key, an intent, an action verb, and its OWN numbered candidate",
    "list (indices are local to that target). Pick the single best candidate index for EACH target.",
    "",
  ];
  for (const t of targets) {
    const { intentText, action } = t.gathered;
    const list = t.packet.length
      ? t.packet
          .map((c) => `    [${c.index}] role=${c.role} name=${JSON.stringify(c.name)}`)
          .join("\n")
      : "    (no interactive candidates)";
    lines.push(
      `Target key=${JSON.stringify(t.key)} action="${action}" intent=${JSON.stringify(intentText)}`,
    );
    if (t.noteIn) {
      lines.push(`  Note (advisory context only): ${JSON.stringify(t.noteIn)}`);
    }
    lines.push("  Candidates:", list, "");
  }
  lines.push(
    'Respond with a "picks" array holding ONE entry per target key above. Each entry: the "key",',
    'decision="pick" with the matching "index" + a confidence (0..1), or decision="give_up" if none',
    'match (keep reason under 12 words). Optionally add a short (<160 char) "note" hint for a FUTURE',
    "resolution of that target — only when genuinely useful; never a selector or secret.",
  );
  return lines.join("\n");
}

/**
 * Resolve ≥2 same-page vision targets with ONE screenshot + ONE vision call (PLAN_v003 §4 v003-3).
 *
 * Returns per-step `StepExecution`s in the SAME ORDER as `steps`. Behaviour:
 *  - A single step degrades to {@link resolveL3} (nothing to batch).
 *  - Otherwise: take ONE screenshot, gather each target's candidates from the unchanged page, send
 *    ONE keyed multi-target prompt, and STRICT-JSON parse the response.
 *  - Each parsed, key-matched pick is applied via the shared {@link actOnVisionDecision} spine.
 *  - PER-TARGET FALLBACK: any target the batch did not cleanly answer (the call threw, the response
 *    was malformed, or that key was missing/duplicated) is resolved by an individual {@link resolveL3}
 *    call — so a partial/garbage batch answer degrades gracefully and never breaks the run.
 *
 * Budget: the batch consumes ONE screenshot unit + ONE model call for the shared call; each
 * fall-back target then consumes its own screenshot + model call via `resolveL3` (identical to
 * never having batched it).
 */
export async function resolveBatchL3(
  rt: VisionRuntime,
  steps: Step[],
  ctx: ResolveContext,
): Promise<StepExecution[]> {
  if (steps.length === 0) return [];
  // Nothing to batch — a lone target is just a single-target L3 (no wasted multi-target prompt).
  if (steps.length === 1) return [await resolveL3(rt, steps[0]!, syntheticPrior(), ctx)];

  // ONE screenshot for the whole batch (the expensive, shared vision input). Budget: 1 unit.
  rt.budget.noteScreenshot();
  const shot = await ctx.driver.screenshot({ format: "jpeg", quality: 60 });
  const dataUrl = shot.startsWith("data:") ? shot : `data:image/jpeg;base64,${shot}`;

  // Gather each target's candidates from the (unchanged) page. Keys are the step ids (unique per
  // flow — steps/unique-ids), so the model's answer maps unambiguously back to a concrete step.
  const targets: BatchTarget[] = [];
  for (const step of steps) {
    const gathered = await gatherCandidates(step, ctx, { maxResults: 12 });
    const noteIn = await storedNoteForStep(step, ctx);
    targets.push({
      key: step.id,
      step,
      gathered,
      packet: buildCandidatePacket(gathered.ranked),
      ...(noteIn !== undefined ? { noteIn } : {}),
    });
  }

  const messages: AiMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: buildBatchVisionPrompt(targets) },
        { type: "file", mediaType: "image/jpeg", data: dataUrl },
      ],
    },
  ];

  // ONE vision call for all targets. Budget: 1 model call. A thrown call → EVERY target falls back.
  let byKey: Map<string, VisionPick> | undefined;
  try {
    const decision = await aiCall(rt, {
      modelRole: "vision",
      callRole: "vision",
      purpose: `vision-batch:${targets.map((t) => t.step.id).join(",")}`,
      // Lenient envelope (per-pick validation happens in `indexByKey`) — see PARSE ROBUSTNESS note.
      schema: BatchVisionEnvelope,
      maxOutputTokens: AI_DEFAULT_OUTPUT_TOKENS,
      messages,
    });
    byKey = indexByKey(decision.output.picks);
  } catch (err) {
    if (isBudgetExceeded(err)) throw err;
    byKey = undefined; // malformed / failed batch → per-target fallback for ALL targets.
  }

  // Apply each target's key-matched pick; per-target fallback for any key the batch did not answer.
  const results: StepExecution[] = [];
  for (const t of targets) {
    const pick = byKey?.get(t.key);
    if (pick) {
      results.push(await actOnVisionDecision(t.step, ctx, t.gathered, pick));
    } else {
      // Missing/duplicated/unparseable for this key → resolve it on its own (single-call-per-target).
      results.push(await resolveL3(rt, t.step, syntheticPrior(), ctx));
    }
  }
  return results;
}

/** A synthetic, non-recorded prior for a direct L3 entry (L3 resolves from its own fresh screenshot). */
function syntheticPrior(): StepExecution {
  return { ok: false, tier: "L1", escalate: true };
}

/**
 * Index the batch picks by `key`, keeping only VALID, UNAMBIGUOUS answers. Each raw (unknown) pick
 * from the lenient envelope is re-validated INDIVIDUALLY against {@link BatchTargetPickSchema}:
 *  - a pick that fails the per-pick contract (malformed / mis-typed / non-object) is DROPPED, so a
 *    single bad key never throws and takes the whole batch down — its target simply falls back
 *    per-target while its well-formed siblings resolve from the one batch call;
 *  - a key that (after validation) appears zero or >1 times is likewise dropped (not cleanly
 *    answered) so it falls back per-target rather than acting on a duplicated/ambiguous entry.
 */
function indexByKey(picks: unknown[]): Map<string, VisionPick> {
  const valid: BatchTargetPick[] = [];
  for (const p of picks) {
    const parsed = BatchTargetPickSchema.safeParse(p);
    if (parsed.success) valid.push(parsed.data);
  }
  const counts = new Map<string, number>();
  for (const p of valid) counts.set(p.key, (counts.get(p.key) ?? 0) + 1);
  const map = new Map<string, VisionPick>();
  for (const p of valid) {
    if (counts.get(p.key) === 1) map.set(p.key, p);
  }
  return map;
}
