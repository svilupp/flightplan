import { expect, test } from "bun:test";
import { memoryFileSystem } from "../adapters/memory.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import { MockDriver } from "../driver/index.ts";
import { runFlow } from "./runner.ts";

const head = 'version=1\nkind="flow"\nid="bound"\ndescription="bound"\n';
const bad =
  '[inputs.payload]\ntype="object"\nrequired=true\n[[steps]]\nid="prior"\ndo="goto"\nurl="https://example.test/prior"\n[[steps]]\nid="bad"\ndo="goto"\nurl="${inputs.payload}"\n';
for (const placement of ["root", "child", "setup", "teardown"] as const) {
  test(`bound object in scalar ${placement} action fails before acquisition without value disclosure`, async () => {
    const fs = memoryFileSystem();
    const driver = new MockDriver();
    let acquisitions = 0;
    const canary = "novel-secret-bound-canary";
    let source = bad;
    const hook = bad.replace("required=true", 'default={value="novel-secret-bound-canary"}');
    if (placement === "child") {
      await fs.writeTextFile("/child.toml", head + bad);
      source =
        '[inputs.payload]\ntype="object"\nrequired=true\n[[steps]]\nid="child"\ndo="run"\nflow="./child.toml"\n[steps.with]\npayload="${inputs.payload}"\n';
    } else if (placement !== "root") {
      await fs.writeTextFile("/hook.toml", head + hook);
      source = `${placement}="./hook.toml"\n[[steps]]\nid="root"\ndo="goto"\nurl="https://example.test/root"\n`;
    }
    let message = "";
    try {
      await runFlow({
        flowPath: "/root.toml",
        flowSource: head + source,
        inputs:
          placement === "root" || placement === "child"
            ? { payload: { value: canary } }
            : undefined,
        env: {},
        fs,
        config: resolveConfigWithDefaults([]),
        driverFactory: () => {
          acquisitions++;
          return driver;
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "unexpected";
    }
    expect(message).toContain("BOUND_STEP_INVALID");
    expect(message).not.toContain(canary);
    expect(acquisitions).toBe(0);
    expect(driver.callsTo("goto")).toHaveLength(0);
  });
}

test("bound structured WebMCP arguments remain JSON values", async () => {
  const fs = memoryFileSystem();
  const driver = new MockDriver().setWebmcpResult({
    ok: true,
    phase: "invoke",
    dispatchState: "dispatched",
    retrySafe: false,
    result: { ok: true },
  });
  const result = await runFlow({
    flowPath: "/root.toml",
    flowSource:
      head +
      '[inputs.payload]\ntype="object"\nrequired=true\n[[steps]]\nid="read"\ndo="webmcp_call"\ntool="read"\ninput={payload="${inputs.payload}"}\neffect="observe"\n',
    inputs: { payload: { enabled: true, ids: [1, 2] } },
    fs,
    env: {},
    config: resolveConfigWithDefaults([]),
    driverFactory: () => driver,
    noLockWrite: true,
  });
  expect(result.summary.verdict).toBe("passed");
  expect(driver.callsTo("webmcpCall")[0]?.args[0]).toMatchObject({
    input: { payload: { enabled: true, ids: [1, 2] } },
  });
});

test("bound numeric result conditions retain finite typed input comparisons", async () => {
  const driver = new MockDriver().setExtractResult([{ price: 101 }]);
  const result = await runFlow({
    flowPath: "/root.toml",
    flowSource:
      head +
      '[inputs.minimum]\ntype="number"\nrequired=true\n[[steps]]\nid="read"\ndo="extract"\nselector=".row"\n[steps.fields.price]\nselector=".price"\nsource="text"\ntype="number"\n[[after]]\ntype="result"\nstep="read"\npath="0.price"\ngt="${inputs.minimum}"\n',
    inputs: { minimum: 100 },
    env: {},
    fs: memoryFileSystem(),
    config: resolveConfigWithDefaults([]),
    driverFactory: () => driver,
    noLockWrite: true,
  });
  expect(result.summary.verdict).toBe("passed");
});
