import {
  type ExecutionPolicy,
  type ExecutionPolicyIssue,
  executionPolicyIssues,
  resolveExecutionPolicy,
} from "../config/execution-policy.ts";
import { validateBoundSteps } from "../flow/bound.ts";
import { type ImportGraph, resolveModulePath } from "../flow/imports.ts";
import { gatherInputSecrets, type InputValues } from "../flow/input.ts";
import type { LoadedFlow } from "../flow/load.ts";
import { type BoundFlowScope, loadFlowComposition } from "../flow/run.ts";
import { captureSourceFiles } from "../flow/source-files.ts";
import {
  applyTemplatingDeep,
  resolveInputs,
  restoreInputLiterals,
  type TemplateContext,
} from "../flow/template.ts";
import type { FlowFile, Step } from "../flow/types.ts";
import { gatherSecretValues } from "../redaction/index.ts";
import type { FileSystemPort } from "../runtime.ts";
import type { RunOptions } from "./types.ts";

/** Bind step inputs while retaining capture references for execution-time resolution. */
export function templateFlow(
  flow: FlowFile,
  inputs: InputValues,
  env: Record<string, string | undefined>,
): { steps: Step[]; inputs: InputValues } {
  const ctx: TemplateContext = { inputs, env, deferCaptures: true };
  // Template the step list (deep — covers urls, values, hints, assertion text/selectors).
  const steps = validateBoundSteps(flow.steps.map((s) => applyTemplatingDeep(s, ctx)));
  return { steps, inputs };
}

/** Fully bound entry steps and policy diagnostics, paired with their prepared source files. */
export interface PreparedRun {
  readonly loaded: LoadedFlow;
  readonly graph: ImportGraph;
  readonly inputs: InputValues;
  readonly steps: Step[];
  readonly hookSteps: readonly Step[];
  readonly policy: ExecutionPolicy;
  readonly policyIssues: ExecutionPolicyIssue[];
  readonly sourceTexts: ReadonlyMap<string, string>;
  readonly scopes: readonly BoundFlowScope[];
  readonly secrets: ReadonlySet<string>;
}

/** Bind the complete run before acquisition; sweep uses the same preparation as runFlow. */
export async function prepareRun(
  opts: Pick<
    RunOptions,
    "flowPath" | "flowSource" | "flowSources" | "inputs" | "config" | "startTier"
  >,
  fs: FileSystemPort,
  env: Record<string, string | undefined>,
): Promise<PreparedRun> {
  const { fs: sourceFs, sources: sourceTexts } = captureSourceFiles(
    fs,
    new Map([
      ...(opts.flowSources ?? []),
      ...(opts.flowSource === undefined ? [] : [[opts.flowPath, opts.flowSource] as const]),
    ]),
  );
  const composition = await loadFlowComposition(opts.flowPath, {
    env,
    fs: sourceFs,
    ...(opts.flowSource !== undefined ? { flowSource: opts.flowSource } : {}),
    ...(opts.inputs !== undefined ? { inputs: opts.inputs } : {}),
  });
  const { loaded, graph } = composition;
  const scopes = [...composition.scopes];
  const rootNode = graph.nodes.get(graph.rootPath);
  const inputs = rootNode?.inputs ?? resolveInputs(loaded.flow.inputs, undefined, env, {});
  const { steps: allSteps } = templateFlow(loaded.flow, inputs, env);
  const policy = resolveExecutionPolicy(opts.config);
  const preparedHookSteps: Step[] = [];
  // Known hook bindings must fail before any root setup/action or browser acquisition.
  for (const hook of [loaded.flow.setup, loaded.flow.teardown]) {
    if (!hook) continue;
    const hookComposition = await loadFlowComposition(resolveModulePath(hook, loaded.path), {
      env,
      fs: sourceFs,
    });
    const hookFlow = hookComposition.loaded;
    scopes.push(...hookComposition.scopes);
    preparedHookSteps.push(
      ...templateFlow(hookFlow.flow, resolveInputs(hookFlow.flow.inputs, undefined, env, {}), env)
        .steps,
    );
  }
  // Preserve each call site's effective secret inputs before flattening erases declarations.
  // Hooks and their callable children share the same redactor as the entry flow.
  const secrets = new Set<string>();
  const secretSteps = restoreInputLiterals([...allSteps, ...preparedHookSteps]);
  for (const scope of scopes) {
    for (const secret of [
      ...gatherInputSecrets(scope.loaded.flow.inputs, scope.inputs),
      ...gatherSecretValues(secretSteps, scope.inputs),
    ])
      secrets.add(secret);
  }
  const policyIssues = executionPolicyIssues(
    policy,
    opts.config,
    [...allSteps, ...preparedHookSteps],
    {
      startTier: opts.startTier,
      assertions: [...(loaded.flow.before ?? []), ...(loaded.flow.after ?? [])],
    },
  );
  return {
    loaded,
    graph,
    inputs,
    steps: allSteps,
    hookSteps: preparedHookSteps,
    policy,
    policyIssues,
    sourceTexts,
    scopes,
    secrets,
  };
}
