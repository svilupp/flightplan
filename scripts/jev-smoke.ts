#!/usr/bin/env bun
// Flightplan — opt-in LIVE smoke for the JEV classifier.
//
// Exercises the exact §4 request shape with the STRUCTURED `{role,name,context}` option
// encoding against the experiment's 20-candidate login-page set (`.scratch/jev/
// 02_element_picking.ts`'s candidates, re-encoded structurally) + one abstain case. Prints
// latency + choice/confidence for each. Acceptance (phase-1 gate): match the flat-string
// baseline — 4/4 correct picks + a clean `none_of_the_above` abstain.
//
// NEVER prints the API key. Skips (exit 0) when neither `TYPESAFE_API_KEY` nor `JEV_API_KEY`
// (an accepted alias) is set.
//
//   bun --env-file=.env scripts/jev-smoke.ts

import { BudgetTracker } from "../src/ai/budget.ts";
import { buildSystemOneRequest, JEV_NONE_KEY, jevCall } from "../src/ai/chooser-jev.ts";
import { CostAccumulator } from "../src/ai/cost.ts";
import type { CandidatePacketEntry } from "../src/ai/resolve-common.ts";
import { DEFAULT_JEV_API_KEY_ENVS, resolveJevApiKeyEnv } from "../src/config/resolve.ts";

// The experiment's 20-candidate login page (`.scratch/jev/02_element_picking.ts`), re-encoded
// as `{role, name, context?}` structured candidates (index-aligned with the flat-string c1..c20).
const CANDIDATES: CandidatePacketEntry[] = [
  { index: 0, role: "banner", name: "Acme Corp", score: 0.1 },
  { index: 1, role: "link", name: "Home", score: 0.1, context: "nav" },
  { index: 2, role: "link", name: "Pricing", score: 0.1, context: "nav" },
  { index: 3, role: "link", name: "Docs", score: 0.1, context: "nav" },
  { index: 4, role: "link", name: "Contact", score: 0.1, context: "nav" },
  { index: 5, role: "heading", name: "Welcome back", score: 0.1 },
  {
    index: 6,
    role: "textbox",
    name: "Email",
    score: 0.1,
    context: "placeholder: name@example.com",
  },
  { index: 7, role: "textbox", name: "Password", score: 0.1, context: "type=password" },
  { index: 8, role: "checkbox", name: "Remember me", score: 0.1 },
  { index: 9, role: "link", name: "Forgot password?", score: 0.1 },
  { index: 10, role: "button", name: "Sign in", score: 0.1 },
  { index: 11, role: "text", name: "or continue with", score: 0.1 },
  { index: 12, role: "button", name: "Continue with Google", score: 0.1 },
  { index: 13, role: "button", name: "Continue with GitHub", score: 0.1 },
  { index: 14, role: "text", name: "Don't have an account?", score: 0.1 },
  { index: 15, role: "link", name: "Create account", score: 0.1 },
  { index: 16, role: "link", name: "Privacy Policy", score: 0.1, context: "footer" },
  { index: 17, role: "link", name: "Terms of Service", score: 0.1, context: "footer" },
  { index: 18, role: "link", name: "Help Center", score: 0.1, context: "footer" },
  { index: 19, role: "text", name: "© 2024 Acme Corp", score: 0.1 },
];

const EXPECTED: Record<string, number> = {
  "the sign in button": 10,
  "email input field": 6,
  "link to reset password": 9,
  "submit the form": 10,
};

async function main(): Promise<void> {
  const { value: apiKey } = resolveJevApiKeyEnv(undefined, process.env);
  if (!apiKey) {
    console.log(`skipped: neither ${DEFAULT_JEV_API_KEY_ENVS.join(" nor ")} is set`);
    return;
  }

  const budget = new BudgetTracker();
  const cost = new CostAccumulator();
  const rt = {
    budget,
    cost,
    aiWriter: { emitAiCall: () => {} },
    apiKey,
  };

  let correct = 0;
  let total = 0;

  console.log("JEV smoke — structured {role,name,context} encoding, 20 candidates");
  console.log("---------------------------------------------------------------");

  for (const [intent, expectedIndex] of Object.entries(EXPECTED)) {
    total += 1;
    const body = buildSystemOneRequest(intent, "click", CANDIDATES, undefined);
    const t0 = performance.now();
    const { response } = await jevCall(rt, `smoke:${intent}`, body);
    const ms = performance.now() - t0;
    const answer = response.answers.pick;
    const gotIndex = /^c(\d+)$/.exec(answer.choice)?.[1];
    const ok = gotIndex !== undefined && Number(gotIndex) === expectedIndex;
    if (ok) correct += 1;
    console.log(
      `intent=${JSON.stringify(intent)} → choice=${answer.choice} confidence=${answer.confidence} ` +
        `expected=c${expectedIndex} ${ok ? "OK" : "MISMATCH"} (${ms.toFixed(0)}ms, model=${response.model})`,
    );
  }

  // One abstain case: an intent with no matching candidate.
  total += 1;
  const abstainBody = buildSystemOneRequest(
    "the shopping cart icon",
    "click",
    CANDIDATES,
    undefined,
  );
  const t0 = performance.now();
  const { response: abstainResponse } = await jevCall(rt, "smoke:abstain", abstainBody);
  const ms = performance.now() - t0;
  const abstainAnswer = abstainResponse.answers.pick;
  const abstainOk = abstainAnswer.choice === JEV_NONE_KEY;
  if (abstainOk) correct += 1;
  console.log(
    `intent="the shopping cart icon" → choice=${abstainAnswer.choice} confidence=${abstainAnswer.confidence} ` +
      `expected=${JEV_NONE_KEY} ${abstainOk ? "OK" : "MISMATCH"} (${ms.toFixed(0)}ms, model=${abstainResponse.model})`,
  );

  console.log("---------------------------------------------------------------");
  console.log(`${correct}/${total} correct (acceptance: 4/4 picks + clean abstain = 5/5)`);
  console.log(`model calls: ${budget.modelCalls}`);

  if (correct !== total) {
    console.log(
      "MISS: the structured encoding did not match the flat-string baseline — consider " +
        'flipping JEV_OPTION_ENCODING to "flat" (src/ai/chooser-jev.ts) and re-running.',
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("jev-smoke failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
