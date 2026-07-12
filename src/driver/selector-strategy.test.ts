// Tests for the `selectorUsed` → `Strategy` mapping — every case in PLAN.md §4's table.

import { describe, expect, test } from "bun:test";
import { selectorUsedToStrategy, strategyFromStepResult } from "./selector-strategy.ts";

describe("selectorUsedToStrategy — the §4 mapping table", () => {
  test("testid: data-testid → 'testid'", () => {
    expect(selectorUsedToStrategy("[data-testid='create-order']")).toBe("testid");
    expect(selectorUsedToStrategy('[data-testid="create-order"]')).toBe("testid");
  });

  test("testid: data-test-id / data-test / data-qa → 'testid'", () => {
    expect(selectorUsedToStrategy("[data-test-id='x']")).toBe("testid");
    expect(selectorUsedToStrategy("[data-test='x']")).toBe("testid");
    expect(selectorUsedToStrategy("[data-qa='x']")).toBe("testid");
  });

  test("role/name: role: special → 'role_name'", () => {
    expect(selectorUsedToStrategy("role:button:Create order")).toBe("role_name");
    expect(selectorUsedToStrategy("role:link")).toBe("role_name");
  });

  test("Fix 2 positional: role:Role[N] → 'role_name'", () => {
    expect(selectorUsedToStrategy("role:button[2]")).toBe("role_name");
    expect(selectorUsedToStrategy('role:button:"Bold"[3]')).toBe("role_name");
  });

  test("Fix 2 attribute hook: [data-cmd=…] (declared attribute) → 'testid'", () => {
    expect(selectorUsedToStrategy('[data-cmd="c2"]')).toBe("testid");
    expect(selectorUsedToStrategy("[data-cmd='c2']")).toBe("testid");
  });

  test("role/name: generated [role][aria-label] pair → 'role_name'", () => {
    expect(selectorUsedToStrategy('[role="button"][aria-label="Create order"]')).toBe("role_name");
  });

  test("label: aria-label (alone) → 'label'", () => {
    expect(selectorUsedToStrategy("[aria-label='Create order']")).toBe("label");
  });

  test("label: placeholder folds into 'label'", () => {
    expect(selectorUsedToStrategy("[placeholder='Search…']")).toBe("label");
  });

  test("label: name attribute → 'label'", () => {
    expect(selectorUsedToStrategy("[name='email']")).toBe("label");
  });

  test("label: explicit label: special → 'label'", () => {
    expect(selectorUsedToStrategy("label:First Name")).toBe("label");
  });

  test("scoped_text: text: special → 'scoped_text'", () => {
    expect(selectorUsedToStrategy("text:Create order")).toBe("scoped_text");
  });

  test("structural_fingerprint: fingerprint/fp/structure → 'structural_fingerprint'", () => {
    expect(selectorUsedToStrategy("fingerprint:abc123")).toBe("structural_fingerprint");
    expect(selectorUsedToStrategy("fp:abc123")).toBe("structural_fingerprint");
    expect(selectorUsedToStrategy("structure:abc123")).toBe("structural_fingerprint");
  });

  test("css: raw CSS fallbacks → 'css'", () => {
    expect(selectorUsedToStrategy("#submit-btn")).toBe("css");
    expect(selectorUsedToStrategy(".btn.btn-primary")).toBe("css");
    expect(selectorUsedToStrategy("form > button:nth-child(2)")).toBe("css");
    expect(selectorUsedToStrategy("button")).toBe("css");
  });

  test("ref:eN → null (ephemeral, never persistable)", () => {
    expect(selectorUsedToStrategy("ref:e12")).toBeNull();
    expect(selectorUsedToStrategy("ref:e0")).toBeNull();
  });

  test("precedence: testid wins over a co-present aria-label in the same selector", () => {
    // A combined selector that carries both a testid and aria-label maps to the stronger
    // 'testid' (the testid check runs first).
    expect(selectorUsedToStrategy("[data-testid='x'][aria-label='X']")).toBe("testid");
  });

  test("whitespace is tolerated", () => {
    expect(selectorUsedToStrategy("  ref:e9  ")).toBeNull();
    expect(selectorUsedToStrategy("  text:Go  ")).toBe("scoped_text");
  });
});

describe("strategyFromStepResult", () => {
  test("returns null when selectorUsed is absent", () => {
    expect(strategyFromStepResult({})).toBeNull();
    expect(strategyFromStepResult({ selectorUsed: undefined })).toBeNull();
  });

  test("maps a present selectorUsed", () => {
    expect(strategyFromStepResult({ selectorUsed: "[data-testid='a']" })).toBe("testid");
    expect(strategyFromStepResult({ selectorUsed: "ref:e3" })).toBeNull();
  });
});
