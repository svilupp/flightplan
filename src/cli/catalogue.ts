import { parseToml } from "../config/parse.ts";
import {
  extractRefs,
  type ImportGraph,
  isRunFlowPath,
  resolveModulePath,
} from "../flow/imports.ts";
import { inputMetadata } from "../flow/input.ts";
import { type LoadedFlow, loadFlowFile } from "../flow/load.ts";
import { collectImportScope } from "../flow/run.ts";
import { expandPaths } from "../lint/index.ts";
import type { CommandIO } from "./commands.ts";

export async function executeCatalogue(paths: string[], io: CommandIO, describe = false) {
  const recipes: unknown[] = [];
  const diagnostics: Array<{ code: string; file: string; message: string }> = [];
  const ids = new Map<string, string>();
  // Resolve structure only: input/env binding belongs to invocation, never discovery.
  const dependencies = async (root: LoadedFlow): Promise<LoadedFlow[]> => {
    const nodes = new Map<string, LoadedFlow>();
    const active = new Set<string>();
    const visit = async (node: LoadedFlow): Promise<void> => {
      if (active.has(node.path)) {
        diagnostics.push({
          code: "RECIPE_DEPENDENCY_CYCLE",
          file: node.path,
          message: "Recipe dependencies contain a cycle.",
        });
        return;
      }
      if (nodes.has(node.path)) return;
      nodes.set(node.path, node);
      active.add(node.path);
      for (const ref of extractRefs(node.flow)) {
        const path = resolveModulePath(ref.modulePath, node.path);
        try {
          await visit(await loadFlowFile(path, io.fs));
        } catch {
          diagnostics.push({
            code: "RECIPE_DEPENDENCY_INVALID",
            file: path,
            message: "Referenced recipe could not be read or validated.",
          });
        }
      }
      active.delete(node.path);
    };
    await visit(root);
    const graph: ImportGraph = {
      rootPath: root.path,
      order: [...nodes.keys()],
      nodes: new Map(
        [...nodes].map(([path, loaded]) => [
          path,
          { path, loaded, relation: "import", inputs: {}, children: [] },
        ]),
      ),
    };
    for (const node of nodes.values()) {
      const scope = collectImportScope(node, graph);
      for (const step of node.flow.steps) {
        if (step.do !== "run" || isRunFlowPath(step.flow)) continue;
        if (scope.get(step.flow)?.length !== 1)
          diagnostics.push({
            code: "RECIPE_DEPENDENCY_INVALID",
            file: node.path,
            message: "A referenced recipe ID is missing or ambiguous in its import scope.",
          });
      }
    }
    return [...nodes.values()];
  };
  for (const file of (await expandPaths(paths, { fs: io.fs, cwd: io.cwd })).sort()) {
    try {
      const raw = parseToml(await io.fs.readTextFile(file), file) as Record<string, unknown>;
      if (!describe && raw.kind !== "flow") continue;
      const loaded = await loadFlowFile(file, io.fs);
      const { flow } = loaded;
      const modules = await dependencies(loaded);
      const previous = ids.get(flow.id);
      if (previous)
        diagnostics.push({
          code: "RECIPE_ID_DUPLICATE",
          file,
          message: `Recipe ID also declared in ${previous}.`,
        });
      ids.set(flow.id, file);
      const inputs = Object.fromEntries(
        Object.entries(flow.inputs ?? {}).map(([name, value]) => {
          const meta = inputMetadata(value);
          return [name, meta.secret ? { ...meta, default: undefined } : meta];
        }),
      );
      const argv = ["flightplan", "run", file, "--session", "<session>"];
      const exampleInputs: Record<string, unknown> = {};
      for (const [name, declaration] of Object.entries(flow.inputs ?? {})) {
        const meta = inputMetadata(declaration);
        if (!meta.required || meta.default !== undefined) continue;
        if (!meta.secret && (meta.type === "object" || meta.type === "array")) {
          exampleInputs[name] = meta.type === "object" ? {} : [];
        } else {
          const example = meta.secret
            ? "ENV_NAME"
            : meta.type === "number"
              ? "0"
              : meta.type === "boolean"
                ? "false"
                : "<string>";
          argv.push(meta.secret ? "--input-env" : "--input", `${name}=${example}`);
        }
      }
      if (Object.keys(exampleInputs).length) argv.push("--inputs-file", "<inputs.json>");
      const requiresAi = modules.some(
        ({ flow: module }) =>
          [
            ...(module.before ?? []),
            ...(module.after ?? []),
            ...module.steps.flatMap((step) => step.assert ?? []),
          ].some((assertion) => assertion.type === "ai_judge") ||
          module.steps.some(
            (step) =>
              step.do === "ai_pick" ||
              ("resolve" in step && step.resolve === "ai") ||
              (step.do === "extract" &&
                Object.values(step.fields).some((field) => !field.selector)),
          ),
      );
      recipes.push({
        path: file,
        id: flow.id,
        description: flow.description,
        inputs,
        before: "before" in flow ? flow.before : [],
        after: "after" in flow ? flow.after : [],
        effects: [
          ...new Set(
            modules.flatMap(({ flow: module }) =>
              module.steps.map((step) => step.effect ?? "unspecified"),
            ),
          ),
        ],
        outputs: "outputs" in flow ? flow.outputs : {},
        capabilities: {
          session: flow.config?.connect?.mode === "session",
          ai: requiresAi,
        },
        example_argv: argv,
        ...(Object.keys(exampleInputs).length ? { example_inputs_file: exampleInputs } : {}),
      });
    } catch (error) {
      // Parser/schema errors can contain source values. Metadata failures must not echo them.
      diagnostics.push({
        code: "RECIPE_INVALID",
        file,
        message:
          error instanceof Error && error.name === "FlowValidationError"
            ? "Recipe schema is invalid; run lint for locations."
            : "Recipe could not be read or parsed.",
      });
    }
  }
  if (!recipes.length && !diagnostics.length)
    diagnostics.push({
      code: "RECIPE_NOT_FOUND",
      file: paths.join(", "),
      message: "No flow recipes matched.",
    });
  return { catalogue_version: 1, recipes, diagnostics };
}
