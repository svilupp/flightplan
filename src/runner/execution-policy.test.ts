import { expect, test } from "bun:test";
import { memoryFileSystem } from "../adapters/memory.ts";
import { createAiRuntime } from "../ai/runtime.ts";
import { resolveConfigWithDefaults } from "../config/resolve.ts";
import type { Config } from "../config/types.ts";
import { MockDriver } from "../driver/mock-driver.ts";
import { runFlow } from "./runner.ts";

const header = 'version=1\nkind="flow"\nid="policy"\ndescription="policy"\n';

for (const hook of ["setup", "teardown"]) {
  test.each(["/", "/flows/"])(
    `${hook} at %s executes its preflight source even if the file changes`,
    async (base) => {
      const fs = memoryFileSystem();
      const hookSource = header + '[[steps]]\nid="key"\ndo="press"\nkey="Escape"';
      await fs.writeTextFile(`${base}hook.toml`, hookSource);
      const driver = new MockDriver();
      const connect = driver.connect.bind(driver);
      driver.connect = async (config) => {
        await fs.writeTextFile(`${base}hook.toml`, hookSource.replace("Escape", "Enter"));
        await connect(config);
      };
      const result = await runFlow({
        flowPath: `${base}flow.toml`,
        flowSource: header + `${hook}="./hook.toml"\n[[steps]]\nid="wait"\ndo="wait"\nms=0`,
        fs,
        out: "/runs",
        config: resolveConfigWithDefaults([]),
        env: {},
        driverFactory: () => driver,
      });
      expect(result.summary).toMatchObject({ verdict: "passed" });
      expect(driver.callsTo("press").map((call) => call.args[0])).toEqual(["Escape"]);
    },
  );
}

test("ambient keys and injected AI factories do not grant permission", async () => {
  const driver = new MockDriver();
  let factories = 0;
  const result = await runFlow({
    flowPath: "/flow.toml",
    flowSource: header + '[[steps]]\nid="wait"\ndo="wait"\nms=0',
    fs: memoryFileSystem(),
    out: "/runs",
    config: resolveConfigWithDefaults([]),
    env: { OPENROUTER_API_KEY: "fake", TYPESAFE_API_KEY: "fake" },
    driverFactory: () => driver,
    aiRuntimeFactory: () => {
      factories++;
      throw new Error("factory must not be called");
    },
  });
  expect(result.summary.verdict).toBe("passed");
  expect(factories).toBe(0);
  expect(driver.callsTo("screenshot")).toHaveLength(0);
});

test("AI assertions in a callable child fail before browser acquisition", async () => {
  const fs = memoryFileSystem();
  await fs.writeTextFile(
    "/child.toml",
    header.replace('id="policy"', 'id="child"') +
      '[[steps]]\nid="judge"\ndo="assert"\n[[steps.assert]]\ntype="ai_judge"\nprompt="Ready?"',
  );
  let acquired = 0;
  await expect(
    runFlow({
      flowPath: "/flow.toml",
      flowSource: header + '[[steps]]\nid="child"\ndo="run"\nflow="./child.toml"',
      fs,
      out: "/runs",
      config: resolveConfigWithDefaults([]),
      env: {},
      driverFactory: () => {
        acquired++;
        return new MockDriver();
      },
    }),
  ).rejects.toMatchObject({ code: "AI_DISABLED" });
  expect(acquired).toBe(0);
});

for (const config of [
  { plan: { enabled: true } },
  { ai: { classifier: "heuristic" } },
  { ai: { jev: { profile: "text" } } },
  {
    guard: {
      mode: "shadow",
      policy: "Allow reads",
      policy_version: "v1",
      images: "deny",
      api_key_env: "TYPESAFE_API_KEY",
      timeout_ms: 100,
      max_evaluations: 1,
    },
  },
] satisfies Config[]) {
  test(`explicit AI configuration fails before acquisition: ${JSON.stringify(config)}`, async () => {
    let acquired = 0;
    await expect(
      runFlow({
        flowPath: "/flow.toml",
        flowSource: header + '[[steps]]\nid="wait"\ndo="wait"\nms=0',
        fs: memoryFileSystem(),
        out: "/runs",
        config: resolveConfigWithDefaults([config]),
        env: {},
        driverFactory: () => {
          acquired++;
          return new MockDriver();
        },
      }),
    ).rejects.toMatchObject({ code: "AI_DISABLED" });
    expect(acquired).toBe(0);
  });
}

for (const hook of ["setup", "teardown"]) {
  test(`AI assertions in ${hook} boundaries fail before acquisition`, async () => {
    const fs = memoryFileSystem();
    await fs.writeTextFile(
      "/hook.toml",
      header + 'before=[{type="ai_judge",prompt="Ready?"}]\n[[steps]]\nid="wait"\ndo="wait"\nms=0',
    );
    let acquired = 0;
    await expect(
      runFlow({
        flowPath: "/flow.toml",
        flowSource: header + `${hook}="./hook.toml"\n[[steps]]\nid="wait"\ndo="wait"\nms=0`,
        fs,
        out: "/runs",
        config: resolveConfigWithDefaults([]),
        env: {},
        driverFactory: () => {
          acquired++;
          return new MockDriver();
        },
      }),
    ).rejects.toMatchObject({ code: "AI_DISABLED" });
    expect(acquired).toBe(0);
  });
}

for (const run of [{ max_model_calls: 0 }, { max_cost_usd: 0 }]) {
  test(`zero budget blocks an injected extraction mapper: ${JSON.stringify(run)}`, async () => {
    let mappings = 0;
    const driver = Object.assign(new MockDriver(), {
      extractionCandidates: async () => [{ selector: ".price", text: "10" }],
    });
    const result = await runFlow({
      flowPath: "/flow.toml",
      flowSource:
        header +
        '[[steps]]\nid="read"\ndo="extract"\nselector=".row"\n[steps.fields.price]\ndescription="Price"\nsource="text"\ntype="number"',
      fs: memoryFileSystem(),
      out: "/runs",
      config: resolveConfigWithDefaults([{ ai: { enabled: true }, run }]),
      env: {},
      driverFactory: () => driver,
      extractionMapper: async () => {
        mappings++;
        return { price: ".price" };
      },
    });
    expect(result.summary.verdict).toBe("inconclusive");
    expect(mappings).toBe(0);
  });
}

for (const run of [{ max_model_calls: 0 }, { max_cost_usd: 0 }, { max_screenshots: 0 }]) {
  test(`zero budget rejects a screenshot judge before capture: ${JSON.stringify(run)}`, async () => {
    let calls = 0;
    const driver = new MockDriver();
    const result = await runFlow({
      flowPath: "/flow.toml",
      flowSource:
        header +
        '[[steps]]\nid="judge"\ndo="assert"\n[[steps.assert]]\ntype="ai_judge"\ninputs=["screenshot"]\nprompt="Ready?"',
      fs: memoryFileSystem(),
      out: "/runs",
      config: resolveConfigWithDefaults([{ ai: { enabled: true }, run }]),
      env: {},
      driverFactory: () => driver,
      aiRuntimeFactory: (deps) =>
        createAiRuntime({
          ...deps,
          generate: async () => {
            calls++;
            throw new Error("must not generate");
          },
        }),
    });
    expect(result.summary.verdict).toBe("inconclusive");
    expect(calls).toBe(0);
    expect(driver.callsTo("screenshot")).toHaveLength(0);
  });
}
