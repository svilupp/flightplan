// Flightplan — the lint engine.
//
// `lintFile(path)` loads + parses a flow/config TOML, builds a LintContext (raw doc + the
// schema-validated flow/config when valid + precomputed import resolution + sidecar lock),
// runs every rule in `RULES`, and returns a LintResult. A malformed file produces lint
// DIAGNOSTICS, never a thrown error: TOML parse failures and otherwise-unexplained zod
// violations are converted into `parse/toml-syntax` / `schema/invalid` diagnostics.
//
// `lintPaths(paths)` expands directories/globs and lints each file, returning a
// MultiLintResult. Canonical reference: PLAN.md §5 (Phase 1, "flightplan lint").

import { ConfigFileSchema, formatIssues, parseToml, TomlParseError } from "../config/index.ts";
import type { LoadedFlow } from "../flow/index.ts";
import {
  collectImportScope,
  computeSourceHash,
  expandForEachInDoc,
  FlowFileSchema,
  ForEachError,
  ImportCycleError,
  isRunFlowPath,
  parseFlowFile,
  resolveImports,
} from "../flow/index.ts";
import { defaultFileSystem } from "../fs-default.ts";
import { dirname, isAbsolute, resolve } from "../paths.ts";
import { expandGlob, type FileSystemPort, listTomlFiles } from "../runtime.ts";
import { FILE_KINDS } from "../types.ts";
import {
  diag,
  type ImportLintInfo,
  type ImportScopeModule,
  type LintContext,
  type LockLintInfo,
  type RawDoc,
  type ResolvedRef,
} from "./context.ts";
import { RULES, readArtifactPath } from "./rules.ts";
import type { Diagnostic, LintResult, MultiLintResult } from "./types.ts";

function isRecord(v: unknown): v is RawDoc {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tally(file: string, diagnostics: Diagnostic[]): LintResult {
  let errorCount = 0;
  let warningCount = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errorCount++;
    else warningCount++;
  }
  return { file, diagnostics, errorCount, warningCount, ok: errorCount === 0 };
}

/** Result of {@link readLock}: the minimal lock info plus the full parsed doc (for rules). */
interface LoadedLock {
  info: LockLintInfo;
  doc: RawDoc | null;
}

/**
 * Read the sidecar lock at `<flow>.lock.toml` through the injected fs, returning its
 * `source_hash` (for the stale-hash rule) and the full parsed doc (precomputed for
 * `lock/orphaned-target`, which stays I/O-free by reading `ctx.lockDoc`).
 */
async function readLock(flowPath: string, fs: FileSystemPort): Promise<LoadedLock | null> {
  // Convention: collocated lock named `<basename>.lock.toml` next to the flow.
  const candidates = [flowPath.replace(/\.toml$/i, ".lock.toml"), `${flowPath}.lock.toml`];
  for (const lockPath of candidates) {
    if (lockPath === flowPath) continue;
    if (!(await fs.fileExists(lockPath))) continue;
    try {
      const text = await fs.readTextFile(lockPath);
      const parsed = parseToml(text, lockPath);
      const doc = isRecord(parsed) ? parsed : null;
      const sh = doc ? doc.source_hash : undefined;
      return { info: { path: lockPath, sourceHash: typeof sh === "string" ? sh : null }, doc };
    } catch {
      // A malformed lock is not the flow's fault; surface nothing (lock manager validates it).
      return { info: { path: lockPath, sourceHash: null }, doc: null };
    }
  }
  return null;
}

/**
 * Resolve a flow's imports + path-form `run` references (existence + cycle over the combined
 * DAG, PLAN_v002 v002-6) and the file's library scope, pre-baked for the pure rules.
 */
async function resolveImportInfo(
  loaded: LoadedFlow,
  fs: FileSystemPort,
): Promise<ImportLintInfo | null> {
  const flow = loaded.flow;
  const runSteps = flow.steps.filter((s) => s.do === "run");
  const hasRefs =
    flow.imports !== undefined ||
    flow.setup !== undefined ||
    flow.teardown !== undefined ||
    runSteps.length > 0;
  if (!hasRefs) return null;

  const baseDir = dirname(loaded.path);
  const refs: ResolvedRef[] = [];

  // Direct refs (existence check on each declared module/setup/teardown/run path).
  const addRef = async (raw: string, relation: ResolvedRef["relation"]): Promise<void> => {
    const resolved = isAbsolute(raw) ? raw : resolve(baseDir, raw);
    refs.push({ raw, resolved, exists: await fs.fileExists(resolved), relation });
  };

  const imports = flow.imports;
  if (typeof imports === "string") await addRef(imports, "import");
  else if (Array.isArray(imports)) {
    for (const entry of imports) await addRef(entry, "import");
  }
  if (flow.setup) await addRef(flow.setup, "setup");
  if (flow.teardown) await addRef(flow.teardown, "teardown");
  const seenRunPaths = new Set<string>();
  for (const step of runSteps) {
    if (step.do !== "run" || !isRunFlowPath(step.flow) || seenRunPaths.has(step.flow)) continue;
    seenRunPaths.add(step.flow);
    await addRef(step.flow, "run");
  }

  // Cycle detection + scope: only meaningful when all direct refs exist (resolveImports
  // loads them, including transitive imports and path-form run references).
  let cycle: string[] | null = null;
  let scope: ImportScopeModule[] | null = null;
  if (refs.every((r) => r.exists)) {
    try {
      const graph = await resolveImports(loaded, { fs });
      // Annotate every direct ref with the referenced module's flow id + declared inputs.
      for (const ref of refs) {
        const node = graph.nodes.get(ref.resolved);
        if (node) {
          ref.flowId = node.loaded.flow.id;
          ref.inputNames = Object.keys(node.loaded.flow.inputs ?? {});
        }
      }
      scope = [...collectImportScope(loaded, graph).values()].flat().map((m) => ({
        id: m.flow.id,
        path: m.path,
        inputNames: Object.keys(m.flow.inputs ?? {}),
      }));
    } catch (err) {
      if (err instanceof ImportCycleError) cycle = err.chain;
      // Other resolution errors (a malformed transitive import) are reported by linting that
      // file directly; we do not double-report here.
    }
  }

  return { refs, cycle, scope };
}

/** Options for {@link lintFile}. */
export interface LintFileOptions {
  /** Pre-read source text (skips the disk read; useful for tests). */
  sourceText?: string;
  /**
   * Filesystem port used for every existence/read check (imports, sidecar lock, output
   * directory checks). Defaults to {@link nodeFileSystem} so native behavior is unchanged.
   */
  fs?: FileSystemPort;
  /** Base directory for resolving a relative `path`. Defaults to the ambient cwd (Node only). */
  cwd?: string;
}

/**
 * The ambient cwd when available, `"/"` otherwise (Workers/bundled hosts have no `process`).
 * Guarded the same way as `ambientEnv` (`runtime.ts`); no bare `process.` token here.
 */
function ambientCwd(): string {
  const g = globalThis as { process?: { cwd?: () => string } };
  return g.process?.cwd?.() ?? "/";
}

/**
 * Precompute directory-existence for the two path rules that need it (`paths/lock-writable`,
 * `paths/out-writable`) so `rules.ts` stays pure/I/O-free. Cheap: at most two fs calls.
 */
async function computeDirExists(
  doc: RawDoc | null,
  baseDir: string,
  fs: FileSystemPort,
): Promise<Map<string, boolean>> {
  const dirExists = new Map<string, boolean>();
  if (!doc) return dirExists;
  for (const field of ["lock_path", "out_dir"]) {
    const raw = readArtifactPath(doc, field);
    if (raw === null) continue;
    const abs = isAbsolute(raw) ? raw : resolve(baseDir, raw);
    const parent = dirname(abs);
    if (dirExists.has(parent)) continue;
    dirExists.set(parent, await fs.fileExists(parent));
  }
  return dirExists;
}

/**
 * Lint a flow or config TOML given its already-read source text and a nominal path (used for
 * relative-import resolution + diagnostics `file` fields). The zero-fs entry point: every
 * existence/read this function still needs to perform (imports, sidecar lock, output dir
 * checks) goes through the injected `deps.fs` (default {@link nodeFileSystem}).
 */
export async function lintText(
  sourceText: string,
  nominalPath: string,
  deps?: { fs?: FileSystemPort; cwd?: string },
): Promise<LintResult> {
  return lintFileImpl(
    nominalPath,
    sourceText,
    deps?.fs ?? (await defaultFileSystem()),
    deps?.cwd ?? ambientCwd(),
  );
}

/**
 * Lint a single flow or config TOML file. Never throws for a bad file — every failure mode
 * (unreadable file, bad TOML, schema violation) becomes a diagnostic.
 */
export async function lintFile(path: string, opts?: LintFileOptions): Promise<LintResult> {
  return lintFileImpl(
    path,
    opts?.sourceText,
    opts?.fs ?? (await defaultFileSystem()),
    opts?.cwd ?? ambientCwd(),
  );
}

async function lintFileImpl(
  path: string,
  sourceTextOverride: string | undefined,
  fs: FileSystemPort,
  cwd: string,
): Promise<LintResult> {
  const file = isAbsolute(path) ? path : resolve(cwd, path);
  const baseDir = dirname(file);

  // 1. Read.
  let sourceText: string;
  if (sourceTextOverride !== undefined) {
    sourceText = sourceTextOverride;
  } else {
    try {
      sourceText = await fs.readTextFile(file);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return tally(file, [
        {
          ruleId: "io/unreadable",
          severity: "error",
          message: `Could not read file: ${detail}`,
          file,
        },
      ]);
    }
  }

  const sourceHash = computeSourceHash(sourceText);

  // 2. Parse TOML (raw). A syntax error short-circuits — no further rules can run.
  let doc: RawDoc | null = null;
  try {
    const parsed = parseToml(sourceText, file);
    doc = isRecord(parsed) ? parsed : {};
  } catch (err) {
    const detail =
      err instanceof TomlParseError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return tally(file, [
      {
        ruleId: "parse/toml-syntax",
        severity: "error",
        message: detail,
        file,
      },
    ]);
  }

  // 2.5. Expand `for_each` steps on the RAW doc so every per-step rule sees concrete steps
  // (matching the loader). A malformed `for_each` / misused loop token becomes a
  // `flow/for-each` diagnostic; linting then continues against the un-expanded doc (best-effort).
  let forEachDiag: Diagnostic | null = null;
  try {
    doc = expandForEachInDoc(doc, file);
  } catch (err) {
    if (err instanceof ForEachError) {
      forEachDiag = {
        ruleId: "flow/for-each",
        severity: "error",
        message: err.message,
        file,
      };
    } else {
      throw err;
    }
  }

  const declaredKind = typeof doc.kind === "string" ? doc.kind : null;

  // 3. Schema-validate (best effort) to get a narrowed object + a catch-all schema diagnostic.
  const ctx: LintContext = {
    file,
    baseDir,
    sourceText,
    doc,
    declaredKind,
    flow: null,
    config: null,
    imports: null,
    lock: null,
    sourceHash,
    lockDoc: null,
    dirExists: await computeDirExists(doc, baseDir, fs),
  };

  let schemaDiag: Diagnostic | null = null;

  if (declaredKind === FILE_KINDS[1]) {
    // flow
    try {
      const loaded = parseFlowFile(sourceText, file);
      ctx.flow = loaded.flow;
      ctx.imports = await resolveImportInfo(loaded, fs);
      const loadedLock = await readLock(file, fs);
      ctx.lock = loadedLock?.info ?? null;
      ctx.lockDoc = loadedLock?.doc ?? null;
    } catch {
      const result = FlowFileSchema.safeParse(doc);
      if (!result.success) {
        schemaDiag = diag(
          ctx,
          "schema/invalid",
          "error",
          `Flow failed schema validation: ${formatIssues(result.error.issues)}`,
        );
      }
    }
  } else if (declaredKind === FILE_KINDS[0]) {
    // config
    const result = ConfigFileSchema.safeParse(doc);
    if (result.success) {
      ctx.config = result.data;
    } else {
      schemaDiag = diag(
        ctx,
        "schema/invalid",
        "error",
        `Config failed schema validation: ${formatIssues(result.error.issues)}`,
      );
    }
  }
  // Unknown/absent kind: header rules will flag it; no schema validation attempted.

  // 4. Run every rule.
  const diagnostics: Diagnostic[] = [];
  if (forEachDiag !== null) diagnostics.push(forEachDiag);
  for (const rule of RULES) {
    try {
      diagnostics.push(...rule.run(ctx));
    } catch (err) {
      // A rule should never throw; if one does, surface it rather than crash the whole lint.
      const detail = err instanceof Error ? err.message : String(err);
      diagnostics.push(
        diag(ctx, `${rule.id}/internal-error`, "error", `Rule \`${rule.id}\` crashed: ${detail}`),
      );
    }
  }

  // 5. Append the catch-all schema diagnostic only if no structural rule already explained it.
  if (schemaDiag !== null && diagnostics.every((d) => d.severity !== "error")) {
    diagnostics.push(schemaDiag);
  }

  return tally(file, diagnostics);
}

/**
 * Lint a flow file given its already-parsed source. Thin convenience wrapper around
 * {@link lintFile} for callers (and tests) that hold the text. The name in the task spec is
 * `lintFlowFile`; this handles both flow and config kinds (the kind is read from the header).
 */
export async function lintFlowFile(path: string, opts?: LintFileOptions): Promise<LintResult> {
  return lintFile(path, opts);
}

/**
 * Expand a path into the concrete TOML files it refers to: a single `.toml` file passes
 * through; a directory expands to its `*.toml` children (non-recursive by default; a `**`
 * glob recurses).
 */
export async function expandPaths(
  paths: string[],
  deps?: { fs?: FileSystemPort; cwd?: string },
): Promise<string[]> {
  const fs = deps?.fs ?? (await defaultFileSystem());
  const cwd = deps?.cwd ?? ambientCwd();
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  };

  for (const raw of paths) {
    if (/[*?[]/.test(raw)) {
      for (const match of await expandGlob(raw, { fs, cwd })) {
        if (match.endsWith(".toml") && !match.endsWith(".lock.toml")) push(match);
      }
      continue;
    }
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
    const info = await fs.stat(abs);
    if (info?.isDirectory) {
      for (const match of await listTomlFiles(abs, fs)) {
        if (!match.endsWith(".lock.toml")) push(match);
      }
      continue;
    }
    push(abs);
  }
  return out;
}

/** Lint many paths (files, directories, or globs). Returns the aggregate result. */
export async function lintPaths(paths: string[], opts?: LintFileOptions): Promise<MultiLintResult> {
  const files = await expandPaths(paths, { fs: opts?.fs, cwd: opts?.cwd });
  const results: LintResult[] = [];
  for (const f of files) {
    results.push(await lintFile(f, opts));
  }
  let errorCount = 0;
  let warningCount = 0;
  for (const r of results) {
    errorCount += r.errorCount;
    warningCount += r.warningCount;
  }
  return { results, errorCount, warningCount, ok: errorCount === 0 };
}
