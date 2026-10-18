import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../assert/clock.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import { MockDriver } from "../driver/index.ts";
import { runFlow } from "./runner.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
const header = 'version=1\nkind="flow"\nid="recipes"\ndescription="recipes"\n';
async function run(source: string, driver = new MockDriver()) {
  const dir = await mkdtemp(join(tmpdir(), "fp-recipes-"));
  dirs.push(dir);
  await Bun.write(join(dir, "flow.toml"), header + source);
  return runFlow({
    flowPath: join(dir, "flow.toml"),
    out: join(dir, "runs"),
    config: resolveConfigWithDefaults([
      { run: { assertions: "deferred", fail_on_assertion: false, assert_timeout_ms: 1 } },
    ]),
    driverFactory: () => driver,
    clock: new FakeClock(),
    env: {},
    noLockWrite: true,
  });
}
test("required entry blocks even when optional assertions are deferred warnings", async () => {
  const driver = new MockDriver();
  const result = await run(
    '[[before]]\ntype="url"\nurl="https://required.example"\nmatch="exact"\n[[steps]]\nid="navigate"\ndo="goto"\nurl="https://other.example"',
    driver,
  );
  expect(result.summary.verdict).toBe("failed");
  expect(result.summary.invocation_status).toBe("not_started");
  expect(driver.callsTo("goto")).toHaveLength(0);
});
test("extract returns typed outputs after numeric outcome proof", async () => {
  const driver = new MockDriver().setExtractResult([{ price: 101 }]);
  const result = await run(
    '[outputs.products]\nstep="read"\n[[steps]]\nid="read"\ndo="extract"\nselector=".product"\n[steps.fields.price]\nselector=".price"\nsource="text"\ntype="number"\n[[steps.assert]]\ntype="result"\npath="0.price"\ngt=100\n[[after]]\ntype="result"\nstep="read"\npath="0.price"\ngt=100',
    driver,
  );
  expect(result.summary).toMatchObject({ verdict: "passed" });
  expect(result.summary.outputs).toEqual({ products: [{ price: 101 }] });
});
test("required outcome fails numeric boundary and publishes no outputs", async () => {
  const driver = new MockDriver().setExtractResult([{ price: 100 }]);
  const result = await run(
    '[outputs.products]\nstep="read"\n[[steps]]\nid="read"\ndo="extract"\nselector=".product"\n[steps.fields.price]\nselector=".price"\nsource="text"\ntype="number"\n[[after]]\ntype="result"\nstep="read"\npath="0.price"\ngt=100',
    driver,
  );
  expect(result.summary.verdict).toBe("failed");
  expect(result.summary.outputs).toBeUndefined();
});
test("extract rejects malformed driver data rather than coercing numbers", async () => {
  const result = await run(
    '[[steps]]\nid="read"\ndo="extract"\nselector=".product"\n[steps.fields.price]\nselector=".price"\nsource="text"\ntype="number"',
    new MockDriver().setExtractResult([{ price: "101" }]),
  );
  expect(result.summary.verdict).toBe("failed");
});
test("nested child entry is checked before any child action on every invocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-nested-recipes-"));
  dirs.push(dir);
  await Bun.write(
    join(dir, "child.toml"),
    header.replace('id="recipes"', 'id="child"') +
      '[[before]]\ntype="url"\nurl="https://expected.example"\nmatch="exact"\n[[steps]]\nid="mutate"\ndo="press"\nkey="Enter"\neffect="at_most_once"',
  );
  await Bun.write(
    join(dir, "flow.toml"),
    header + '[[steps]]\nid="child"\ndo="run"\nflow="./child.toml"',
  );
  for (let i = 0; i < 2; i++) {
    const driver = new MockDriver();
    const result = await runFlow({
      flowPath: join(dir, "flow.toml"),
      out: join(dir, "runs"),
      config: resolveConfigWithDefaults([
        { run: { fail_on_assertion: false, assertions: "deferred", assert_timeout_ms: 1 } },
      ]),
      driverFactory: () => driver,
      clock: new FakeClock(),
      env: {},
      noLockWrite: true,
    });
    expect(result.summary.verdict).toBe("failed");
    expect(result.summary.failed_step).toBe("child:@flightplan:before");
    expect(driver.callsTo("press")).toHaveLength(0);
  }
});
test("missing output path fails required publication contract", async () => {
  const result = await run(
    '[outputs.orders]\nstep="read"\npath="missing"\n[[steps]]\nid="read"\ndo="extract"\nselector=".row"\n[steps.fields.id]\nselector="."\nsource="text"\ntype="string"',
    new MockDriver().setExtractResult([{ id: "42" }]),
  );
  expect(result.summary.verdict).toBe("failed");
  expect(result.summary.outputs).toBeUndefined();
});
test("secret extraction taints outputs and result captures", async () => {
  const result = await run(
    '[outputs.orders]\nstep="read"\n[[steps]]\nid="read"\ndo="extract"\nselector=".row"\ncapture={ name="token", type="result", path="0.id" }\n[steps.fields.id]\nselector="."\nsource="text"\ntype="string"\nsecret=true',
    new MockDriver().setExtractResult([{ id: "canary-raw-secret" }]),
  );
  expect(result.summary.outputs?.orders).toBe("«redacted»");
  expect(result.summary.captures?.token).toBe("«redacted»");
  expect(JSON.stringify(result.summary)).not.toContain("canary-raw-secret");
});
test("learned extraction map replays fresh rows without another mapper call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-map-recipes-"));
  dirs.push(dir);
  const flowPath = join(dir, "flow.toml");
  await Bun.write(
    flowPath,
    header +
      '[outputs.products]\nstep="read"\n[[steps]]\nid="read"\ndo="extract"\nselector=".row"\n[steps.fields.price]\ndescription="Price in USD"\nsource="text"\ntype="number"',
  );
  let mappings = 0;
  const driver = Object.assign(new MockDriver().setExtractResult([{ price: 101 }]), {
    extractionCandidates: async () => [{ selector: '[data-testid="price"]', text: "101" }],
  });
  const options = {
    flowPath,
    out: join(dir, "runs"),
    config: resolveConfigWithDefaults([]),
    driverFactory: () => driver,
    clock: new FakeClock(),
    env: {},
    extractionMapper: async () => {
      mappings++;
      return { price: '[data-testid="price"]' };
    },
  };
  const cold = await runFlow(options);
  expect(cold.summary.outputs).toEqual({ products: [{ price: 101 }] });
  const lockPath = join(dir, "flow.lock.toml");
  const lock = await Bun.file(lockPath).text();
  expect(lock).toContain("extractions");
  expect(lock).not.toContain("price = 101");
  driver.setExtractResult([{ price: 205 }, { price: 307 }]);
  const warm = await runFlow({ ...options, frozen: true, noLockWrite: true });
  expect(warm.summary.outputs).toEqual({ products: [{ price: 205 }, { price: 307 }] });
  expect(mappings).toBe(1);
  expect(await Bun.file(lockPath).text()).toBe(lock);
  driver.setStructureSignature("changed-layout");
  const drifted = await runFlow({ ...options, frozen: true, noLockWrite: true });
  expect(drifted.summary.verdict).toBe("failed");
  expect(mappings).toBe(1);
});
test("mapper document replacement is rejected before projection or lock promotion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-stale-map-"));
  dirs.push(dir);
  const flowPath = join(dir, "flow.toml");
  await Bun.write(
    flowPath,
    header +
      '[[steps]]\nid="read"\ndo="extract"\nselector=".row"\n[steps.fields.price]\nsource="text"\ntype="number"',
  );
  let generation = 1;
  let projections = 0;
  const driver = Object.assign(new MockDriver(), {
    documentIdentity: async () => `document-${generation}`,
    extractionCandidates: async () => [{ selector: ".price", text: "101" }],
    extract: async () => {
      projections++;
      return [{ price: 101 }];
    },
  });
  const result = await runFlow({
    flowPath,
    out: join(dir, "runs"),
    config: resolveConfigWithDefaults([]),
    driverFactory: () => driver,
    clock: new FakeClock(),
    env: {},
    extractionMapper: async () => {
      generation++;
      return { price: ".price" };
    },
  });
  expect(result.summary.verdict).toBe("failed");
  expect(projections).toBe(0);
  expect(await Bun.file(join(dir, "flow.lock.toml")).exists()).toBe(false);
});
test("novel secret extraction fields fail before candidate acquisition or mapping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-private-map-"));
  dirs.push(dir);
  const flowPath = join(dir, "flow.toml");
  await Bun.write(
    flowPath,
    header +
      '[[steps]]\nid="read"\ndo="extract"\nselector=".row"\n[steps.fields.token]\nsource="text"\ntype="string"\nsecret=true',
  );
  let candidateReads = 0;
  let modelCalls = 0;
  const driver = Object.assign(new MockDriver(), {
    extractionCandidates: async () => {
      candidateReads++;
      return [{ selector: ".token", text: "new-private-canary" }];
    },
  });
  const result = await runFlow({
    flowPath,
    out: join(dir, "runs"),
    config: resolveConfigWithDefaults([]),
    driverFactory: () => driver,
    clock: new FakeClock(),
    env: {},
    extractionMapper: async () => {
      modelCalls++;
      return { token: ".token" };
    },
  });
  expect(result.summary.verdict).toBe("failed");
  expect(candidateReads).toBe(0);
  expect(modelCalls).toBe(0);
  expect(JSON.stringify(result.summary)).not.toContain("new-private-canary");
});
test("same-document candidate meaning changes invalidate mapper evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-semantic-stale-map-"));
  dirs.push(dir);
  const flowPath = join(dir, "flow.toml");
  await Bun.write(
    flowPath,
    header +
      '[[steps]]\nid="read"\ndo="extract"\nselector=".row"\n[steps.fields.price]\nsource="text"\ntype="number"',
  );
  let text = "Price 101";
  let projections = 0;
  const driver = Object.assign(new MockDriver(), {
    extractionCandidates: async () => [{ selector: ".field", text }],
    extract: async () => {
      projections++;
      return [{ price: 101 }];
    },
  });
  const result = await runFlow({
    flowPath,
    out: join(dir, "runs"),
    config: resolveConfigWithDefaults([]),
    driverFactory: () => driver,
    clock: new FakeClock(),
    env: {},
    extractionMapper: async () => {
      text = "Refund total 101";
      return { price: ".field" };
    },
  });
  expect(result.summary.verdict).toBe("failed");
  expect(projections).toBe(0);
});
test("named output refuses nonfinite structured values", async () => {
  const driver = new MockDriver().setWebmcpResult({
    ok: true,
    phase: "invoke",
    dispatchState: "dispatched",
    retrySafe: false,
    result: { amount: Number.POSITIVE_INFINITY },
  });
  const result = await run(
    '[outputs.amount]\nstep="read"\npath="amount"\n[[steps]]\nid="read"\ndo="webmcp_call"\ntool="readAmount"\neffect="observe"',
    driver,
  );
  expect(result.summary.verdict).toBe("failed");
  expect(result.summary.outputs).toBeUndefined();
});
test("embedding cannot bypass nested entry contracts through flattened redirect IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-boundary-bypass-"));
  dirs.push(dir);
  await Bun.write(
    join(dir, "child.toml"),
    header.replace('id="recipes"', 'id="child"') +
      '[[before]]\ntype="url"\nurl="https://required.example"\n[[steps]]\nid="mutate"\ndo="press"\nkey="Enter"\neffect="at_most_once"',
  );
  const flowPath = join(dir, "flow.toml");
  await Bun.write(
    flowPath,
    header +
      '[[steps]]\nid="trigger"\ndo="assert"\non_fail={goto="child:mutate",max=1}\n[[steps.assert]]\ntype="url"\nurl="https://wrong.example"\n[[steps]]\nid="child"\ndo="run"\nflow="./child.toml"',
  );
  let factories = 0;
  const driver = new MockDriver();
  const failure = await runFlow({
    flowPath,
    out: join(dir, "runs"),
    config: resolveConfigWithDefaults([]),
    driverFactory: () => {
      factories++;
      return driver;
    },
    env: {},
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect((failure as Error).message).toContain("invocation boundary");
  expect(factories).toBe(0);
  expect(driver.callsTo("press")).toHaveLength(0);
});
test("setup results and secret captures cannot satisfy root output sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-hook-scope-"));
  dirs.push(dir);
  await Bun.write(
    join(dir, "setup.toml"),
    header.replace('id="recipes"', 'id="setup"') +
      '[[steps]]\nid="shared"\ndo="webmcp_call"\ntool="readSecret"\neffect="observe"\ncapture={name="hook_token",type="result",path="token",secret=true}',
  );
  const flowPath = join(dir, "flow.toml");
  await Bun.write(
    flowPath,
    header +
      'setup="./setup.toml"\n[outputs.token]\nstep="shared"\npath="token"\n[[steps]]\nid="idle"\ndo="wait"\nms=0',
  );
  const driver = new MockDriver().setWebmcpResult({
    ok: true,
    phase: "invoke",
    dispatchState: "dispatched",
    retrySafe: false,
    result: { token: "hook-secret-canary" },
  });
  const result = await runFlow({
    flowPath,
    out: join(dir, "runs"),
    config: resolveConfigWithDefaults([]),
    driverFactory: () => driver,
    clock: new FakeClock(),
    env: {},
    noLockWrite: true,
  });
  expect(result.summary.verdict).toBe("failed");
  expect(result.summary.outputs).toBeUndefined();
  expect(result.summary.captures?.hook_token).toBeUndefined();
  expect(JSON.stringify(result.summary)).not.toContain("hook-secret-canary");
});
test("authored internal boundary IDs are rejected before acquisition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-reserved-boundary-"));
  dirs.push(dir);
  const flowPath = join(dir, "flow.toml");
  await Bun.write(
    flowPath,
    header + '[[steps]]\nid="@flightplan:before"\ndo="press"\nkey="Enter"\neffect="at_most_once"',
  );
  let factories = 0;
  const failure = await runFlow({
    flowPath,
    out: join(dir, "runs"),
    config: resolveConfigWithDefaults([]),
    driverFactory: () => {
      factories++;
      return new MockDriver();
    },
    env: {},
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect((failure as Error).message).toContain("reserved");
  expect(factories).toBe(0);
  const { lintFile } = await import("../lint/lint.ts");
  const lint = await lintFile(flowPath);
  expect(lint.ok).toBe(false);
  expect(lint.diagnostics.some((diagnostic) => diagnostic.message.includes("reserved"))).toBe(true);
});
