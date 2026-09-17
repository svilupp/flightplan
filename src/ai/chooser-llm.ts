// Flightplan — `LlmChooser`: the generative resolver text pick as a `CandidateChooser`
// (extracted from the pre-Phase-0 body of `resolveL2`).
//
// Behavior-identical to the original `resolveL2`: `buildResolverPrompt` + `aiCall` with
// `ResolverDecisionSchema` + the `L2_MIN_CONFIDENCE` gate. `decision === "screenshot_needed"` →
// `{ kind: "abstain", escalateTo: "vision" }`; `give_up` / low confidence → plain abstain; a
// non-budget `aiCall` throw → `{ kind: "error" }` (a budget error propagates, matching the
// original `isBudgetExceeded` re-throw).

import { isBudgetExceeded } from "./budget.ts";
import type { AiCallRuntime } from "./call.ts";
import { aiCall } from "./call.ts";
import type { CandidateChooser, ChooseContext, ChooseResult } from "./chooser.ts";
import type { CandidatePacketEntry } from "./resolve-common.ts";
import { AI_DEFAULT_OUTPUT_TOKENS, buildResolverPrompt, L2_MIN_CONFIDENCE } from "./resolver-l2.ts";
import { ResolverDecisionSchema } from "./schemas.ts";

export class LlmChooser implements CandidateChooser {
  readonly kind = "llm" as const;

  constructor(private readonly rt: AiCallRuntime) {}

  async choose(
    intent: string,
    candidates: CandidatePacketEntry[],
    ctx: ChooseContext,
  ): Promise<ChooseResult> {
    let decision: Awaited<ReturnType<typeof aiCall<typeof ResolverDecisionSchema>>>;
    try {
      decision = await aiCall(this.rt, {
        modelRole: "resolver",
        callRole: "resolver",
        purpose: `resolve:${ctx.step.id}`,
        schema: ResolverDecisionSchema,
        maxOutputTokens: AI_DEFAULT_OUTPUT_TOKENS,
        prompt: buildResolverPrompt(intent, ctx.action, candidates, ctx.note),
      });
    } catch (err) {
      if (isBudgetExceeded(err)) throw err; // budgets fail the run fast — never swallowed
      return {
        kind: "error",
        reason: `L2 resolver call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const d = decision.output;
    // `screenshot_needed` short-circuits the chain straight to L3.
    if (d.decision === "screenshot_needed") {
      return { kind: "abstain", reason: "llm: screenshot_needed", escalateTo: "vision" };
    }
    if (
      d.decision !== "pick" ||
      d.index === undefined ||
      (d.confidence ?? 0) < L2_MIN_CONFIDENCE ||
      !candidates[d.index]
    ) {
      return {
        kind: "abstain",
        reason: `llm: ${d.decision}${d.reason ? ` — ${d.reason}` : ""} (confidence ${d.confidence ?? 0})`,
      };
    }

    return {
      kind: "pick",
      index: d.index,
      confidence: d.confidence ?? 0,
      ...(d.note !== undefined ? { note: d.note } : {}),
    };
  }
}
