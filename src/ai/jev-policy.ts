import type { JevChoiceAnswer, JevNoulAnswer } from "./typesafe.ts";

/** Experimental starting gates, not fixture-calibrated accuracy claims. */
export const JEV_POLICY_VERSION = "jev-policy-v1";
export const JEV_PROFILE_MODEL = "jev-1.14.0";
export const JEV_STEP_DEADLINE_MS = 8_000;
export const JEV_CONTEXT_TOKEN_LIMIT = 64_000;
export const JEV_RESPONSE_ROUNDING_TOLERANCE = 0.01;
export function gateJevChoice(answer: JevChoiceAnswer): boolean {
  const sorted = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
  const first = sorted[0];
  return (
    answer.choice !== "none_of_the_above" &&
    first?.[0] === answer.choice &&
    answer.confidence !== null &&
    answer.confidence >= 0.6 &&
    first[1] >= 0.6 &&
    first[1] - (sorted[1]?.[1] ?? 0) >= 0.2
  );
}
export function gateJevPresence(answer: JevNoulAnswer): boolean {
  return answer.noul >= 0.99;
}
