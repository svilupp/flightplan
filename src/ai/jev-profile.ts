import type { Config } from "../config/types.ts";

/** Offline, deterministic expansion. No credentials or browser calls. */
export function compileJevProfile(config: Pick<Config, "ai" | "run" | "timeouts">) {
  const input = config.ai?.jev;
  if (!input) return undefined;
  const classifier = config.ai?.classifier ?? "auto";
  if (input.profile !== "shadow" && classifier !== "auto" && classifier !== "jev") {
    throw new Error("jev_classifier_incompatible: active profiles require auto or jev");
  }
  if (input.profile === "visual" && input.images !== "allow") {
    throw new Error("jev_images_denied: visual requires images=allow");
  }
  return {
    version: 1,
    policyVersion: "jev-v1-experimental",
    profile: input.profile,
    model: input.model ?? "jev-1.14.0",
    images: input.images ?? "deny",
    stages:
      input.profile === "visual"
        ? ["text_choice", "image_choice"]
        : input.profile === "text"
          ? ["text_choice", "text_verify"]
          : ["text_choice"],
    conditionalStages:
      input.profile === "text"
        ? [
            {
              strategy: "text_verify",
              requires: "fresh distinct scoped attributes omitted from first packet",
            },
          ]
        : [],
    maxCallsPerStep: input.max_calls_per_step ?? (input.profile === "shadow" ? 1 : 2),
    maxRequestsPerRun: input.max_requests_per_run ?? 16,
    timeoutMs: config.timeouts?.ai_call_ms ?? 3000,
    deadlineMs: 8000,
    capabilities: {
      textChoice: true,
      visualChoice: input.profile === "visual",
      predicate: true,
      boxAction: false,
      recoveryActions: false,
    },
    // Runtime cannot fabricate the layer origin; the CLI can join these field defaults to its loaded layers.
    provenance: Object.fromEntries(
      ["profile", "model", "images", "max_calls_per_step", "max_requests_per_run"].map((key) => [
        key,
        key in input ? "configured" : "profile_default",
      ]),
    ),
  } as const;
}
export type CompiledJevProfile = NonNullable<ReturnType<typeof compileJevProfile>>;
