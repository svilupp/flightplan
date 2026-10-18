import { resolveBudgetLimits } from "../ai/budget.ts";
import { compileJevProfile } from "../ai/jev-profile.ts";
import { resolveConfigWithDefaults, resolveJevApiKeyEnv } from "../config/resolve.ts";
import type { Config } from "../config/types.ts";
import { loadFlowFile } from "../flow/index.ts";
import { resolve } from "../paths.ts";
import { type CommandIO, EXIT } from "./commands.ts";

/** Deliberately allowlisted: config may hold auth cookies, prompts and headers. */
export async function executeConfig(path: string, io: CommandIO): Promise<number> {
  try {
    const loaded = await loadFlowFile(resolve(io.cwd, path), io.fs);
    const layers: Config[] = [loaded.flow.config ?? {}];
    if (loaded.flow.run) layers.push({ run: loaded.flow.run });
    const config = resolveConfigWithDefaults(layers);
    const policy = compileJevProfile(config);
    const limits = resolveBudgetLimits(config);
    const key = resolveJevApiKeyEnv(config.ai?.jev_api_key_env, io.env);
    io.stdout(
      JSON.stringify(
        {
          version: 1,
          classifier: config.ai?.classifier,
          jev: policy
            ? {
                ...policy,
                provenance: Object.fromEntries(
                  Object.entries(policy.provenance).map(([field, source]) => [
                    field,
                    source === "configured" ? `flow.config.ai.jev.${field}` : source,
                  ]),
                ),
              }
            : null,
          credentials: { jev: { env: key.envName, available: Boolean(key.value) } },
          ceilings: {
            model_calls: limits.max_model_calls ?? null,
            screenshots: limits.max_screenshots ?? null,
            cost_usd: limits.max_cost_usd ?? null,
          },
          provenance: {
            ai: loaded.flow.config?.ai ? "flow.config.ai" : "defaults",
            run: loaded.flow.run
              ? "flow.run"
              : loaded.flow.config?.run
                ? "flow.config.run"
                : "defaults",
          },
          runtime_requirements:
            policy?.images === "allow"
              ? ["verified_safe_capture", "current_geometry", "jev_key"]
              : policy
                ? ["jev_key"]
                : [],
          schema: "docs/schemas/config.schema.json",
        },
        null,
        2,
      ),
    );
    return EXIT.ok;
  } catch {
    io.stderr(
      "flightplan config: invalid flow or policy; run flightplan lint <flow> --json for diagnostics",
    );
    return EXIT.usage;
  }
}
