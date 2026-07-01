// Flightplan — L2: the resolver text tier (PLAN.md §2 (b) / §5 Phase 4; FINDINGS §2).
//
// On L1 escalation the orchestrator calls this. It takes a FRESH snapshot, ranks candidates with
// Flightplan's own fuzzy match, hands the model a compact INDEX-numbered packet (role + name +
// score — NO raw selectors; the model picks by index), and calls the resolver model via `aiCall`
// using the Output API. On a confident `pick` it acts (mirroring L1) and returns the SAME
// `StepExecution` shape with `tier:'L2'`. Otherwise (`screenshot_needed` / low confidence /
// `give_up` / a failed action) it escalates → L3/L4.

import type { Step } from "../flow/types.ts";
import type { ResolveContext, StepExecution } from "../ladder/index.ts";
import { isBudgetExceeded } from "./budget.ts";
import { aiCall } from "./call.ts";
import type { AiCallRuntime } from "./call.ts";
import { ResolverDecisionSchema } from "./schemas.ts";
import type { CandidatePacketEntry } from "./resolve-common.ts";
import { actOnPick, buildCandidatePacket, escalateExecution, gatherCandidates } from "./resolve-common.ts";

/** Minimum confidence to ACT on a resolver pick; below this we escalate to disambiguate. */
export const L2_MIN_CONFIDENCE = 0.5;

/** All roles share `maxOutputTokens ≥ 512` (Gemini thinking-token caveat; FINDINGS §3). */
export const AI_MIN_OUTPUT_TOKENS = 512;

/** Build the resolver text prompt from the intent + the index-numbered candidate packet. */
export function buildResolverPrompt(
  intent: string,
  action: string,
  packet: CandidatePacketEntry[],
): string {
  const list = packet.length
    ? packet
        .map((c) => {
          const context = c.context ? ` context=${JSON.stringify(c.context)}` : "";
          return `  [${c.index}] role=${c.role} name=${JSON.stringify(c.name)} score=${c.score}${context}`;
        })
        .join("\n")
    : "  (no interactive candidates)";
  return [
    `You are resolving the target of a browser "${action}" step.`,
    `Intent: ${JSON.stringify(intent)}`,
    "Candidates (pick the single best by index):",
    list,
    "",
    "`context` (when present) is the nearest heading/section/panel name containing the candidate —",
    "use it to disambiguate candidates that otherwise share the same role/name/score.",
    'Respond with decision="pick" and the index + a confidence (0..1) when one candidate clearly matches.',
    'If you cannot decide from this text-only list but a screenshot would help, respond decision="screenshot_needed".',
    'If no candidate could possibly match, respond decision="give_up". Keep reason under 12 words.',
  ].join("\n");
}

/** L2 resolver: consume the L1 escalation, pick by index, act. */
export async function resolveL2(
  rt: AiCallRuntime,
  step: Step,
  _prior: StepExecution,
  ctx: ResolveContext,
): Promise<StepExecution> {
  const { elements, ranked, signatureBasis, intentText, action, contextByRef } = await gatherCandidates(
    step,
    ctx,
  );
  const packet = buildCandidatePacket(ranked, contextByRef);

  let decision;
  try {
    decision = await aiCall(rt, {
      modelRole: "resolver",
      callRole: "resolver",
      purpose: `resolve:${step.id}`,
      schema: ResolverDecisionSchema,
      maxOutputTokens: AI_MIN_OUTPUT_TOKENS,
      prompt: buildResolverPrompt(intentText, action, packet),
    });
  } catch (err) {
    if (isBudgetExceeded(err)) throw err; // budgets fail the run fast — never swallowed
    return escalateExecution("L2", {
      ranked,
      intentText,
      action,
      error: `L2 resolver call failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const d = decision.output;
  if (
    d.decision !== "pick" ||
    d.index === undefined ||
    (d.confidence ?? 0) < L2_MIN_CONFIDENCE ||
    !ranked[d.index]
  ) {
    return escalateExecution("L2", {
      ranked,
      intentText,
      action,
      error: `L2: ${d.decision}${d.reason ? ` — ${d.reason}` : ""} (confidence ${d.confidence ?? 0})`,
    });
  }

  return actOnPick(step, ctx, {
    tier: "L2",
    chosen: ranked[d.index]!,
    elements,
    ranked,
    signatureBasis,
    intentText,
    action,
  });
}
