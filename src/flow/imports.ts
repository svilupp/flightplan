// Flightplan — import resolution + composition.
//
// `resolveImports(flow, baseDir)` resolves a flow's `imports` (string | string[] |
// [[imports]] tables), loads each referenced module recursively, detects cycles (open
// question #8 — decided: a cycle is a hard error), threads the `with` clause through as
// input overrides, and returns the import graph. Setup/teardown are referenced flows and
// are included in the graph (PROPOSAL "Setup and teardown are referenced flows").
//
// This module performs STRUCTURAL resolution + cycle detection. It does NOT compose locks
// (that is lock/, Phase 3) nor execute templating on step bodies (the runner does that with
// the resolved inputs). It DOES resolve each node's effective inputs via the `with` clause
// so a downstream consumer has the per-module input scope.
//
// Canonical reference: PLAN.md §5 (Phase 1, "import resolution") and PROPOSAL "Composition
// and reuse".

import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { loadFlowFile, type LoadedFlow } from "./load.ts";
import { resolveInputs } from "./template.ts";
import type { FlowFile, ImportTable } from "./types.ts";

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

/** How a module entered the graph. */
export type ImportRelation = "import" | "setup" | "teardown";

/** A single resolved node in the import graph. */
export interface ImportNode {
  /** Absolute resolved path to this module's flow file. */
  path: string;
  /** The loaded + validated flow at `path`. */
  loaded: LoadedFlow;
  /** How this node was referenced from its parent (or 'import' for the root's children). */
  relation: ImportRelation;
  /** Raw `with` overrides declared at the reference site (before templating). */
  with?: Record<string, string>;
  /** This module's effective inputs after applying `with` + templating declarations. */
  inputs: Record<string, string>;
  /** Absolute paths of this node's direct children (imports + setup + teardown). */
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

/** A reference extracted from a flow's imports/setup/teardown, before loading. */
interface PendingRef {
  modulePath: string; // raw, as written in the file
  relation: ImportRelation;
  with?: Record<string, string>;
}

/**
 * Normalize a flow's `imports` field (string | string[] | ImportTable[]) plus its
 * setup/teardown into a flat list of references. Pure.
 */
export function extractRefs(flow: FlowFile): PendingRef[] {
  const refs: PendingRef[] = [];
  const imports = flow.imports;

  if (typeof imports === "string") {
    refs.push({ modulePath: imports, relation: "import" });
  } else if (Array.isArray(imports)) {
    for (const entry of imports) {
      if (typeof entry === "string") {
        refs.push({ modulePath: entry, relation: "import" });
      } else {
        // ImportTable form: { module, with? }
        const table = entry as ImportTable;
        refs.push({ modulePath: table.module, relation: "import", with: table.with });
      }
    }
  }

  if (flow.setup) refs.push({ modulePath: flow.setup, relation: "setup" });
  if (flow.teardown) refs.push({ modulePath: flow.teardown, relation: "teardown" });

  return refs;
}

/** Resolve a module reference (possibly relative) against the importing file's directory. */
function resolveModulePath(modulePath: string, importerPath: string): string {
  if (isAbsolute(modulePath)) return modulePath;
  return resolvePath(dirname(importerPath), modulePath);
}

/**
 * Resolve a flow's import graph starting from an already-loaded root flow. Loads every
 * referenced module recursively, detects cycles, threads `with` overrides into each node's
 * resolved inputs, and returns the graph in leaf-first composition order.
 *
 * `env` (optional) is the environment used to resolve `${env.*}` in `with` clauses and in
 * each module's input declarations; defaults to `process.env`.
 */
export async function resolveImports(
  root: LoadedFlow,
  opts?: { env?: Record<string, string | undefined> },
): Promise<ImportGraph> {
  const env = opts?.env ?? (process.env as Record<string, string | undefined>);
  const nodes = new Map<string, ImportNode>();
  const order: string[] = [];

  // DFS with an explicit on-stack set for cycle detection. `stack` is the current path chain.
  const onStack = new Set<string>();
  const stack: string[] = [];

  async function visit(
    loaded: LoadedFlow,
    relation: ImportRelation,
    withOverrides: Record<string, string> | undefined,
    parentInputs: Record<string, string>,
  ): Promise<void> {
    const path = loaded.path;

    if (onStack.has(path)) {
      throw new ImportCycleError([...stack, path]);
    }
    // Already fully resolved on another branch → skip re-loading (DAG, not a tree). We keep
    // the first-seen node; differing `with` for the same module on different branches is a
    // composition concern handled later (lock/), not a structural error here.
    if (nodes.has(path)) return;

    onStack.add(path);
    stack.push(path);

    const inputs = resolveInputs(loaded.flow.inputs, withOverrides, env, parentInputs);
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
      await visit(childLoaded, ref.relation, ref.with, inputs);
    }

    onStack.delete(path);
    stack.pop();

    // Post-order: children are appended before the parent → leaf-first composition order.
    nodes.set(path, {
      path,
      loaded,
      relation,
      with: withOverrides,
      inputs,
      children,
    });
    order.push(path);
  }

  // The root has no `with` overrides and no parent inputs.
  await visit(root, "import", undefined, {});

  return { rootPath: root.path, nodes, order };
}
