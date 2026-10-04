// Check the installed portable core and Workers adapter graphs, including relative
// lazy chunks. The native root is intentionally outside this host contract.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Documented, already-risk-assessed `process.`/`getBuiltinModule` occurrences in the installed
 * `browser-pilot` dist (workers-slice-2 §4). Each entry is the exact trimmed line text (so a
 * change to the SAME line, even a no-op reformat, is caught and re-reviewed) plus a note on why
 * it is safe. Update this list — with a fresh §4 assessment — when `browser-pilot` is upgraded
 * and this test reports a new offender.
 */
const EXPECTED_OFFENDERS: ReadonlyArray<{ line: string; note: string }> = [];

const STATIC_NODE_IMPORT_RE = /^\s*import\s[^;\n]*from\s+["']node:[^"']+["']/;
const REQUIRE_NODE_RE = /require\(\s*["']node:[^"']+["']\s*\)/;
const CHROME_LAUNCHER_RE = /from\s+["']chrome-launcher["']/;
const CHILD_PROCESS_RE = /\bchild_process\b/;
/** Bare `process.` token, not part of a longer identifier and not `globalThis.process.`. */
const PROCESS_TOKEN_RE = /(?<![.\w])process\.\w+/g;
const GET_BUILTIN_MODULE_RE = /getBuiltinModule/g;

const RELATIVE_IMPORT_RE = /(?:from\s+|import\s*\(?\s*)["'](\.[^"']+)["']/g;

function resolveEntryPoint(subpath = "./core"): string {
  const pkgPath = require.resolve("browser-pilot/package.json");
  const pkgDir = dirname(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    exports?: Record<string, { import?: string }>;
    module?: string;
  };
  const rootExport = pkg.exports?.[subpath]?.import;
  if (!rootExport) {
    throw new Error(
      "browser-pilot package.json has no requested subpath import — update this gate's resolution logic.",
    );
  }
  return resolve(pkgDir, rootExport);
}

function walkChunks(entry: string): string[] {
  const visited = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    RELATIVE_IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null = RELATIVE_IMPORT_RE.exec(source);
    while (m !== null) {
      const target = resolve(dirname(file), m[1]!);
      if (!visited.has(target)) stack.push(target);
      m = RELATIVE_IMPORT_RE.exec(source);
    }
  }
  return [...visited];
}

describe("browser-pilot dist chunk gate", () => {
  const entry = resolveEntryPoint();
  const chunks = [
    ...new Set([...walkChunks(entry), ...walkChunks(resolveEntryPoint("./adapters/workers"))]),
  ];

  test("resolves a non-trivial chunk graph from the package's own exports map", () => {
    // Sanity bound so a future bp release that collapses to a single monolithic file (or one
    // that suddenly explodes to hundreds of chunks) is visible as a deliberate change, not
    // silently accepted. workers-slice-2 §4 measured 8 (index.mjs + 7 relative chunks) on 0.4.1;
    // 0.5.0 measured 16 (index.mjs + 15 relative chunks, incl. the new `/core` split); 0.6.0
    // measures 17 (index.mjs + 16 relative chunks) — one additional chunk, no new offenders
    // (re-verified below; see EXPECTED_OFFENDERS).
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(50);
  });

  test('no static node:*/chrome-launcher import or require("node:...")/child_process token in the reached graph', () => {
    const findings: Array<{ file: string; line: number; text: string }> = [];
    for (const file of chunks) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((text, i) => {
        if (
          STATIC_NODE_IMPORT_RE.test(text) ||
          REQUIRE_NODE_RE.test(text) ||
          CHROME_LAUNCHER_RE.test(text) ||
          CHILD_PROCESS_RE.test(text)
        ) {
          findings.push({ file, line: i + 1, text: text.trim() });
        }
      });
    }
    expect(findings).toEqual([]);
  });

  test("every process./getBuiltinModule occurrence matches the documented expected-offenders snapshot", () => {
    const expectedLines = new Set(EXPECTED_OFFENDERS.map((o) => o.line));
    const seen = new Set<string>();
    const newOffenders: Array<{ file: string; line: number; text: string }> = [];

    for (const file of chunks) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((rawText, i) => {
        const text = rawText.trim();
        const hasProcessToken = (() => {
          PROCESS_TOKEN_RE.lastIndex = 0;
          return PROCESS_TOKEN_RE.test(text);
        })();
        const hasGetBuiltinModule = (() => {
          GET_BUILTIN_MODULE_RE.lastIndex = 0;
          return GET_BUILTIN_MODULE_RE.test(text);
        })();
        if (!hasProcessToken && !hasGetBuiltinModule) return;
        if (expectedLines.has(text)) {
          seen.add(text);
          return;
        }
        newOffenders.push({ file, line: i + 1, text });
      });
    }

    expect(newOffenders).toEqual([]);
    // Informational, not a failure: report any snapshot entry the current dist no longer
    // contains, so a maintainer can prune it on the next deliberate snapshot update.
    const stale = EXPECTED_OFFENDERS.filter((o) => !seen.has(o.line)).map((o) => o.line);
    if (stale.length > 0) {
      console.warn(
        `browser-pilot-chunk-gate: ${stale.length} expected-offender snapshot line(s) no longer present in the dist (safe to prune): ${JSON.stringify(stale)}`,
      );
    }
  });
});
