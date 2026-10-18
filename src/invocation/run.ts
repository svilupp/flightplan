import type { Driver } from "../driver/types.ts";
import { resolveImports } from "../flow/imports.ts";
import { inputMetadata } from "../flow/input.ts";
import { loadFlowFileFlattened } from "../flow/run.ts";
import { applyTemplatingDeep } from "../flow/template.ts";
import { defaultFileSystem } from "../fs-default.ts";
import { gatherSecretValues } from "../redaction/index.ts";
import type { DriverFactory, RunOptions, RunResult } from "../runner/types.ts";
import { ambientEnv, sha256Text } from "../runtime.ts";
import { InvocationError } from "./index.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
function containsSecret(value: unknown, secrets: Set<string>): boolean {
  if (typeof value === "string") return [...secrets].some((secret) => value.includes(secret));
  if (Array.isArray(value)) return value.some((child) => containsSecret(child, secrets));
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).some((child) => containsSecret(child, secrets))
  );
}
function secretReference(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    "from_env" in value &&
    typeof value.from_env === "string"
  )
    return { from_env: value.from_env };
  if (typeof value === "string" && /^\$\{\s*env\.[A-Za-z_][A-Za-z_0-9]*\s*\}$/.test(value))
    return value;
  return "<secret-input>";
}
export const INVOCATION_MUTATORS = new Set([
  "click",
  "fill",
  "type",
  "select",
  "check",
  "hover",
  "submit",
  "clearBrowserState",
  "batch",
  "goto",
  "press",
  "emitCommand",
  "webmcpCall",
  "evalInFrame",
  "evaluateExpression",
  "switchToFrame",
  "switchToMain",
  "applyAuth",
  "restoreAuthState",
  "clearOriginState",
]);
/** Claim admission before browser acquisition; any interrupted claim remains non-replayable. */
export async function runWithInvocation(
  opts: RunOptions,
  execute: (options: RunOptions) => Promise<RunResult>,
  factory: DriverFactory,
): Promise<RunResult> {
  const store = opts.invocationStore;
  const key = opts.idempotencyKey;
  if (!store || !key?.trim()) throw new InvocationError("INVOCATION_STORE_REQUIRED");
  const fs = opts.fs ?? (await defaultFileSystem());
  const env = opts.env ?? ambientEnv();
  const loaded = await loadFlowFileFlattened(opts.flowPath, {
    fs,
    env,
    inputs: opts.inputs,
    ...(opts.flowSource !== undefined ? { flowSource: opts.flowSource } : {}),
  });
  const graph = await resolveImports(loaded, { fs, env, inputs: opts.inputs });
  const effectiveInputs = [...graph.nodes.values()]
    .map((node): [string, Record<string, unknown>] => {
      const secrets = gatherSecretValues(
        applyTemplatingDeep(node.loaded.flow.steps, {
          inputs: node.inputs,
          env,
          deferCaptures: true,
        }),
        node.inputs,
      );
      return [
        node.loaded.flow.id,
        Object.fromEntries(
          Object.entries(node.inputs).map(([name, value]) => {
            const declaration = node.loaded.flow.inputs?.[name];
            const secret =
              (declaration !== undefined && inputMetadata(declaration).secret) ||
              containsSecret(value, secrets);
            return [
              name,
              secret
                ? {
                    secret_reference: secretReference(
                      node.path === loaded.path
                        ? (opts.inputs?.[name] ??
                            (typeof declaration === "string" ? declaration : declaration?.default))
                        : typeof declaration === "string"
                          ? declaration
                          : declaration?.default,
                    ),
                  }
                : value,
            ];
          }),
        ),
      ];
    })
    .sort(([a], [b]) => a.localeCompare(b));
  const binding = sha256Text(
    JSON.stringify(
      canonical({
        recipe: loaded.flow.id,
        sources: [...graph.nodes.values()]
          .map((node) => [node.loaded.flow.id, node.loaded.sourceHash] as const)
          .sort(
            ([idA, hashA], [idB, hashB]) => idA.localeCompare(idB) || hashA.localeCompare(hashB),
          ),
        inputs: effectiveInputs,
        slice: [opts.fromStep, opts.toStep],
        connect:
          opts.config.connect?.mode === "attach"
            ? {
                ...opts.config.connect,
                wsUrl: opts.config.connect.wsUrl ? "<endpoint>" : undefined,
                browserURL: opts.config.connect.browserURL ? "<endpoint>" : undefined,
              }
            : opts.config.connect,
      }),
    ),
  );
  const scopedKey = `${opts.invocationNamespace ?? opts.cwd ?? "default"}\u0000${loaded.flow.id}\u0000${key}`;
  const claim = await store.claim(scopedKey, binding);
  if (claim.status === "completed") return structuredClone(claim.result);
  if (claim.status !== "claimed")
    throw new InvocationError(`INVOCATION_${claim.status.toUpperCase()}`);
  try {
    // Execute the exact source graph admitted by this claim even if files change afterwards.
    const sources = new Map(
      [...graph.nodes.values()].map((node) => [node.path, node.loaded.sourceText]),
    );
    const options = {
      ...opts,
      fs: new Proxy(fs, {
        get(target, property) {
          if (property === "readTextFile")
            return async (path: string) => sources.get(path) ?? target.readTextFile(path);
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    delete options.idempotencyKey;
    delete options.invocationStore;
    if (opts.yieldHost) {
      const host = opts.yieldHost;
      options.yieldHost = new Proxy(host, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property);
          if (property === "perform")
            return async (...args: Parameters<typeof host.perform>) => {
              await store.dispatchPending(scopedKey, claim.token);
              return host.perform(...args);
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    options.driverFactory = (config, context) => {
      const driver = factory(config, context);
      return new Proxy(driver, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property);
          if (typeof value !== "function") return value;
          if (!INVOCATION_MUTATORS.has(String(property))) return value.bind(target);
          return async (...args: unknown[]) => {
            await store.dispatchPending(scopedKey, claim.token);
            return Reflect.apply(value, target, args);
          };
        },
      }) as Driver;
    };
    const result = await execute(options);
    result.summary.idempotency_key = key;
    // Keep summary.json and --json consistent after adding invocation metadata.
    await fs.writeTextFile(
      `${result.runDir}/summary.json`,
      JSON.stringify(result.summary, null, 2),
    );
    await store.finish(scopedKey, claim.token, result);
    return result;
  } catch (error) {
    if (error && typeof error === "object" && "runResult" in error) {
      const preserved = error.runResult as RunResult;
      if (preserved?.summary) {
        preserved.summary.idempotency_key = key;
        await fs
          .writeTextFile(
            `${preserved.runDir}/summary.json`,
            JSON.stringify(preserved.summary, null, 2),
          )
          .catch(() => {});
      }
    }
    await store.fail(scopedKey, claim.token).catch(() => {});
    throw error;
  }
}
