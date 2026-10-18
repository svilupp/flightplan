import { describe, expect, test } from "bun:test";
import { memoryFileSystem } from "../adapters/memory.ts";
import { bindInputs, gatherInputSecrets, InputBindingError } from "./input.ts";
import { loadFlowFileFlattened } from "./run.ts";
import { applyTemplatingDeep, resolveInputs } from "./template.ts";

describe("typed recipe inputs", () => {
  test("aggregates missing, unknown, invalid and secret literal diagnostics without values", () => {
    try {
      bindInputs(
        {
          required: { type: "string", required: true },
          amount: { type: "number" },
          token: { type: "string", secret: true },
        },
        { typo: "value", amount: "not-number", token: "canary-secret" },
      );
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(InputBindingError);
      expect((error as InputBindingError).issues.map((issue) => issue.code)).toEqual([
        "INPUT_UNKNOWN",
        "INPUT_REQUIRED",
        "INPUT_TYPE",
        "INPUT_SECRET_REFERENCE",
      ]);
      expect(String(error)).not.toContain("canary-secret");
    }
  });
  test("preserves whole-token JSON types and rejects structured text interpolation", () => {
    const inputs = bindInputs(
      {
        amount: { type: "number", default: 100 },
        enabled: { type: "boolean" },
        payload: { type: "object" },
      },
      { enabled: false, payload: { items: [1, 2] } },
    );
    expect(
      applyTemplatingDeep<unknown>(
        {
          amount: "${inputs.amount}",
          enabled: "${inputs.enabled}",
          payload: "${inputs.payload}",
          text: "above ${inputs.amount}",
        },
        { inputs },
      ),
    ).toEqual({ amount: 100, enabled: false, payload: { items: [1, 2] }, text: "above 100" });
    expect(() => applyTemplatingDeep("payload ${inputs.payload}", { inputs })).toThrow(
      "cannot be embedded",
    );
  });
  test("resolves secret references and caller template strings remain literal", () => {
    const declarations = {
      token: { type: "string" as const, secret: true },
      text: { type: "string" as const },
    };
    const inputs = resolveInputs(
      declarations,
      undefined,
      { TOKEN: "canary-secret" },
      {},
      { token: { from_env: "TOKEN" }, text: "${env.TOKEN}" },
    );
    expect(inputs.text).toBe("${env.TOKEN}");
    expect(gatherInputSecrets(declarations, inputs)).toEqual(["canary-secret"]);
  });
  test("root overrides reach nested required child input before flattening", async () => {
    const fs = memoryFileSystem();
    await fs.writeTextFile(
      "/root.toml",
      'version=1\nkind="flow"\nid="root"\ndescription="root"\n[inputs.amount]\ntype="number"\nrequired=true\n[[steps]]\nid="child"\ndo="run"\nflow="child.toml"\n[steps.with]\namount="${inputs.amount}"\n',
    );
    await fs.writeTextFile(
      "/child.toml",
      'version=1\nkind="flow"\nid="child"\ndescription="child"\n[inputs.amount]\ntype="number"\nrequired=true\n[[steps]]\nid="read"\ndo="webmcp_call"\ntool="orders.read"\n[steps.input]\namount="${inputs.amount}"\n',
    );
    const loaded = await loadFlowFileFlattened("/root.toml", {
      fs,
      env: {},
      inputs: { amount: 250 },
    });
    expect(loaded.flow.steps[0]).toMatchObject({ id: "child:read", input: { amount: 250 } });
  });
});

test("input binding rejects nested non-JSON values, cycles, and prototype hazards", () => {
  const declared = { data: { type: "object" as const } };
  expect(() => bindInputs(declared, { data: { value: Infinity } })).toThrow("INPUT_JSON");
  expect(() => bindInputs(declared, { data: { value: NaN } })).toThrow("INPUT_JSON");
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => bindInputs(declared, { data: cycle } as never)).toThrow("INPUT_JSON");
  expect(() => bindInputs(declared, { data: new Date() } as never)).toThrow("INPUT_JSON");
  expect(() =>
    bindInputs(declared, JSON.parse('{"data":{"__proto__":{"polluted":true}}}')),
  ).toThrow("INPUT_JSON");
});

test("child caller override does not require an unavailable declaration default", async () => {
  const fs = memoryFileSystem();
  await fs.writeTextFile(
    "/root.toml",
    'version=1\nkind="flow"\nid="root"\ndescription="root"\n[[steps]]\nid="child"\ndo="run"\nflow="child.toml"\n[steps.with]\nname="supplied"\n',
  );
  await fs.writeTextFile(
    "/child.toml",
    'version=1\nkind="flow"\nid="child"\ndescription="child"\n[inputs.name]\ntype="string"\ndefault="${env.MISSING}"\n[[steps]]\nid="open"\ndo="goto"\nurl="https://example.test/${inputs.name}"\n',
  );
  const loaded = await loadFlowFileFlattened("/root.toml", { fs, env: {} });
  expect(loaded.flow.steps[0]).toMatchObject({ url: "https://example.test/supplied" });
});
