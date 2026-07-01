// Linter tests: each broken fixture isolates one rule (assert the ruleId + non-ok); the
// real example flows lint clean; CLI exit codes (0 clean / 1 errors / 2 usage) and `--json`
// output shape. Canonical reference: PLAN.md §5 (Phase 1, lint) + §8 (starter ruleset).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RULE_IDS,
  formatJson,
  lintFile,
  lintFlowFile,
  lintPaths,
  looksLikeRawSelector,
} from "./index.ts";
import type { MultiLintResult } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "__fixtures__");
const repoRoot = resolve(here, "..", "..");
const flowsDir = join(repoRoot, "examples", "flows");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");

function fx(name: string): string {
  return join(fixtures, name);
}

// ---------------------------------------------------------------------------
// Broken fixtures → expected ruleId(s). Each isolates one rule violation.
// ---------------------------------------------------------------------------

const BROKEN: Array<{ file: string; expect: string[]; severity?: "error" | "warning" }> = [
  { file: "missing-header-field.toml", expect: ["header/required-fields"] },
  { file: "invalid-kind.toml", expect: ["header/valid-kind"] },
  { file: "duplicate-step-id.toml", expect: ["steps/unique-ids"] },
  { file: "unknown-do.toml", expect: ["steps/supported-do"] },
  { file: "missing-required-field.toml", expect: ["steps/required-fields"] },
  { file: "unknown-assert-type.toml", expect: ["assert/supported-type"] },
  { file: "ai-judge-threshold.toml", expect: ["assert/ai-judge-shape"] },
  { file: "ai-judge-bad-input.toml", expect: ["assert/ai-judge-shape"] },
  { file: "undeclared-input.toml", expect: ["templating/undeclared-input"] },
  { file: "raw-selector-target.toml", expect: ["steps/no-raw-selector"] },
  { file: "assert-step-no-assertion.toml", expect: ["assert/step-needs-assertion"] },
  { file: "import-missing.toml", expect: ["imports/resolves"] },
  { file: "cycle-a.toml", expect: ["imports/no-cycle"] },
  { file: "bad-toml-syntax.toml", expect: ["parse/toml-syntax"] },
  // warning-only: ok stays true but the rule still fires.
  {
    file: "ai-judge-only-critical.toml",
    expect: ["assert/critical-not-ai-only"],
    severity: "warning",
  },
];

describe("broken fixtures isolate their rule", () => {
  for (const { file, expect: expectedRules, severity } of BROKEN) {
    test(`${file} reports ${expectedRules.join(", ")}`, async () => {
      const result = await lintFile(fx(file));
      const ruleIds = result.diagnostics.map((d) => d.ruleId);
      for (const r of expectedRules) {
        expect(ruleIds).toContain(r);
      }
      if (severity === "warning") {
        // A warning-only fixture stays ok (no errors) but must still emit the warning.
        expect(result.ok).toBe(true);
        expect(result.warningCount).toBeGreaterThan(0);
        const d = result.diagnostics.find((x) => expectedRules.includes(x.ruleId));
        expect(d?.severity).toBe("warning");
      } else {
        expect(result.ok).toBe(false);
        expect(result.errorCount).toBeGreaterThan(0);
      }
    });
  }
});

describe("ai-judge-threshold also rejects via the strict schema", () => {
  test("threshold is reported by the ai-judge-shape rule", async () => {
    const result = await lintFile(fx("ai-judge-threshold.toml"));
    const d = result.diagnostics.find((x) => x.ruleId === "assert/ai-judge-shape");
    expect(d).toBeDefined();
    expect(d?.message).toContain("threshold");
  });
});

describe("env refs are reported as a warning", () => {
  test("a ${env.X} reference surfaces templating/env-refs", async () => {
    const source = `
version = 1
kind = "flow"
id = "x"
description = "uses an env var"
[[steps]]
id = "open"
do = "goto"
url = "\${env.BASE_URL}/wizard"
`;
    const result = await lintFlowFile("env-ref.toml", { sourceText: source });
    const d = result.diagnostics.find((x) => x.ruleId === "templating/env-refs");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.message).toContain("BASE_URL");
    // env refs are warnings → file is still ok.
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Valid example flows lint clean.
// ---------------------------------------------------------------------------

describe("valid example flows lint clean", () => {
  for (const name of ["wizard.toml", "gauntlet.toml", "drift.toml"]) {
    test(`flows/${name} has zero errors`, async () => {
      const result = await lintFile(join(flowsDir, name));
      expect(result.ok).toBe(true);
      expect(result.errorCount).toBe(0);
      // The example flows are deliberately authored with no warnings either.
      expect(result.warningCount).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-path lint aggregation.
// ---------------------------------------------------------------------------

describe("lintPaths aggregates multiple files", () => {
  test("a directory of broken fixtures yields ok=false and many errors", async () => {
    const multi = await lintPaths([fixtures]);
    expect(multi.ok).toBe(false);
    expect(multi.errorCount).toBeGreaterThan(0);
    expect(multi.results.length).toBeGreaterThan(10);
  });

  test("the flows directory lints clean", async () => {
    const multi = await lintPaths([flowsDir]);
    expect(multi.ok).toBe(true);
    expect(multi.errorCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// lock/stale-source-hash — needs a sidecar lock file with a mismatched hash.
// ---------------------------------------------------------------------------

describe("lock/stale-source-hash", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fp-lint-lock-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const FLOW = `version = 1
kind = "flow"
id = "locked.flow"
description = "Flow with a sidecar lock"
[[steps]]
id = "s1"
do = "wait"
ms = 1
`;

  test("warns when the lock's source_hash differs from the flow's", async () => {
    const flowPath = join(tmp, "locked.toml");
    writeFileSync(flowPath, FLOW);
    writeFileSync(
      join(tmp, "locked.lock.toml"),
      `version = 1\nsource = "locked.toml"\nsource_hash = "sha256:deadbeef"\ndescription = "stale"\n`,
    );
    const result = await lintFile(flowPath);
    const d = result.diagnostics.find((x) => x.ruleId === "lock/stale-source-hash");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(result.ok).toBe(true); // stale lock is a warning, not an error
  });

  test("does not warn when the lock matches the flow's source_hash", async () => {
    const flowPath = join(tmp, "fresh.toml");
    writeFileSync(flowPath, FLOW);
    const { computeSourceHash } = await import("../flow/index.ts");
    const hash = computeSourceHash(FLOW);
    writeFileSync(
      join(tmp, "fresh.lock.toml"),
      `version = 1\nsource = "fresh.toml"\nsource_hash = "${hash}"\ndescription = "fresh"\n`,
    );
    const result = await lintFile(flowPath);
    expect(result.diagnostics.some((x) => x.ruleId === "lock/stale-source-hash")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// looksLikeRawSelector heuristic.
// ---------------------------------------------------------------------------

describe("looksLikeRawSelector", () => {
  const raw = [
    "#wizard-next",
    ".save-btn",
    "//button[@id='x']",
    "[data-testid='create-order']",
    "css=.foo",
    "div > .btn",
  ];
  const nl = [
    "the Save button inside the Billing address panel",
    "create a new order",
    "Next",
    "the full name field",
  ];
  for (const s of raw) {
    test(`flags raw selector ${JSON.stringify(s)}`, () => {
      expect(looksLikeRawSelector(s)).toBe(true);
    });
  }
  for (const s of nl) {
    test(`allows NL target ${JSON.stringify(s)}`, () => {
      expect(looksLikeRawSelector(s)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Rule registry sanity.
// ---------------------------------------------------------------------------

describe("rule registry", () => {
  test("exposes the documented rule ids", () => {
    for (const id of [
      "header/required-fields",
      "header/valid-kind",
      "imports/resolves",
      "imports/no-cycle",
      "steps/unique-ids",
      "steps/supported-do",
      "steps/required-fields",
      "assert/supported-type",
      "assert/required-fields",
      "assert/ai-judge-shape",
      "assert/step-needs-assertion",
      "templating/undeclared-input",
      "templating/env-refs",
      "paths/lock-writable",
      "paths/out-writable",
      "steps/no-raw-selector",
      "assert/critical-not-ai-only",
      "lock/stale-source-hash",
    ]) {
      expect(RULE_IDS).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// CLI integration: exit codes + --json output shape (spawned subprocess).
// ---------------------------------------------------------------------------

async function runCli(extraArgs: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", cliEntry, "lint", ...extraArgs], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("CLI lint", () => {
  test("exits 0 on a clean flow", async () => {
    const { code, stdout } = await runCli([join(flowsDir, "wizard.toml")]);
    expect(code).toBe(0);
    expect(stdout).toContain("0 errors");
  });

  test("exits 1 on a broken flow and prints the violation", async () => {
    const { code, stdout } = await runCli([fx("duplicate-step-id.toml")]);
    expect(code).toBe(1);
    expect(stdout).toContain("steps/unique-ids");
  });

  test("exits 2 with no path", async () => {
    const { code } = await runCli([]);
    expect(code).toBe(2);
  });

  test("--json emits a valid MultiLintResult", async () => {
    const { code, stdout } = await runCli([fx("duplicate-step-id.toml"), "--json"]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout) as MultiLintResult;
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.errorCount).toBe("number");
    const first = parsed.results[0]!;
    expect(first.diagnostics.some((d) => d.ruleId === "steps/unique-ids")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatJson is round-trippable JSON.
// ---------------------------------------------------------------------------

describe("formatJson", () => {
  test("produces parseable JSON", async () => {
    const multi = await lintPaths([fx("invalid-kind.toml")]);
    const json = formatJson(multi);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
