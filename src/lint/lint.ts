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

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { ConfigFileSchema, parseToml, TomlParseError, formatIssues } from "../config/index.ts";
import {
  computeSourceHash,
  FlowFileSchema,
  parseFlowFile,
  resolveImports,
  ImportCycleError,
} from "../flow/index.ts";
import type { LoadedFlow } from "../flow/index.ts";
import { FILE_KINDS } from "../types.ts";
import {
  type ImportLintInfo,
  type LintContext,
  type LockLintInfo,
  type RawDoc,
  type ResolvedRef,
  diag,
} from "./context.ts";
import { RULES } from "./rules.ts";
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

/** Read the sidecar lock at `<flow>.lock.toml`, returning only its `source_hash`. */
function readLock(flowPath: string): LockLintInfo | null {
  // Convention: collocated lock named `<basename>.lock.toml` next to the flow.
  const candidates = [
    flowPath.replace(/\.toml$/i, ".lock.toml"),
    `${flowPath}.lock.toml`,
  ];
  for (const lockPath of candidates) {
    if (lockPath === flowPath) continue;
    if (!existsSync(lockPath)) continue;
    try {
      const text = readFileSync(lockPath, "utf8");
      const parsed = parseToml(text, lockPath);
      const sh = isRecord(parsed) ? parsed["source_hash"] : undefined;
      return { path: lockPath, sourceHash: typeof sh === "string" ? sh : null };
    } catch {
      // A malformed lock is not the flow's fault; surface nothing (lock manager validates it).
      return { path: lockPath, sourceHash: null };
    }
  }
  return null;
}

/** Resolve a flow's imports (existence + cycle), pre-baked for the pure rules. */
async function resolveImportInfo(loaded: LoadedFlow): Promise<ImportLintInfo | null> {
  const flow = loaded.flow;
  const hasImports =
    flow.imports !== undefined || flow.setup !== undefined || flow.teardown !== undefined;
  if (!hasImports) return null;

  const baseDir = dirname(loaded.path);
  const refs: ResolvedRef[] = [];

  // Direct refs (existence check on each declared module/setup/teardown).
  const addRef = (raw: string, relation: ResolvedRef["relation"]): void => {
    const resolved = isAbsolute(raw) ? raw : resolve(baseDir, raw);
    refs.push({ raw, resolved, exists: existsSync(resolved), relation });
  };

  const imports = flow.imports;
  if (typeof imports === "string") addRef(imports, "import");
  else if (Array.isArray(imports)) {
    for (const entry of imports) {
      if (typeof entry === "string") addRef(entry, "import");
      else addRef(entry.module, "import");
    }
  }
  if (flow.setup) addRef(flow.setup, "setup");
  if (flow.teardown) addRef(flow.teardown, "teardown");

  // Cycle detection: only meaningful when all direct refs exist (resolveImports loads them).
  let cycle: string[] | null = null;
  if (refs.every((r) => r.exists)) {
    try {
      await resolveImports(loaded);
    } catch (err) {
      if (err instanceof ImportCycleError) cycle = err.chain;
      // Other resolution errors (a malformed transitive import) are reported by linting that
      // file directly; we do not double-report here.
    }
  }

  return { refs, cycle };
}

/** Options for {@link lintFile}. */
export interface LintFileOptions {
  /** Pre-read source text (skips the disk read; useful for tests). */
  sourceText?: string;
}

/**
 * Lint a single flow or config TOML file. Never throws for a bad file — every failure mode
 * (unreadable file, bad TOML, schema violation) becomes a diagnostic.
 */
export async function lintFile(path: string, opts?: LintFileOptions): Promise<LintResult> {
  const file = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const baseDir = dirname(file);

  // 1. Read.
  let sourceText: string;
  if (opts?.sourceText !== undefined) {
    sourceText = opts.sourceText;
  } else {
    try {
      sourceText = await Bun.file(file).text();
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
      err instanceof TomlParseError ? err.message : err instanceof Error ? err.message : String(err);
    return tally(file, [
      {
        ruleId: "parse/toml-syntax",
        severity: "error",
        message: detail,
        file,
      },
    ]);
  }

  const declaredKind = typeof doc["kind"] === "string" ? (doc["kind"] as string) : null;

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
  };

  let schemaDiag: Diagnostic | null = null;

  if (declaredKind === FILE_KINDS[1]) {
    // flow
    try {
      const loaded = parseFlowFile(sourceText, file);
      ctx.flow = loaded.flow;
      ctx.imports = await resolveImportInfo(loaded);
      ctx.lock = readLock(file);
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
      ctx.config = result.data as LintContext["config"];
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
 * glob recurses); a glob pattern is expanded via Bun.Glob.
 */
export async function expandPaths(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  };

  for (const raw of paths) {
    if (raw.includes("*")) {
      // Glob relative to cwd.
      const glob = new Bun.Glob(raw);
      for await (const match of glob.scan({ cwd: process.cwd(), absolute: true })) {
        if (match.endsWith(".toml") && !match.endsWith(".lock.toml")) push(match);
      }
      continue;
    }
    const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      const glob = new Bun.Glob("*.toml");
      for await (const match of glob.scan({ cwd: abs, absolute: true })) {
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
  const files = await expandPaths(paths);
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
