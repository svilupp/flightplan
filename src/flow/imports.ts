// Flightplan — import resolution + composition.
//
// `resolveImports(root, opts)` resolves a flow's `imports` (string | string[]), its
// setup/teardown hooks, AND every path-form `run` step reference (PLAN_v002 v002-6: a `run`
// step's `flow` joins the same import DAG), loads each referenced module recursively, detects
// cycles (a cycle is a hard error), and returns the import graph. Imports are a LIBRARY
// (v002-5): they register modules (flow ids + locks) and never execute; execution is a `run`
// step or a setup/teardown hook.
//
// This module performs STRUCTURAL resolution + cycle detection. It does NOT compose locks
// (that is lock/, Phase 3), does not flatten `run` steps (see ./run.ts), and does not
// execute templating on step bodies. It DOES resolve each node's declared inputs against env
// so a downstream consumer has the per-module input scope (a `run` site's `with` overrides
// are applied at flatten time, not here — nothing executes at import time).
//
// Config note: imports contribute steps/hooks only — an imported flow's [config] / [connect]
// blocks are intentionally ignored. The ENTRY flow's connect config (or the default: attach to
// localhost:9222) is authoritative for the whole run (see src/cli/index.ts config layering).
//
// Canonical reference: PLAN.md §5 (Phase 1, "import resolution"), PLAN_v002 §3.

import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { type LoadedFlow, loadFlowFile } from "./load.ts";
import { resolveInputs } from "./template.ts";
import type { FlowFile } from "./types.ts";

/** Raised when an import cycle is detected. Carries the offending path chain. */
export class ImportCycleError extends Error {
  constructor(readonly chain: string[]) {
    super(`Import cycle detected: ${chain.join(" -> ")}`);
    this.name = "ImportCycleError";
  }
}

/** Raised when an imports declaration is malformed in a way zod could not catch alone. */
export class ImportResolutionError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ImportResolutionError";
  }
}

/** How a module entered the graph. `run` = referenced by path from a `run` step. */
export type ImportRelation = "import" | "setup" | "teardown" | "run";

/**
 * Classify a `run` step's `flow` reference (v002-6): it is a PATH iff it contains a `/` or
 * ends with `.toml`; everything else is an imported flow id looked up in the file's import
 * scope. Pure — shared by the loader flattening (./run.ts) and the linter.
 */
export function isRunFlowPath(ref: string): boolean {
  return ref.includes("/") || ref.endsWith(".toml");
}

/** A single resolved node in the import graph. */
export interface ImportNode {
  /** Absolute resolved path to this module's flow file. */
  path: string;
  /** The loaded + validated flow at `path`. */
  loaded: LoadedFlow;
  /** How this node was referenced from its parent (or 'import' for the root's children). */
  relation: ImportRelation;
  /** This module's declared inputs resolved against env (no per-site `with` — that is `run`). */
  inputs: Record<string, string>;
  /** Absolute paths of this node's direct children (imports + setup/teardown + run paths). */
  children: string[];
}

/** The resolved import graph for a root flow. */
export interface ImportGraph {
  /** Absolute path of the root flow. */
  rootPath: string;
  /** Every node keyed by absolute path (includes the root). */
  nodes: Map<string, ImportNode>;
  /**
   * Modules in dependency order (leaves first, root last) — the order locks should be
   * composed in (a parent's config/lock layers on top of its imports'). PLAN.md §5.
   */
  order: string[];
}

/** A reference extracted from a flow's imports/setup/teardown/run steps, before loading. */
interface PendingRef {
  modulePath: string; // raw, as written in the file
  relation: ImportRelation;
}

/**
 * Normalize a flow's `imports` field (string | string[]) plus its setup/teardown and every
 * PATH-FORM `run` step reference into a flat list of references. Id-form `run.flow` values
 * resolve against modules already registered via `imports` and add no new edges. Pure.
 */
export function extractRefs(flow: FlowFile): PendingRef[] {
  const refs: PendingRef[] = [];
  const imports = flow.imports;

  if (typeof imports === "string") {
    refs.push({ modulePath: imports, relation: "import" });
  } else if (Array.isArray(imports)) {
    for (const entry of imports) {
      refs.push({ modulePath: entry, relation: "import" });
    }
  }

  if (flow.setup) refs.push({ modulePath: flow.setup, relation: "setup" });
  if (flow.teardown) refs.push({ modulePath: flow.teardown, relation: "teardown" });

  // Path-form `run` references join the import DAG (v002-6) so `imports/no-cycle` covers them.
  const seen = new Set(refs.map((r) => r.modulePath));
  for (const step of flow.steps) {
    if (step.do !== "run") continue;
    if (!isRunFlowPath(step.flow)) continue;
    if (seen.has(step.flow)) continue;
    seen.add(step.flow);
    refs.push({ modulePath: step.flow, relation: "run" });
  }

  return refs;
}

/** Resolve a module reference (possibly relative) against the importing file's directory. */
export function resolveModulePath(modulePath: string, importerPath: string): string {
  if (isAbsolute(modulePath)) return modulePath;
  return resolvePath(dirname(importerPath), modulePath);
}

/**
 * Resolve a flow's import graph starting from an already-loaded root flow. Loads every
 * referenced module recursively (imports + setup/teardown + path-form `run` references),
 * detects cycles, and returns the graph in leaf-first composition order.
 *
 * `env` (optional) is the environment used to resolve `${env.*}` in each module's input
 * declarations; defaults to `process.env`.
 */
export async function resolveImports(
  root: LoadedFlow,
  opts?: { env?: Record<string, string | undefined> },
): Promise<ImportGraph> {
  const env = opts?.env ?? process.env;
  const nodes = new Map<string, ImportNode>();
  const order: string[] = [];

  // DFS with an explicit on-stack set for cycle detection. `stack` is the current path chain.
  const onStack = new Set<string>();
  const stack: string[] = [];

  async function visit(loaded: LoadedFlow, relation: ImportRelation): Promise<void> {
    const path = loaded.path;

    if (onStack.has(path)) {
      throw new ImportCycleError([...stack, path]);
    }
    // Already fully resolved on another branch → skip re-loading (DAG, not a tree). We keep
    // the first-seen node; per-site `with` overrides are a flatten-time concern (./run.ts).
    if (nodes.has(path)) return;

    onStack.add(path);
    stack.push(path);

    const inputs = resolveInputs(loaded.flow.inputs, undefined, env, {});
    const refs = extractRefs(loaded.flow);
    const children: string[] = [];

    for (const ref of refs) {
      const childPath = resolveModulePath(ref.modulePath, path);
      children.push(childPath);
      let childLoaded: LoadedFlow;
      try {
        childLoaded = await loadFlowFile(childPath);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new ImportResolutionError(
          `Failed to load imported module \`${ref.modulePath}\` (resolved to ${childPath}) ` +
            `from ${path}: ${detail}`,
          path,
        );
      }
      await visit(childLoaded, ref.relation);
    }

    onStack.delete(path);
    stack.pop();

    // Post-order: children are appended before the parent → leaf-first composition order.
    nodes.set(path, {
      path,
      loaded,
      relation,
      inputs,
      children,
    });
    order.push(path);
  }

  // The root enters as its own 'import'-relation node.
  await visit(root, "import");

  return { rootPath: root.path, nodes, order };
}
