import type { Assertion, Step } from "../flow/types.ts";
import type { Config } from "./types.ts";

/** Permission for Flightplan's built-in AI paths, distinct from budgets and local recording. */
export interface ExecutionPolicy {
  readonly ai: "enabled" | "disabled";
  readonly remoteGuard: boolean;
  readonly recording: boolean;
}

/** Derive explicit permission without consulting credentials or constructing a runtime. */
export function resolveExecutionPolicy(config: Config): ExecutionPolicy {
  return {
    ai: config.ai?.enabled === true ? "enabled" : "disabled",
    remoteGuard: config.guard !== undefined,
    recording: config.browser?.record === true,
  };
}

/** An authored AI requirement that conflicts with the entry flow's permission. */
export interface ExecutionPolicyIssue {
  readonly code: "AI_DISABLED" | "PLAN_UNSAFE_EFFECT";
  readonly feature: string;
  readonly stepId?: string;
  readonly message: string;
}

/** Pure preflight. Opportunistic resolution and cached extraction are checked at their call sites. */
export function executionPolicyIssues(
  policy: ExecutionPolicy,
  config: Config,
  steps: readonly Step[],
  options: { assertions?: readonly Assertion[]; startTier?: "L0" | "L3" } = {},
): ExecutionPolicyIssue[] {
  if (policy.ai === "enabled") {
    const protectedStep = config.plan?.enabled
      ? steps.find((step) => step.effect === "at_most_once")
      : undefined;
    return protectedStep
      ? [
          {
            code: "PLAN_UNSAFE_EFFECT",
            feature: "config.plan.enabled",
            stepId: protectedStep.id,
            message:
              "Planner auto-repair cannot run flows or hooks containing at_most_once steps. " +
              "Disable [config.plan] enabled for this flow.",
          },
        ]
      : [];
  }
  const issues: ExecutionPolicyIssue[] = [];
  const requireAi = (feature: string, stepId?: string): void => {
    issues.push({
      code: "AI_DISABLED",
      feature,
      ...(stepId !== undefined ? { stepId } : {}),
      message: `${feature} requires [config.ai] enabled = true. AI is disabled by default.`,
    });
  };
  if (config.plan?.enabled) requireAi("config.plan.enabled");
  if (config.ai?.classifier && config.ai.classifier !== "auto") requireAi("config.ai.classifier");
  if (config.ai?.jev) requireAi("config.ai.jev");
  if (policy.remoteGuard) requireAi("config.guard (remote model evaluation)");
  if (options.startTier === "L3") requireAi("start tier L3");
  for (const assertion of options.assertions ?? []) {
    if (assertion.type === "ai_judge") requireAi("ai_judge assertion");
  }
  for (const step of steps) {
    if ("resolve" in step && step.resolve === "ai") requireAi("resolve = ai", step.id);
    if ("tier_hint" in step && step.tier_hint === "vision")
      requireAi("tier_hint = vision", step.id);
    if (step.assert?.some((assertion) => assertion.type === "ai_judge"))
      requireAi("ai_judge assertion", step.id);
  }
  return issues;
}

/** Translation to the runner/CLI's existing configuration-error boundary. */
export class ExecutionPolicyError extends Error {
  readonly code: ExecutionPolicyIssue["code"];
  constructor(readonly issues: readonly ExecutionPolicyIssue[]) {
    super(issues.map((issue) => issue.message).join(" "));
    this.name = "ExecutionPolicyError";
    this.code = issues[0]?.code ?? "AI_DISABLED";
  }
}
