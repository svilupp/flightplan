// Flightplan — L3: the vision tier (PLAN.md §2 (b) / §5 Phase 4; FINDINGS §3, spike 12/17).
//
// Fires when the resolver lost or explicitly asked for a screenshot. It consumes a
// `max_screenshots` budget unit FIRST, captures a JPEG screenshot (`format:'jpeg', quality:60`),
// builds a `data:image/jpeg;base64,...` URL, takes a fresh snapshot for refs/candidates/signature,
// and calls the vision model with a multimodal `messages` payload (a `text` part + a `file` part)
// at `maxOutputTokens ≥ 512` (Gemini thinking-token caveat — load-bearing). On a confident pick it
// acts and returns `tier:'L3'`; otherwise it escalates → L4.

import type { Step } from "../flow/types.ts";
import type { ResolveContext, StepExecution } from "../ladder/index.ts";
import { isBudgetExceeded } from "./budget.ts";
import { aiCall } from "./call.ts";
import type { AiCallRuntime } from "./call.ts";
import { ResolverDecisionSchema } from "./schemas.ts";
import type { CandidatePacketEntry } from "./resolve-common.ts";
import { actOnPick, buildCandidatePacket, escalateExecution, gatherCandidates } from "./resolve-common.ts";
import { AI_MIN_OUTPUT_TOKENS, L2_MIN_CONFIDENCE } from "./resolver-l2.ts";
import type { BudgetTracker } from "./budget.ts";
import type { AiMessage } from "./types.ts";

/** Build the vision prompt text (the screenshot is attached as a separate `file` part). */
export function buildVisionPrompt(
  intent: string,
  action: string,
  packet: CandidatePacketEntry[],
): string {
  const list = packet.length
    ? packet.map((c) => `  [${c.index}] role=${c.role} name=${JSON.stringify(c.name)}`).join("\n")
    : "  (no interactive candidates)";
  return [
    `Look at the screenshot to resolve the target of a browser "${action}" step.`,
    `Intent: ${JSON.stringify(intent)}`,
    "Numbered interactive candidates (pick the single best by index, using the image):",
    list,
    "",
    'Respond with decision="pick" and the index + a confidence (0..1) for the candidate that matches the intent in the image.',
    'If none match, respond decision="give_up". Keep reason under 12 words.',
  ].join("\n");
}

/** The vision tier needs the budget tracker (for the screenshot pre-check) plus the call runtime. */
export interface VisionRuntime extends AiCallRuntime {
  budget: BudgetTracker;
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
  const { elements, ranked, signatureBasis, intentText, action } = await gatherCandidates(step, ctx, {
    maxResults: 12,
  });
  const packet = buildCandidatePacket(ranked);

  const messages: AiMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: buildVisionPrompt(intentText, action, packet) },
        { type: "file", mediaType: "image/jpeg", data: dataUrl },
      ],
    },
  ];

  let decision;
  try {
    decision = await aiCall(rt, {
      modelRole: "vision",
      callRole: "vision",
      purpose: `vision:${step.id}`,
      schema: ResolverDecisionSchema,
      maxOutputTokens: AI_MIN_OUTPUT_TOKENS, // ≥512 — Gemini thinking tokens (FINDINGS §3)
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

  const d = decision.output;
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

  return actOnPick(step, ctx, {
    tier: "L3",
    chosen: ranked[d.index]!,
    elements,
    ranked,
    signatureBasis,
    intentText,
    action,
  });
}
