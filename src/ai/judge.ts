// Flightplan — the `ai_judge` oracle (PLAN.md §5 Phase 4; PROPOSAL "AI judge").
//
// `ai_judge` is a BOOLEAN oracle (`{pass, reason?}` via the Output API; NO threshold) and NEVER
// heals — it checks the world and reports. Model routing follows the modality (PROPOSAL): if
// `inputs` include `screenshot` it MUST use the vision model (and consumes a `max_screenshots`
// budget unit); otherwise it runs on a text model over the page `source`/`text`. The `ai_call`
// event uses `role:'judge'` while cost is attributed to the underlying model role (vision/resolver)
// so the run summary's `model_usage` rows stay within the narrow role union.

import type { AiJudgeAssertion } from "../flow/types.ts";
import type { AiJudgeOptions, AssertionResult } from "../assert/types.ts";
import type { PageSnapshot } from "../driver/types.ts";
import { isBudgetExceeded } from "./budget.ts";
import { aiCall } from "./call.ts";
import type { AiCallRuntime } from "./call.ts";
import { JudgeSchema } from "./schemas.ts";
import { AI_MIN_OUTPUT_TOKENS } from "./resolver-l2.ts";
import type { AiMessage } from "./types.ts";

/** Default modalities when an `ai_judge` omits `inputs` (PROPOSAL: extracted text). */
const DEFAULT_INPUTS = ["text"] as const;

/** Gather the requested textual context from a snapshot (the `source`/`text` modalities). */
function gatherTextContext(snapshot: PageSnapshot, inputs: readonly string[]): string {
  const parts: string[] = [`URL: ${snapshot.url}`, `Title: ${snapshot.title}`];
  if (inputs.includes("text")) {
    parts.push("--- TEXT ---", snapshot.text);
  }
  if (inputs.includes("source")) {
    // v0: the driver boundary does not expose raw HTML, so we use the structural snapshot
    // (interactive elements + accessibility tree) as the `source` proxy. Documented limitation.
    parts.push(
      "--- SOURCE (structural proxy) ---",
      JSON.stringify(
        {
          interactiveElements: snapshot.interactiveElements,
          accessibilityTree: snapshot.accessibilityTree,
        },
        null,
        0,
      ),
    );
  }
  return parts.join("\n");
}

/** The judge prompt: the pass-statement + the gathered context. */
function buildJudgePrompt(prompt: string, context: string): string {
  return [
    "You are a strict boolean judge for a browser test assertion.",
    `Pass statement: ${JSON.stringify(prompt)}`,
    "Set pass=true ONLY if the statement holds for the page below; otherwise pass=false.",
    "Keep reason under 16 words.",
    "",
    context,
  ].join("\n");
}

/**
 * Evaluate one `ai_judge` assertion. Routes vision (screenshot) vs text, calls the model via the
 * Output API, and returns a pass/fail {@link AssertionResult}. Budget errors propagate (→ the
 * runner maps them to `inconclusive`); any other model failure becomes a failing result so it
 * surfaces rather than crashing the run.
 */
export async function judge(
  rt: AiCallRuntime,
  assertion: AiJudgeAssertion,
  opts: AiJudgeOptions,
): Promise<AssertionResult> {
  const inputs = assertion.inputs ?? [...DEFAULT_INPUTS];
  const useVision = inputs.includes("screenshot");
  const purpose = `judge:${opts.stepId ?? "assert"}`;
  const when = opts.when ?? "after";

  const base = {
    type: "ai_judge" as const,
    durationMs: 0,
    when,
    selectorOrTarget: assertion.prompt,
  };

  try {
    let pass: boolean;
    let reason: string | undefined;

    if (useVision) {
      // Consume a screenshot budget unit FIRST (throws BudgetExceededError('max_screenshots')).
      rt.budget.noteScreenshot();
      const shot = await opts.driver.screenshot({ format: "jpeg", quality: 60 });
      const dataUrl = shot.startsWith("data:") ? shot : `data:image/jpeg;base64,${shot}`;
      // Gather any requested text/source context to accompany the image.
      const snapshot = await opts.driver.snapshot();
      const context = gatherTextContext(snapshot, inputs);
      const messages: AiMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: buildJudgePrompt(assertion.prompt, context) },
            { type: "file", mediaType: "image/jpeg", data: dataUrl },
          ],
        },
      ];
      const res = await aiCall(rt, {
        modelRole: "vision",
        callRole: "judge",
        purpose,
        schema: JudgeSchema,
        maxOutputTokens: AI_MIN_OUTPUT_TOKENS, // ≥512 — Gemini thinking tokens (FINDINGS §3)
        messages,
      });
      pass = res.output.pass;
      reason = res.output.reason;
    } else {
      const snapshot = await opts.driver.snapshot();
      const context = gatherTextContext(snapshot, inputs);
      const res = await aiCall(rt, {
        modelRole: "resolver", // a text judge runs on the cheap text model
        callRole: "judge",
        purpose,
        schema: JudgeSchema,
        maxOutputTokens: AI_MIN_OUTPUT_TOKENS,
        prompt: buildJudgePrompt(assertion.prompt, context),
      });
      pass = res.output.pass;
      reason = res.output.reason;
    }

    return { ...base, pass, message: reason ?? (pass ? "ai_judge: pass" : "ai_judge: fail") };
  } catch (err) {
    if (isBudgetExceeded(err)) throw err; // budgets fail the run fast
    return {
      ...base,
      pass: false,
      message: `ai_judge: model call failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
