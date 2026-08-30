// Linter tests: each broken fixture isolates one rule (assert the ruleId + non-ok); the
// real example flows lint clean; CLI exit codes (0 clean / 1 errors / 2 usage) and `--json`
// output shape. Canonical reference: PLAN.md §5 (Phase 1, lint) + §8 (starter ruleset).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatJson,
  lintFile,
  lintFlowFile,
  lintPaths,
  looksLikeUnprefixedSelector,
  RULE_IDS,
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
  { file: "assert-step-no-assertion.toml", expect: ["assert/step-needs-assertion"] },
  { file: "import-missing.toml", expect: ["imports/resolves"] },
  { file: "cycle-a.toml", expect: ["imports/no-cycle"] },
  { file: "bad-toml-syntax.toml", expect: ["parse/toml-syntax"] },
  { file: "removed-hints-field.toml", expect: ["steps/removed-targeting-fields"] },
  { file: "removed-intent-field.toml", expect: ["steps/removed-targeting-fields"] },
  { file: "missing-target.toml", expect: ["steps/target-present"] },
  { file: "toml-key-order.toml", expect: ["steps/toml-key-order"] },
  { file: "import-with-table.toml", expect: ["imports/no-with"] },
  // warning-only: ok stays true but the rule still fires.
  {
    file: "ai-judge-only-critical.toml",
    expect: ["assert/critical-not-ai-only"],
    severity: "warning",
  },
  {
    file: "raw-selector-target.toml",
    expect: ["steps/target-unprefixed-selector"],
    severity: "warning",
  },
  {
    file: "target-selectors-only.toml",
    expect: ["steps/target-needs-nl"],
    severity: "warning",
  },
  {
    file: "text-hint-unscoped.toml",
    expect: ["steps/text-hint-unscoped"],
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

describe("WebMCP ergonomics", () => {
  test("requires result assertions to stay on the WebMCP step", async () => {
    const source = `
version = 1
kind = "flow"
id = "x"
description = "bad result scope"
[[steps]]
id = "wait"
do = "wait"
ms = 0
[[steps.assert]]
type = "result"
exists = true
`;
    const result = await lintFlowFile("result-scope.toml", { sourceText: source });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.ruleId)).toContain("assert/result-scope");
  });

  test("warns when a WebMCP effect is left implicit", async () => {
    const source = `
version = 1
kind = "flow"
id = "x"
description = "implicit effect"
[[steps]]
id = "lookup"
do = "webmcp_call"
tool = "orders.lookup"
`;
    const result = await lintFlowFile("webmcp-effect.toml", { sourceText: source });
    expect(result.diagnostics.map((d) => d.ruleId)).toContain("effect/unspecified");
  });

  test("warns when a WebMCP input interpolates a secret-looking env var", async () => {
    const source = `
version = 1
kind = "flow"
id = "x"
description = "unmarked WebMCP secret"
[[steps]]
id = "lookup"
do = "webmcp_call"
tool = "orders.lookup"
input = { token = "\${env.API_TOKEN}" }
effect = "observe"
`;
    const result = await lintFlowFile("webmcp-secret.toml", { sourceText: source });
    expect(result.diagnostics.map((d) => d.ruleId)).toContain("security/unmarked-secret");
  });
});

describe("a [cache] block + per-step cache lint clean (L0 cache-hit quality — Layer 2)", () => {
  test("flow-level [config.cache] and a per-step cache = 'struct-only' parse + lint clean", async () => {
    const source = `
version = 1
kind = "flow"
id = "x"
description = "uses a cache block"

[config.cache]
ignore_regions = ["#live-feed", ".ticker"]
signature = "full"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/wizard"

[[steps]]
id = "next"
do = "click"
target = "Next"
cache = "struct-only"
`;
    const result = await lintFlowFile("cache-flow.toml", { sourceText: source });
    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
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
// v002 Phase 3 rules (composition-independent) — PLAN_v003 v003-2.
// ---------------------------------------------------------------------------

describe("assert/screenshot-needs-vision", () => {
  const SCREENSHOT_STEP = `
[[steps]]
id = "check"
do = "assert"
[[steps.assert]]
type = "ai_judge"
inputs = ["screenshot", "text"]
prompt = "The order was created."
`;

  test("warns when an explicit [config.ai.models] registry omits the vision role", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "screenshot judge, registry without vision"

[config.ai.models.resolver]
model = "openai/gpt-x"
${SCREENSHOT_STEP}`;
    const result = await lintFlowFile("shot-no-vision.toml", { sourceText: source });
    const d = result.diagnostics.find((x) => x.ruleId === "assert/screenshot-needs-vision");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(result.ok).toBe(true); // warning, not an error
  });

  test("clean when the registry configures a vision role", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "screenshot judge, vision configured"

[config.ai.models.vision]
model = "google/gemini-3-flash-preview"
${SCREENSHOT_STEP}`;
    const result = await lintFlowFile("shot-vision.toml", { sourceText: source });
    const ids = result.diagnostics.map((x) => x.ruleId);
    expect(ids).not.toContain("assert/screenshot-needs-vision");
  });

  test("clean when no explicit registry is configured (built-in default vision applies)", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "screenshot judge, no registry"
${SCREENSHOT_STEP}`;
    const result = await lintFlowFile("shot-default.toml", { sourceText: source });
    const ids = result.diagnostics.map((x) => x.ruleId);
    expect(ids).not.toContain("assert/screenshot-needs-vision");
  });

  test("clean when [config.ai.models.default] sets a model (covers vision via the default layer)", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "screenshot judge, default model"

[config.ai.models.default]
model = "openai/gpt-5.6-luna"
${SCREENSHOT_STEP}`;
    const result = await lintFlowFile("shot-default-model.toml", { sourceText: source });
    const ids = result.diagnostics.map((x) => x.ruleId);
    expect(ids).not.toContain("assert/screenshot-needs-vision");
  });

  test("still warns when the registry has neither vision nor a default.model", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "screenshot judge, default has no model"

[config.ai.models.resolver]
model = "openai/gpt-x"
[config.ai.models.default]
fallbacks = []
${SCREENSHOT_STEP}`;
    const result = await lintFlowFile("shot-default-no-model.toml", { sourceText: source });
    const d = result.diagnostics.find((x) => x.ruleId === "assert/screenshot-needs-vision");
    expect(d).toBeDefined();
  });
});

describe("assert/end-state-unasserted", () => {
  test("warns when the final state-changing step has no assertion", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "final click, unasserted"
[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/wizard"
[[steps]]
id = "submit"
do = "click"
target = "the Submit button"
`;
    const result = await lintFlowFile("end-unasserted.toml", { sourceText: source });
    const d = result.diagnostics.find((x) => x.ruleId === "assert/end-state-unasserted");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.stepId).toBe("submit");
    expect(result.ok).toBe(true);
  });

  test("clean when the final step carries an inline assertion", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "final click, asserted inline"
[[steps]]
id = "submit"
do = "click"
target = "the Submit button"
[[steps.assert]]
type = "text"
text = "Done"
`;
    const result = await lintFlowFile("end-asserted-inline.toml", { sourceText: source });
    expect(result.diagnostics.some((x) => x.ruleId === "assert/end-state-unasserted")).toBe(false);
  });

  test("clean when the flow ends in a dedicated assert step", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "trailing assert step"
[[steps]]
id = "submit"
do = "click"
target = "the Submit button"
[[steps]]
id = "verify"
do = "assert"
[[steps.assert]]
type = "text"
text = "Done"
`;
    const result = await lintFlowFile("end-assert-step.toml", { sourceText: source });
    expect(result.diagnostics.some((x) => x.ruleId === "assert/end-state-unasserted")).toBe(false);
  });

  test("clean when the final step is a non-state-changing wait", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "trailing wait is not flagged"
[[steps]]
id = "click_it"
do = "click"
target = "the button"
[[steps.assert]]
type = "text"
text = "ok"
[[steps]]
id = "settle"
do = "wait"
ms = 100
`;
    const result = await lintFlowFile("end-wait.toml", { sourceText: source });
    expect(result.diagnostics.some((x) => x.ruleId === "assert/end-state-unasserted")).toBe(false);
  });
});

describe("templating/unused-input", () => {
  test("warns for a declared input no step references", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "one input unused"
[inputs]
base_url = "http://localhost:3000"
unused_thing = "leftover"
[[steps]]
id = "open"
do = "goto"
url = "\${inputs.base_url}/wizard"
`;
    const result = await lintFlowFile("unused-input.toml", { sourceText: source });
    const d = result.diagnostics.find((x) => x.ruleId === "templating/unused-input");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.message).toContain("unused_thing");
    expect(result.ok).toBe(true);
  });

  test("clean when every declared input is referenced", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "all inputs used"
[inputs]
base_url = "http://localhost:3000"
name = "Jane"
[[steps]]
id = "open"
do = "goto"
url = "\${inputs.base_url}/wizard"
[[steps]]
id = "fill_name"
do = "fill"
target = "the name field"
value = "\${inputs.name}"
`;
    const result = await lintFlowFile("all-inputs-used.toml", { sourceText: source });
    expect(result.diagnostics.some((x) => x.ruleId === "templating/unused-input")).toBe(false);
  });
});

describe("lock/orphaned-target", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fp-lint-orphan-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const FLOW = `version = 1
kind = "flow"
id = "orphan.flow"
description = "Flow whose lock references a renamed step"
[[steps]]
id = "click_it"
do = "click"
target = "the button"
[[steps.assert]]
type = "text"
text = "ok"
`;

  test("warns when a lock target references a step id absent from the flow", async () => {
    const flowPath = join(tmp, "orphan.toml");
    writeFileSync(flowPath, FLOW);
    const { computeSourceHash } = await import("../flow/index.ts");
    const hash = computeSourceHash(FLOW);
    // A lock recording a target for a step that no longer exists (`old_click`).
    writeFileSync(
      join(tmp, "orphan.lock.toml"),
      `version = 1
source = "orphan.toml"
source_hash = "${hash}"
description = "learned"
[[targets]]
step = "old_click"
target = "the button"
strategy = "testid"
selector = "[data-testid='x']"
`,
    );
    const result = await lintFile(flowPath);
    const d = result.diagnostics.find((x) => x.ruleId === "lock/orphaned-target");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.stepId).toBe("old_click");
    expect(result.ok).toBe(true); // orphaned lock entry is a warning
  });

  test("clean when every lock target maps to an existing step", async () => {
    const flowPath = join(tmp, "matched.toml");
    writeFileSync(flowPath, FLOW);
    const { computeSourceHash } = await import("../flow/index.ts");
    const hash = computeSourceHash(FLOW);
    writeFileSync(
      join(tmp, "matched.lock.toml"),
      `version = 1
source = "matched.toml"
source_hash = "${hash}"
description = "learned"
[[targets]]
step = "click_it"
target = "the button"
strategy = "testid"
selector = "[data-testid='x']"
`,
    );
    const result = await lintFile(flowPath);
    expect(result.diagnostics.some((x) => x.ruleId === "lock/orphaned-target")).toBe(false);
  });
});

describe("security/unmarked-secret", () => {
  test("warns for a fill value with a secret-looking env var and no secret = true", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "unmarked secret fill"
[[steps]]
id = "enter_pw"
do = "fill"
target = "the password field"
value = "\${env.LOGIN_PASSWORD}"
`;
    const result = await lintFlowFile("unmarked-secret.toml", { sourceText: source });
    const d = result.diagnostics.find((x) => x.ruleId === "security/unmarked-secret");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.stepId).toBe("enter_pw");
    expect(result.ok).toBe(true);
  });

  test("clean when the step is marked secret = true", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "marked secret fill"
[[steps]]
id = "enter_pw"
do = "fill"
target = "the password field"
value = "\${env.LOGIN_PASSWORD}"
secret = true
`;
    const result = await lintFlowFile("marked-secret.toml", { sourceText: source });
    expect(result.diagnostics.some((x) => x.ruleId === "security/unmarked-secret")).toBe(false);
  });

  test("clean when the env var name does not look secret-y", async () => {
    const source = `version = 1
kind = "flow"
id = "x"
description = "non-secret env fill"
[[steps]]
id = "enter_name"
do = "fill"
target = "the name field"
value = "\${env.USER_NAME}"
`;
    const result = await lintFlowFile("nonsecret-env.toml", { sourceText: source });
    expect(result.diagnostics.some((x) => x.ruleId === "security/unmarked-secret")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// looksLikeUnprefixedSelector heuristic.
// ---------------------------------------------------------------------------

describe("looksLikeUnprefixedSelector", () => {
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
    ".NET downloads",
    "Products > Shoes",
  ];
  for (const s of raw) {
    test(`flags likely-selector ${JSON.stringify(s)}`, () => {
      expect(looksLikeUnprefixedSelector(s)).toBe(true);
    });
  }
  for (const s of nl.slice(0, 4)) {
    test(`allows NL target ${JSON.stringify(s)}`, () => {
      expect(looksLikeUnprefixedSelector(s)).toBe(false);
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
      "steps/toml-key-order",
      "steps/removed-targeting-fields",
      "steps/target-present",
      "steps/target-needs-nl",
      "steps/target-unprefixed-selector",
      "steps/text-hint-unscoped",
      "assert/critical-not-ai-only",
      "lock/stale-source-hash",
      "imports/no-with",
      "imports/unique-ids",
      "imports/unused-import",
      "run/flow-in-scope",
      "templating/with-inputs-declared",
      "assert/screenshot-needs-vision",
      "assert/end-state-unasserted",
      "templating/unused-input",
      "lock/orphaned-target",
      "security/unmarked-secret",
    ]) {
      expect(RULE_IDS).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// on_fail control flow: goto must reference an existing step id.
// ---------------------------------------------------------------------------

describe("steps/on-fail-goto-exists", () => {
  test("on_fail.goto to an UNKNOWN step id is an error", async () => {
    const source = `
version = 1
kind = "flow"
id = "x"
description = "bad goto"
[[steps]]
id = "click_it"
do = "click"
target = "the button"
on_fail = { goto = "nonexistent", max = 2 }
`;
    const result = await lintFlowFile("goto-bad.toml", { sourceText: source });
    const d = result.diagnostics.find((x) => x.ruleId === "steps/on-fail-goto-exists");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("error");
    expect(d?.message).toContain("nonexistent");
    expect(result.ok).toBe(false);
  });

  test("on_fail.goto to an EXISTING step id lints clean", async () => {
    const source = `
version = 1
kind = "flow"
id = "x"
description = "good goto"
[[steps]]
id = "fix_it"
do = "click"
target = "the fix button"
[[steps]]
id = "click_it"
do = "click"
target = "the button"
on_fail = { goto = "fix_it", max = 2 }
`;
    const result = await lintFlowFile("goto-ok.toml", { sourceText: source });
    expect(
      result.diagnostics.find((x) => x.ruleId === "steps/on-fail-goto-exists"),
    ).toBeUndefined();
    expect(result.errorCount).toBe(0);
  });

  test('on_fail.goto = "self" lints clean (retry the same step)', async () => {
    const source = `
version = 1
kind = "flow"
id = "x"
description = "self retry"
[[steps]]
id = "click_it"
do = "click"
target = "the button"
on_fail = { goto = "self" }
`;
    const result = await lintFlowFile("goto-self.toml", { sourceText: source });
    expect(result.errorCount).toBe(0);
  });

  test("on_fail.goto may reference a for_each-EXPANDED step id (expansion runs first)", async () => {
    const source = `
version = 1
kind = "flow"
id = "x"
description = "goto into an expanded step"
[[steps]]
id = "add"
do = "click"
for_each = ["A", "B"]
target = "add \${item}"
[[steps]]
id = "verify"
do = "click"
target = "verify"
on_fail = { goto = "add#1" }
`;
    const result = await lintFlowFile("goto-expanded.toml", { sourceText: source });
    // `add#1` exists after expansion → no goto error.
    expect(
      result.diagnostics.find((x) => x.ruleId === "steps/on-fail-goto-exists"),
    ).toBeUndefined();
    expect(result.errorCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// for_each expansion + token scoping in the linter.
// ---------------------------------------------------------------------------

describe("for_each in the linter", () => {
  test("a valid for_each flow lints clean (expansion → concrete steps)", async () => {
    const source = `
version = 1
kind = "flow"
id = "x"
description = "loop"
[inputs]
base_url = "http://localhost:3100"
[[steps]]
id = "add_item"
do = "click"
for_each = ["Headphones", "Keyboard", "Cable"]
target = ["[data-testid='add-\${item}']", "the Add to cart button for \${item}"]
`;
    const result = await lintFlowFile("loop-ok.toml", { sourceText: source });
    expect(result.errorCount).toBe(0);
  });

  test("a ${item} token OUTSIDE a for_each step is a flow/for-each error", async () => {
    const source = `
version = 1
kind = "flow"
id = "x"
description = "stray loop token"
[[steps]]
id = "click_it"
do = "click"
target = "click the \${item} button"
`;
    const result = await lintFlowFile("loop-stray.toml", { sourceText: source });
    const d = result.diagnostics.find((x) => x.ruleId === "flow/for-each");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("error");
    expect(result.ok).toBe(false);
  });

  test("an unknown ${loop.*} token inside a for_each step is a flow/for-each error", async () => {
    const source = `
version = 1
kind = "flow"
id = "x"
description = "bad loop token"
[[steps]]
id = "row"
do = "click"
for_each = ["A"]
target = "\${loop.nope}"
`;
    const result = await lintFlowFile("loop-badtoken.toml", { sourceText: source });
    expect(result.diagnostics.find((x) => x.ruleId === "flow/for-each")).toBeDefined();
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Composition rules (PLAN_v002 §3/§4): run/flow-in-scope, imports/unique-ids,
// imports/unused-import, templating/with-inputs-declared, run-path resolution,
// run cycles, and file-scoped goto.
// ---------------------------------------------------------------------------

describe("composition lint rules", () => {
  const tmp = mkdtempSync(join(tmpdir(), "fp-lint-run-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const CHILD = `version = 1
kind = "flow"
id = "auth.login"
description = "child"
[inputs]
account = "default"
[[steps]]
id = "open"
do = "goto"
url = "https://example.com/\${inputs.account}"
`;

  function writeTmp(name: string, text: string): string {
    const p = join(tmp, name);
    writeFileSync(p, text);
    return p;
  }

  function parent(body: string): string {
    return `version = 1\nkind = "flow"\nid = "parent"\ndescription = "parent"\n${body}`;
  }

  writeTmp("child.toml", CHILD);
  writeTmp(
    "child-dup.toml",
    CHILD.replace('description = "child"', 'description = "duplicate id"'),
  );

  test("run/flow-in-scope: id-form matching an imported flow id lints clean", async () => {
    const p = writeTmp(
      "in-scope.toml",
      parent(`imports = "./child.toml"
[[steps]]
id = "login"
do = "run"
flow = "auth.login"
`),
    );
    const result = await lintFile(p);
    expect(result.diagnostics.find((d) => d.ruleId === "run/flow-in-scope")).toBeUndefined();
    expect(result.errorCount).toBe(0);
  });

  test("run/flow-in-scope: an unknown id errors and lists the ids in scope", async () => {
    const p = writeTmp(
      "out-of-scope.toml",
      parent(`imports = "./child.toml"
[[steps]]
id = "login"
do = "run"
flow = "auth.nope"
`),
    );
    const result = await lintFile(p);
    const d = result.diagnostics.find((x) => x.ruleId === "run/flow-in-scope");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("error");
    expect(d?.message).toContain("auth.login");
    expect(result.ok).toBe(false);
  });

  test("imports/unique-ids: two imports declaring the same flow id error", async () => {
    const p = writeTmp(
      "dup-ids.toml",
      parent(`imports = ["./child.toml", "./child-dup.toml"]
[[steps]]
id = "login"
do = "run"
flow = "auth.login"
`),
    );
    const result = await lintFile(p);
    const d = result.diagnostics.find((x) => x.ruleId === "imports/unique-ids");
    expect(d).toBeDefined();
    expect(d?.message).toContain("auth.login");
    expect(result.ok).toBe(false);
  });

  test("imports/unique-ids: distinct ids lint clean", async () => {
    const p = writeTmp(
      "distinct-ids.toml",
      parent(`imports = "./child.toml"
[[steps]]
id = "login"
do = "run"
flow = "auth.login"
`),
    );
    const result = await lintFile(p);
    expect(result.diagnostics.find((x) => x.ruleId === "imports/unique-ids")).toBeUndefined();
  });

  test("imports/unused-import: an import with no run reference warns", async () => {
    const p = writeTmp(
      "unused.toml",
      parent(`imports = "./child.toml"
[[steps]]
id = "s1"
do = "wait"
ms = 1
`),
    );
    const result = await lintFile(p);
    const d = result.diagnostics.find((x) => x.ruleId === "imports/unused-import");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(result.ok).toBe(true); // warning only
  });

  test("imports/unused-import: silent when the import is run (by id or path)", async () => {
    const p = writeTmp(
      "used.toml",
      parent(`imports = "./child.toml"
[[steps]]
id = "login"
do = "run"
flow = "./child.toml"
`),
    );
    const result = await lintFile(p);
    expect(result.diagnostics.find((x) => x.ruleId === "imports/unused-import")).toBeUndefined();
  });

  test("templating/with-inputs-declared: an unknown `with` key errors", async () => {
    const p = writeTmp(
      "bad-with.toml",
      parent(`imports = "./child.toml"
[[steps]]
id = "login"
do = "run"
flow = "auth.login"
with = { acount = "typo" }
`),
    );
    const result = await lintFile(p);
    const d = result.diagnostics.find((x) => x.ruleId === "templating/with-inputs-declared");
    expect(d).toBeDefined();
    expect(d?.message).toContain("acount");
    expect(d?.message).toContain("account");
    expect(result.ok).toBe(false);
  });

  test("templating/with-inputs-declared: declared keys lint clean (path form too)", async () => {
    const p = writeTmp(
      "good-with.toml",
      parent(`[[steps]]
id = "login"
do = "run"
flow = "./child.toml"
with = { account = "jane" }
`),
    );
    const result = await lintFile(p);
    expect(
      result.diagnostics.find((x) => x.ruleId === "templating/with-inputs-declared"),
    ).toBeUndefined();
    expect(result.errorCount).toBe(0);
  });

  test("imports/resolves: a missing path-form run flow errors", async () => {
    const p = writeTmp(
      "missing-run.toml",
      parent(`[[steps]]
id = "login"
do = "run"
flow = "./nope.toml"
`),
    );
    const result = await lintFile(p);
    const d = result.diagnostics.find((x) => x.ruleId === "imports/resolves");
    expect(d).toBeDefined();
    expect(d?.message).toContain("./nope.toml");
    expect(result.ok).toBe(false);
  });

  test("imports/no-cycle: a run-reference cycle errors", async () => {
    writeTmp(
      "run-cycle-a.toml",
      `version = 1\nkind = "flow"\nid = "cyc-a"\ndescription = "a"\n[[steps]]\nid = "go"\ndo = "run"\nflow = "./run-cycle-b.toml"\n`,
    );
    const pb = writeTmp(
      "run-cycle-b.toml",
      `version = 1\nkind = "flow"\nid = "cyc-b"\ndescription = "b"\n[[steps]]\nid = "go"\ndo = "run"\nflow = "./run-cycle-a.toml"\n`,
    );
    const result = await lintFile(pb);
    const d = result.diagnostics.find((x) => x.ruleId === "imports/no-cycle");
    expect(d).toBeDefined();
    expect(result.ok).toBe(false);
  });

  test("steps/required-fields: a run step without `flow` errors", async () => {
    const p = writeTmp(
      "run-no-flow.toml",
      parent(`[[steps]]
id = "login"
do = "run"
`),
    );
    const result = await lintFile(p);
    const d = result.diagnostics.find(
      (x) => x.ruleId === "steps/required-fields" && x.stepId === "login",
    );
    expect(d).toBeDefined();
    expect(d?.message).toContain("flow");
  });

  test("steps/on-fail-goto-exists: a goto into a run child gets the boundary message", async () => {
    const p = writeTmp(
      "goto-boundary.toml",
      parent(`imports = "./child.toml"
[[steps]]
id = "login"
do = "run"
flow = "auth.login"
[[steps]]
id = "verify"
do = "click"
target = "verify"
on_fail = { goto = "login:open" }
`),
    );
    const result = await lintFile(p);
    const d = result.diagnostics.find((x) => x.ruleId === "steps/on-fail-goto-exists");
    expect(d).toBeDefined();
    expect(d?.message).toContain("file-scoped");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CLI integration: exit codes + --json output shape (spawned subprocess).
// ---------------------------------------------------------------------------

async function runCli(
  extraArgs: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
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
