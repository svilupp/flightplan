// browser-pilot dist chunk gate (workers-slice-2 §7.2 / §4).
//
// The worker-portability walker (worker-portability.test.ts) only follows OUR source graph and
// treats `browser-pilot` as an opaque bare specifier (allowed as a value import, §7.1) — it
// cannot see inside the installed package's compiled `dist/*.mjs` chunks. This test does that:
// starting from the package's root export entry (resolved via its own `package.json` `exports`
// map, not a hardcoded path), it walks the RELATIVE chunk-import graph transitively and asserts:
//   (a) no static `node:*` / `chrome-launcher` import statement, no `require("node:` /
//       `child_process` token, anywhere in the reached graph — a bundler can always resolve it;
//   (b) every remaining `process.`-shaped or `getBuiltinModule` occurrence is one of the
//       DOCUMENTED, already-assessed offenders below (§4's honest risk assessment).
//
// The snapshot matches on the OFFENDING LINE TEXT, not the chunk filename — bp's build emits
// content-hashed chunk filenames (`chunk-<hash>.mjs`) that change on every publish even when the
// offending code itself is unchanged, so filename-keyed snapshots would need updating on every
// dependency bump for no signal. A bp upgrade that shuffles which chunk a known offending line
// lives in still passes; an upgrade that introduces a NEW offending line (or drops process.env's
// guard, etc.) fails loudly and forces a fresh §4 risk assessment, per the plan.

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
const EXPECTED_OFFENDERS: ReadonlyArray<{ line: string; note: string }> = [
  {
    line: "const getBuiltinModule = processLike?.getBuiltinModule;",
    note: "guarded via optional chaining on a captured `globalThis.process` reference — undefined off-Node, never throws.",
  },
  {
    line: 'if (typeof getBuiltinModule !== "function") return void 0;',
    note: "the guard check itself — references the identifier `getBuiltinModule`, not a call; part of the same guarded nodeFileSize() helper.",
  },
  {
    line: 'const fs2 = getBuiltinModule("node:fs");',
    note: "only reachable when the guarded getBuiltinModule() above returned a function (i.e. real Node) — the node:fs specifier is a runtime string, never a static import.",
  },
  {
    line: "return process.env;",
    note: 'local-discovery\'s getRuntimeEnv() — guarded by a preceding `typeof process === "undefined"` early-return two lines up (not adjacent-token-guarded, so the naive scan still lists it; safe by control flow).',
  },
  {
    line: "return process.platform;",
    note: 'local-discovery\'s getRuntimePlatform() — same `typeof process === "undefined"` early-return guard as process.env above.',
  },
  {
    line: 'const baseDir = record.outputDir ?? join(process.cwd(), ".browser-pilot");',
    note: "UNGUARDED — recording.createRecordingContext(), only reached on the video-recording code path (lazy, non-attach). Documented risk in §4: workers hosts must avoid `[browser] record` without `nodejs_compat`. Filed upstream against browser-pilot 0.4.x; fixed by the /core split in 0.5.0.",
  },
];

const STATIC_NODE_IMPORT_RE = /^\s*import\s[^;\n]*from\s+["']node:[^"']+["']/;
const REQUIRE_NODE_RE = /require\(\s*["']node:[^"']+["']\s*\)/;
const CHROME_LAUNCHER_RE = /from\s+["']chrome-launcher["']/;
const CHILD_PROCESS_RE = /\bchild_process\b/;
/** Bare `process.` token, not part of a longer identifier and not `globalThis.process.`. */
const PROCESS_TOKEN_RE = /(?<![.\w])process\.\w+/g;
const GET_BUILTIN_MODULE_RE = /getBuiltinModule/g;

const RELATIVE_IMPORT_RE = /from\s+["'](\.[^"']+)["']/g;

function resolveEntryPoint(): string {
  const pkgPath = require.resolve("browser-pilot/package.json");
  const pkgDir = dirname(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    exports?: Record<string, { import?: string }>;
    module?: string;
  };
  const rootExport = pkg.exports?.["."]?.import ?? pkg.module;
  if (!rootExport) {
    throw new Error(
      "browser-pilot package.json has no exports['.'].import / module field — update this gate's resolution logic.",
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
  const chunks = walkChunks(entry);

  test("resolves a non-trivial chunk graph from the package's own exports map", () => {
    // Sanity bound so a future bp release that collapses to a single monolithic file (or one
    // that suddenly explodes to hundreds of chunks) is visible as a deliberate change, not
    // silently accepted. workers-slice-2 §4 measured 8 (index.mjs + 7 relative chunks) on 0.4.1.
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
