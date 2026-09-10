// Worker-portability fitness gate (workers-slice-2 §7.1).
//
// Walks the STATIC import/export graph reachable from the run path's two public entry points
// (`runFlow` via `src/runner/runner.ts`, `lintText`/`lintFile`/`lintPaths` via
// `src/lint/lint.ts`) and fails if that graph contains a forbidden specifier or a bare
// `process.` token outside the guarded `ambientEnv`/`ambientCwd` helpers.
//
// The walk is a REGEX-based source scan (mirrors browser-pilot's `tests/fitness/
// core-portability.test.ts`), not a real module resolver: it matches `import ... from "..."`
// and `export ... from "..."` (including `import type` / `export type` — type-only edges are
// walked too, conservatively, so a "type-only" re-export can never smuggle a forbidden
// dependency into the checked graph) plus LITERAL-string dynamic `import("literal")` calls.
// It deliberately does NOT match computed-specifier dynamic imports (`import(someVariable)`) —
// that is the exact mechanism `src/fs-default.ts` and the runner's lazy AI loader use to keep
// `src/adapters/node/**` and the AI SDKs out of a bundled worker graph while still resolving at
// runtime on Node. Bare `process.` tokens are similarly a source-text scan, not a type-aware
// check.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "..");

/** Specifiers forbidden anywhere in the reachable graph (exact or prefix match). */
const FORBIDDEN_EXACT = new Set([
  "ai",
  "just-bash",
  "bun:test",
  "bun:sqlite",
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:path",
]);
const FORBIDDEN_PREFIXES = ["node:", "bun:", "@ai-sdk/", "@openrouter/", "chrome-launcher"];

/** Relative module paths forbidden in the reachable graph (native-CLI-only surface). */
const FORBIDDEN_MODULES = [
  "src/cli/index.ts",
  "src/cli/explain.ts",
  "src/cli/report.ts",
  "src/cli/sweep.ts",
  "src/adapters/node/index.ts",
];

/** Root worker-legal entries, each walked independently below. */
const ENTRIES = [
  resolve(SRC_ROOT, "runner/runner.ts"),
  resolve(SRC_ROOT, "lint/lint.ts"),
  resolve(SRC_ROOT, "worker.ts"),
  resolve(SRC_ROOT, "cli/commands.ts"),
  // Shell hosts use the same portable graph as direct embedding consumers.
  resolve(SRC_ROOT, "shell/index.ts"),
];

/**
 * Modules allowed to reference `src/adapters/node/index.ts` or the AI SDK statically — they are
 * never themselves reached by the walk (only reached via a computed-specifier dynamic import),
 * so they act as a documented escape hatch rather than a walker exemption.
 */
const LAZY_ONLY_MODULES = new Set([
  resolve(SRC_ROOT, "ai/default-generate.ts"),
  resolve(SRC_ROOT, "ai/provider.ts"),
]);

// `import ... from "spec"`, `export ... from "spec"`, `import type ... from "spec"`,
// `export type ... from "spec"`, and bare `import "spec"` side-effect imports.
const STATIC_IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)(?:\s+type)?\s[^;\n]*?from\s+["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
// Literal-string dynamic import: `import("literal")`. A variable/template specifier does NOT
// match this (no closing quote directly inside the parens) — that is the intended lazy escape.
const LITERAL_DYNAMIC_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

interface Finding {
  file: string;
  reason: string;
}

function isForbiddenSpecifier(spec: string): boolean {
  if (FORBIDDEN_EXACT.has(spec)) return true;
  return FORBIDDEN_PREFIXES.some((p) => spec.startsWith(p));
}

function extractSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const re of [STATIC_IMPORT_RE, BARE_IMPORT_RE, LITERAL_DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(source);
    while (m !== null) {
      specs.push(m[1]!);
      m = re.exec(source);
    }
  }
  return specs;
}

/** Strip line + block comments so commented-out imports / doc examples never poison the walk. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Resolve a relative specifier to a concrete on-disk `.ts` file, mirroring Node/Bun's ESM
 * resolution for the shapes this codebase actually emits: `./x` / `./x.ts` / `./x.js` (built
 * output extension, source-mapped back to `.ts`) and directory imports (`./dir` / `./dir/index.js`
 * → `./dir/index.ts`). Returns `null` for a bare (non-relative) package specifier. Throws when a
 * relative specifier cannot be resolved to any candidate — previously the walker silently
 * dropped these, which could hide a forbidden edge behind a typo'd or unresolvable path.
 */
function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    base.endsWith(".js") ? base.slice(0, -3) : null,
    base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : null,
    resolve(base, "index.ts"),
    resolve(base, "index.js"),
  ].filter((c): c is string => c !== null);
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `worker-portability walker: unresolvable relative specifier "${spec}" from "${fromFile.slice(SRC_ROOT.length + 1)}" ` +
      `(tried: ${candidates.map((c) => c.slice(SRC_ROOT.length + 1)).join(", ")}). ` +
      "Fix the import or extend the walker's resolution candidates — do not let this fail silently.",
  );
}

/** Walk the static graph from `entry`, returning every forbidden finding. */
function walk(entryFile: string): Finding[] {
  const findings: Finding[] = [];
  const visited = new Set<string>();
  const stack = [entryFile];

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue; // Non-.ts specifier (e.g. resolved wrong) — ignore, not this gate's concern.
    }
    const source = stripComments(raw);

    // Bare `process.` token, outside the guarded ambientEnv/ambientCwd helper definitions
    // themselves (they contain the literal `.process?.` optional-chaining form, never a bare
    // `process.` token).
    const relFile = file.slice(SRC_ROOT.length + 1);
    if (
      /(?<![.\w])process\./.test(source) &&
      !relFile.endsWith("fitness/worker-portability.test.ts")
    ) {
      findings.push({ file: relFile, reason: "bare `process.` token" });
    }

    for (const spec of extractSpecifiers(source)) {
      if (isForbiddenSpecifier(spec)) {
        findings.push({ file: relFile, reason: `forbidden specifier "${spec}"` });
        continue;
      }
      const target = resolveRelative(file, spec);
      if (target === null) continue; // bare package specifier (browser-pilot, zod, smol-toml, …)
      const relTarget = target.slice(SRC_ROOT.length + 1);
      if (FORBIDDEN_MODULES.includes(relTarget)) {
        findings.push({ file: relFile, reason: `forbidden module "${relTarget}"` });
        continue;
      }
      if (LAZY_ONLY_MODULES.has(target)) {
        findings.push({
          file: relFile,
          reason: `statically reaches lazy-only module "${relTarget}" (must be a computed-specifier dynamic import)`,
        });
        continue;
      }
      stack.push(target);
    }
  }
  return findings;
}

describe("worker-portability fitness gate", () => {
  test("runFlow's (src/runner/runner.ts) static graph is worker-legal", () => {
    const findings = walk(resolve(SRC_ROOT, "runner/runner.ts"));
    expect(findings).toEqual([]);
  });

  test("lintText's (src/lint/lint.ts) static graph is worker-legal", () => {
    const findings = walk(resolve(SRC_ROOT, "lint/lint.ts"));
    expect(findings).toEqual([]);
  });

  test("src/worker.ts's curated barrel static graph is worker-legal", () => {
    const findings = walk(resolve(SRC_ROOT, "worker.ts"));
    expect(findings).toEqual([]);
  });

  test("src/cli/commands.ts's static graph is worker-legal", () => {
    const findings = walk(resolve(SRC_ROOT, "cli/commands.ts"));
    expect(findings).toEqual([]);
  });

  test("src/shell/index.ts's static graph is worker-legal", () => {
    const findings = walk(resolve(SRC_ROOT, "shell/index.ts"));
    expect(findings).toEqual([]);
  });

  test("ENTRIES covers every worker-legal root", () => {
    for (const entry of ENTRIES) {
      expect(walk(entry)).toEqual([]);
    }
  });

  test("sanity: the walker actually catches a static node:fs import", () => {
    // Not a real file — feed the walker a fixture-file-shaped in-memory check via the regex
    // helpers directly, so this test doesn't need to write a throwaway .ts file to disk.
    const source = 'import { readFile } from "node:fs/promises";\n';
    const specs = extractSpecifiers(stripComments(source));
    expect(specs.some((s) => isForbiddenSpecifier(s))).toBe(true);
  });

  test("sanity: the walker does not flag a computed-specifier dynamic import", () => {
    const source = 'const spec = "node:fs";\nawait import(spec);\n';
    const specs = extractSpecifiers(stripComments(source));
    expect(specs).toEqual([]);
  });

  test("resolveRelative resolves ./x.js -> ./x.ts, ./dir -> ./dir/index.ts, ./dir/index.js", () => {
    // src/index.ts imports lots of "./x/index.ts"-shaped and plain "./x.ts" specifiers today;
    // exercise the resolver directly against real files to lock in the extension-swap and
    // directory-index candidates without depending on any single source file's current shape.
    const runnerDir = resolve(SRC_ROOT, "runner");
    expect(resolveRelative(resolve(runnerDir, "runner.ts"), "./types.ts")).toBe(
      resolve(runnerDir, "types.ts"),
    );
    expect(resolveRelative(resolve(runnerDir, "runner.ts"), "./types.js")).toBe(
      resolve(runnerDir, "types.ts"),
    );
    expect(resolveRelative(resolve(SRC_ROOT, "worker.ts"), "./adapters/memory.ts")).toBe(
      resolve(SRC_ROOT, "adapters/memory.ts"),
    );
    expect(resolveRelative(resolve(SRC_ROOT, "index.ts"), "./adapters/node")).toBe(
      resolve(SRC_ROOT, "adapters/node/index.ts"),
    );
    expect(resolveRelative(resolve(SRC_ROOT, "index.ts"), "./adapters/node/index.js")).toBe(
      resolve(SRC_ROOT, "adapters/node/index.ts"),
    );
  });

  test("resolveRelative throws loudly on an unresolvable relative specifier", () => {
    expect(() =>
      resolveRelative(resolve(SRC_ROOT, "worker.ts"), "./this-module-does-not-exist"),
    ).toThrow(/unresolvable relative specifier/);
  });
});
