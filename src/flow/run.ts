// Flightplan — `run` step flattening (load-time composition, PLAN_v002 §3, v002-5..v002-9).
//
// A `do = "run"` step executes another flow at its position. v0.x has no conditionals, so the
// expansion is fully determined at load time (v002-8): a `run` step flattens into the child's
// concrete steps, namespaced by the CALL-SITE step id (`<call-site-id>:<child-step-id>`), and
// the linter/runner only ever see the final flattened list — no new runtime machinery.
//
// This differs from `for_each` (src/flow/normalize.ts) in one important way: `for_each` is a
// SYNCHRONOUS raw-doc macro (no I/O, runs before zod), while `run` must load OTHER FILES from
// disk. Flattening therefore runs as a separate ASYNC pass AFTER `parseFlowFile` has produced
// a validated flow: `loadFlowFileFlattened` = loadFlowFile → resolveImports (cycle check over
// the combined import+run DAG) → recursive, depth-first step splice.
//
// INPUTS DESIGN DECISION (v002-8): a `run` site's `with` overrides the child's declared
// [inputs], templated against the PARENT's scope (env + parent inputs). Because inputs are
// static at load time, we PRE-TEMPLATE the child's `${inputs.*}` references against its
// effective inputs HERE, at flatten time, and leave `${env.*}` untouched for the runner's
// normal templating pass — exactly mirroring how `for_each` pre-resolves `${item}`/`${loop.*}`
// at load time. No side-channel "namespaced inputs" field is threaded to the runner.
//
// Budgets are parent-governed (v002-8): only the child's STEPS are spliced in — its own
// [run] limits block, [config], imports, and setup/teardown hooks are ignored when embedded
// (a child's hooks/budgets apply only when it is run standalone).

import {
  ImportCycleError,
  type ImportGraph,
  isRunFlowPath,
  resolveImports,
  resolveModulePath,
} from "./imports.ts";
import { type LoadedFlow, loadFlowFile } from "./load.ts";
import { applyInputsTemplatingDeep, resolveInputs } from "./template.ts";
import type { RunStep, Step } from "./types.ts";

/** Raised when a `run` step's `flow` reference cannot be resolved to a module. */
export class RunResolutionError extends Error {
  constructor(
    message: string,
    /** Path of the file whose `run` step failed to resolve. */
    readonly path: string,
  ) {
    super(message);
    this.name = "RunResolutionError";
  }
}

export { ImportCycleError, isRunFlowPath };

/** Options for the flatten pass. */
export interface FlattenOptions {
  /** Environment for `with` / input templating; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * The transitive IMPORT closure of one file: every module registered (by flow id) in that
 * file's scope via `imports` — directly or through imported modules' own imports. Setup/
 * teardown hooks and path-form `run` references do NOT register ids (they are not a library).
 * Exported for the linter (`run/flow-in-scope`, `imports/unique-ids`, …).
 */
export function collectImportScope(
  loaded: LoadedFlow,
  graph: ImportGraph,
): Map<string, LoadedFlow[]> {
  const byId = new Map<string, LoadedFlow[]>();
  const seen = new Set<string>();

  function walk(file: LoadedFlow): void {
    const imports = file.flow.imports;
    const paths = typeof imports === "string" ? [imports] : Array.isArray(imports) ? imports : [];
    for (const raw of paths) {
      const abs = resolveModulePath(raw, file.path);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const node = graph.nodes.get(abs);
      if (!node) continue; // unresolved import — surfaced by resolveImports/lint, not here
      const id = node.loaded.flow.id;
      const list = byId.get(id) ?? [];
      list.push(node.loaded);
      byId.set(id, list);
      walk(node.loaded);
    }
  }

  walk(loaded);
  return byId;
}

/** Namespace one child step under a call-site id: id + its own on_fail.goto (v002-9). */
function namespaceStep(callSiteId: string, step: Step): Step {
  const out: Step = { ...step, id: `${callSiteId}:${step.id}` };
  if (step.on_fail && step.on_fail.goto !== "self") {
    // The child's goto targets resolve WITHIN the child (file-scoped, v002-9) — rewrite them
    // to the namespaced form so they still point at the embedded copy of that step.
    out.on_fail = { ...step.on_fail, goto: `${callSiteId}:${step.on_fail.goto}` };
  }
  return out;
}

/**
 * Flatten every `run` step in `loaded` into namespaced child steps (recursively — children
 * may themselves contain `run` steps). Resolves the combined import+run DAG first, so a
 * cycle through any mix of `imports` and path-form `run` references throws
 * {@link ImportCycleError} before any splicing happens; recursion below then terminates by
 * construction (the graph is a DAG, and id-form references can only reach imported modules).
 */
export async function flattenRunSteps(loaded: LoadedFlow, opts?: FlattenOptions): Promise<Step[]> {
  const env = opts?.env ?? process.env;
  // Combined import + run DAG: loads every referenced module and throws on a cycle (v002-6).
  const graph = await resolveImports(loaded, { env });
  const rootInputs = graph.nodes.get(loaded.path)?.inputs ?? {};
  return flattenFile(loaded, rootInputs, graph, env, /* preTemplateInputs */ false);
}

/**
 * Load a flow file and flatten its `run` steps — what the runner executes against. The
 * returned LoadedFlow keeps the original source text/hash (locks key by content) with
 * `flow.steps` replaced by the fully flattened list.
 */
export async function loadFlowFileFlattened(
  path: string,
  opts?: FlattenOptions,
): Promise<LoadedFlow> {
  const loaded = await loadFlowFile(path);
  const steps = await flattenRunSteps(loaded, opts);
  return { ...loaded, flow: { ...loaded.flow, steps } };
}

/** Resolve one `run` step's `flow` reference to the child module (path- or id-form). */
function resolveRunChild(step: RunStep, file: LoadedFlow, graph: ImportGraph): LoadedFlow {
  if (isRunFlowPath(step.flow)) {
    const abs = resolveModulePath(step.flow, file.path);
    const node = graph.nodes.get(abs);
    if (!node) {
      // resolveImports loads every path-form run ref, so this only happens on programmer error.
      throw new RunResolutionError(
        `Step \`${step.id}\`: run flow path \`${step.flow}\` (resolved to ${abs}) was not ` +
          `loaded into the import graph.`,
        file.path,
      );
    }
    return node.loaded;
  }
  // Id-form: look the id up among modules registered via `imports` in THIS file's scope.
  const scope = collectImportScope(file, graph);
  const matches = scope.get(step.flow);
  if (!matches || matches.length === 0) {
    const ids = [...scope.keys()].sort();
    throw new RunResolutionError(
      `Step \`${step.id}\`: run flow id \`${step.flow}\` is not in scope. Imported flow ids ` +
        `in scope: ${ids.length > 0 ? ids.join(", ") : "<none>"}. Add the module to \`imports\`, ` +
        `or reference it by path.`,
      file.path,
    );
  }
  if (matches.length > 1) {
    throw new RunResolutionError(
      `Step \`${step.id}\`: run flow id \`${step.flow}\` is ambiguous — declared by ` +
        `${matches.map((m) => m.path).join(" and ")}. Imported flow ids must be unique.`,
      file.path,
    );
  }
  return matches[0]!;
}

/**
 * Depth-first flatten of one file's steps. `effInputs` are the file's effective inputs (its
 * declared [inputs] after any call-site `with` overrides); when `preTemplateInputs` is true
 * (every embedded child) the emitted steps have their `${inputs.*}` resolved against
 * `effInputs` at flatten time (see header comment) — the root's steps are left for the
 * runner's normal templating pass.
 */
function flattenFile(
  file: LoadedFlow,
  effInputs: Record<string, string>,
  graph: ImportGraph,
  env: Record<string, string | undefined>,
  preTemplateInputs: boolean,
): Step[] {
  const out: Step[] = [];
  for (const step of file.flow.steps) {
    if (step.do !== "run") {
      out.push(preTemplateInputs ? applyInputsTemplatingDeep(step, effInputs) : step);
      continue;
    }

    const child = resolveRunChild(step, file, graph);
    // `with` overrides the child's declared [inputs], templated against the PARENT's scope
    // (env + the parent's effective inputs) — v002-8.
    const childInputs = resolveInputs(child.flow.inputs, step.with, env, effInputs);
    // Recurse first (children may contain their own `run` steps), pre-templating the child's
    // `${inputs.*}` against its effective inputs. The child's [run] budgets block, [config],
    // imports, and setup/teardown are intentionally NOT carried over (parent-governed, v002-8).
    const childSteps = flattenFile(child, childInputs, graph, env, true).map((s) =>
      namespaceStep(step.id, s),
    );
    // Call-site assertions ride on the last embedded step ("after the child completed").
    // Note the run step's own `on_fail`/`timeout_ms` are NOT carried over — control flow is
    // file-scoped (v002-9) and there is no single step for a whole-child timeout to attach to.
    if (step.assert && step.assert.length > 0 && childSteps.length > 0) {
      // Call-site assertions belong to the PARENT's scope — template them against the
      // parent's inputs (when this file is itself embedded), not the child's.
      const siteAssert = preTemplateInputs
        ? applyInputsTemplatingDeep(step.assert, effInputs)
        : step.assert;
      const last = childSteps[childSteps.length - 1]!;
      childSteps[childSteps.length - 1] = {
        ...last,
        assert: [...(last.assert ?? []), ...siteAssert],
      };
    }
    out.push(...childSteps);
  }
  return out;
}
