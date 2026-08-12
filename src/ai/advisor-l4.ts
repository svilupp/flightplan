// Flightplan — L4: the advisor tier (PLAN.md §2 (b) / §5 Phase 4; PROPOSAL "Advisory verdict").
//
// The advisor fires to CLASSIFY a persistent failure — it NEVER acts. It makes a text-only call
// and returns a TERMINAL `StepExecution` (`ok:false`, `tier:'L4'`, `escalate:false`) carrying the
// typed `advisory` verdict (`heal | bug | flake | intent_changed`). The `ai_call` event records
// `advisoryVerdict: verdict.kind`. What the runner DOES with the verdict (heal-write, proposed
// patch, fail) is Round 2 — here we only produce + attach it.

import type { Step } from "../flow/types.ts";
import type { ResolveContext, StepExecution } from "../ladder/index.ts";
import type { AdvisoryFlakeVerdict, AdvisoryVerdict } from "../types.ts";
import { isBudgetExceeded } from "./budget.ts";
import type { AiCallRuntime } from "./call.ts";
import { aiCall } from "./call.ts";
import { intentTextForStep } from "./resolve-common.ts";
import { AI_DEFAULT_OUTPUT_TOKENS } from "./resolver-l2.ts";
import { AdvisorVerdictSchema } from "./schemas.ts";

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

/**
 * The SAFE degraded verdict when the advisor model's response cannot be produced or parsed (the
 * measured `z-ai/glm-5.2` "No object generated: could not parse the response" crash class). The
 * advisor is a TERMINAL, NON-ACTING classifier, so a degraded verdict is always acceptable: we
 * classify as `flake` — the only kind that acts on NOTHING (`heal` would write the lock, and
 * `bug`/`intent_changed` assert product claims we have no evidence for). The step's REAL pass/fail
 * is decided by its assertions, never by this verdict, so degrading here keeps the run correct while
 * never aborting it. `detail` names the degradation (the classified failure outcome or an error
 * message) so the trace/log make the low-confidence, non-informative nature explicit.
 */
function degradedAdvisorVerdict(detail: string): AdvisoryFlakeVerdict {
  return {
    kind: "flake",
    reason: `advisor could not classify (${detail}); degraded to a non-acting flake — the step's real pass/fail is decided by its assertions`,
  };
}

/** L4 advisor: classify the persistent failure into a TERMINAL verdict (never acts). */
export async function classifyL4(
  rt: AiCallRuntime,
  step: Step,
  prior: StepExecution,
  _ctx: ResolveContext,
): Promise<StepExecution> {
  let res: Awaited<ReturnType<typeof aiCall<typeof AdvisorVerdictSchema>>>;
  try {
    res = await aiCall(rt, {
      modelRole: "advisor",
      callRole: "advisor",
      purpose: `classify:${step.id}`,
      schema: AdvisorVerdictSchema,
      maxOutputTokens: AI_DEFAULT_OUTPUT_TOKENS,
      prompt: buildAdvisorPrompt(step, prior),
      deriveOutcome: (v) => ({ outcome: v.kind, advisoryVerdict: v.kind }),
      // A malformed / unparseable / hung advisor response must NEVER abort the run: degrade to a
      // safe, non-acting `flake` verdict (recorded on `ai.jsonl` as the failure outcome) instead of
      // throwing. `aiCall` returns this via `res.output` with `res.degraded === true`.
      fallback: ({ outcome }) => degradedAdvisorVerdict(outcome),
    });
  } catch (err) {
    if (isBudgetExceeded(err)) throw err; // budgets fail the run fast — never degraded
    // With `fallback` wired above, a parse/generation failure degrades IN-BAND (never reaches here);
    // this catch is a belt-and-suspenders guard for any other unexpected throw. Still terminal +
    // non-acting: degrade to a `flake` rather than crashing the run.
    const verdict = degradedAdvisorVerdict(err instanceof Error ? err.message : String(err));
    const exec: StepExecution = {
      ok: false,
      tier: "L4",
      escalate: false,
      advisory: verdict,
      error: summarizeVerdict(verdict),
    };
    if (prior.candidates) exec.candidates = prior.candidates;
    return exec;
  }

  // A successful call carries the model's real verdict; a degraded call carries the safe `flake`
  // above. Both are valid `AdvisoryVerdict`s and flow through the SAME terminal construction.
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
