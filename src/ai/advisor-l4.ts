// Flightplan — L4: the advisor tier (PLAN.md §2 (b) / §5 Phase 4; PROPOSAL "Advisory verdict").
//
// The advisor fires to CLASSIFY a persistent failure — it NEVER acts. It makes a text-only call
// and returns a TERMINAL `StepExecution` (`ok:false`, `tier:'L4'`, `escalate:false`) carrying the
// typed `advisory` verdict (`heal | bug | flake | intent_changed`). The `ai_call` event records
// `advisoryVerdict: verdict.kind`. What the runner DOES with the verdict (heal-write, proposed
// patch, fail) is Round 2 — here we only produce + attach it.

import type { Step } from "../flow/types.ts";
import type { ResolveContext, StepExecution } from "../ladder/index.ts";
import type { AdvisoryVerdict } from "../types.ts";
import { isBudgetExceeded } from "./budget.ts";
import { aiCall } from "./call.ts";
import type { AiCallRuntime } from "./call.ts";
import { AdvisorVerdictSchema } from "./schemas.ts";
import { AI_MIN_OUTPUT_TOKENS } from "./resolver-l2.ts";
import { intentTextForStep } from "./resolve-common.ts";

/** A one-line human summary of a verdict (the `StepExecution.error` / log note). */
export function summarizeVerdict(v: AdvisoryVerdict): string {
  switch (v.kind) {
    case "heal":
      return `advisor: heal → ${v.recipe.strategy} ${v.recipe.selector} (confidence ${v.confidence})`;
    case "bug":
      return `advisor: bug — ${v.summary}`;
    case "flake":
      return `advisor: flake — ${v.reason}`;
    case "intent_changed":
      return `advisor: intent_changed — ${v.summary}`;
  }
}

/** Build the advisor text prompt from the step + the deepest prior (failed) execution. */
export function buildAdvisorPrompt(step: Step, prior: StepExecution): string {
  const intent = intentTextForStep(step);
  const matches =
    prior.handoff?.topMatches
      ?.map((m) => `  - role=${m.role} name=${JSON.stringify(m.name)} score=${m.score}`)
      .join("\n") ?? "  (none)";
  return [
    `A browser step could not be resolved by the deterministic + resolver + vision tiers. Classify why.`,
    `Step id: ${step.id} (do=${step.do})`,
    `Intent: ${JSON.stringify(intent)}`,
    prior.failureReason ? `Last failure reason: ${prior.failureReason}` : "",
    prior.error ? `Last error: ${prior.error}` : "",
    "Top candidates seen on the page:",
    matches,
    "",
    "Return ONE verdict:",
    '- "heal": a safe selector heal is possible → give target + recipe{strategy,selector} + confidence.',
    '- "bug": a real product failure → summary + evidence[].',
    '- "flake": transient → reason.',
    '- "intent_changed": the step no longer matches the app → summary + a proposed_patch_path.',
  ]
    .filter(Boolean)
    .join("\n");
}

/** L4 advisor: classify the persistent failure into a TERMINAL verdict (never acts). */
export async function classifyL4(
  rt: AiCallRuntime,
  step: Step,
  prior: StepExecution,
  _ctx: ResolveContext,
): Promise<StepExecution> {
  let res;
  try {
    res = await aiCall(rt, {
      modelRole: "advisor",
      callRole: "advisor",
      purpose: `classify:${step.id}`,
      schema: AdvisorVerdictSchema,
      maxOutputTokens: AI_MIN_OUTPUT_TOKENS,
      prompt: buildAdvisorPrompt(step, prior),
      deriveOutcome: (v) => ({ outcome: v.kind, advisoryVerdict: v.kind }),
    });
  } catch (err) {
    if (isBudgetExceeded(err)) throw err;
    // The advisor itself failed — surface a terminal result without a verdict (the runner fails it).
    return {
      ok: false,
      tier: "L4",
      escalate: false,
      candidates: prior.candidates,
      error: `L4 advisor call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const verdict = res.output;
  const exec: StepExecution = {
    ok: false,
    tier: "L4",
    escalate: false, // terminal — the advisor classifies; it does not climb further
    advisory: verdict,
    error: summarizeVerdict(verdict),
  };
  if (prior.candidates) exec.candidates = prior.candidates;
  return exec;
}
