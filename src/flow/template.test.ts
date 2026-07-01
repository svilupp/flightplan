// Templating tests: ${inputs.x} / ${env.Y} substitution; undeclared input throws;
// collectRefs hook; deep templating; resolveInputs with `with` overrides.

import { describe, expect, test } from "bun:test";
import {
  applyTemplating,
  applyTemplatingDeep,
  collectRefs,
  resolveInputs,
  TemplateError,
} from "./index.ts";

describe("applyTemplating", () => {
  test("substitutes ${inputs.x}", () => {
    const out = applyTemplating("${inputs.base_url}/orders", {
      inputs: { base_url: "https://x" },
    });
    expect(out).toBe("https://x/orders");
  });

  test("substitutes ${env.Y}", () => {
    const out = applyTemplating("key=${env.MY_KEY}", {
      inputs: {},
      env: { MY_KEY: "secret" },
    });
    expect(out).toBe("key=secret");
  });

  test("substitutes multiple refs in one string", () => {
    const out = applyTemplating("${env.HOST}:${inputs.port}", {
      inputs: { port: "8080" },
      env: { HOST: "localhost" },
    });
    expect(out).toBe("localhost:8080");
  });

  test("tolerates whitespace inside the braces", () => {
    const out = applyTemplating("${ inputs.a }", { inputs: { a: "1" } });
    expect(out).toBe("1");
  });

  test("throws on an undeclared input", () => {
    expect(() => applyTemplating("${inputs.missing}", { inputs: {} })).toThrow(
      TemplateError,
    );
  });

  test("throws on an undefined env var", () => {
    expect(() =>
      applyTemplating("${env.NOPE}", { inputs: {}, env: {} }),
    ).toThrow(TemplateError);
  });

  test("throws on an unsupported source (e.g. ${steps.*}, deferred to v1)", () => {
    expect(() =>
      applyTemplating("${steps.s1.outputs.id}", { inputs: {}, env: {} }),
    ).toThrow(TemplateError);
  });

  test("leaves non-template text untouched", () => {
    expect(applyTemplating("plain text $100", { inputs: {} })).toBe("plain text $100");
  });
});

describe("collectRefs (linter hook)", () => {
  test("collects inputs and env refs without resolving", () => {
    const refs = collectRefs("${inputs.a}/${env.B}");
    expect(refs).toEqual([
      { source: "inputs", name: "a", raw: "${inputs.a}" },
      { source: "env", name: "B", raw: "${env.B}" },
    ]);
  });

  test("ignores unsupported sources", () => {
    expect(collectRefs("${steps.x.y}")).toEqual([]);
  });
});

describe("applyTemplatingDeep", () => {
  test("templates strings nested in objects and arrays, leaves scalars alone", () => {
    const out = applyTemplatingDeep(
      {
        url: "${inputs.base}/x",
        ms: 500,
        list: ["${env.A}", "lit"],
        nested: { v: "${inputs.base}" },
      },
      { inputs: { base: "B" }, env: { A: "AA" } },
    );
    expect(out).toEqual({
      url: "B/x",
      ms: 500,
      list: ["AA", "lit"],
      nested: { v: "B" },
    });
  });
});

describe("resolveInputs", () => {
  test("`with` overrides win over declared defaults", () => {
    const out = resolveInputs(
      { account: "default", region: "us" },
      { account: "override" },
      {},
    );
    expect(out).toEqual({ account: "override", region: "us" });
  });

  test("declared defaults are templated against env", () => {
    const out = resolveInputs(
      { base: "${env.BASE}", path: "${inputs.base}/api" },
      undefined,
      { BASE: "https://x" },
    );
    expect(out).toEqual({ base: "https://x", path: "https://x/api" });
  });

  test("`with` values are templated against parent env + parent inputs", () => {
    const out = resolveInputs(
      { acct: "fallback" },
      { acct: "${env.ACCT}" },
      { ACCT: "real" },
    );
    expect(out.acct).toBe("real");
  });

  test("returns empty object when nothing is declared", () => {
    expect(resolveInputs(undefined, undefined, {})).toEqual({});
  });
});
