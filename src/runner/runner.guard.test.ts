import { expect, test } from "bun:test";
import { memoryFileSystem } from "../adapters/memory.ts";
import { resolveConfigWithDefaults } from "../config/resolve.ts";
import { MockDriver } from "../driver/mock-driver.ts";
import {
  makeInteractiveElement,
  makeRankedCandidate,
  makeSnapshot,
} from "../driver/mock-fixtures.ts";
import type { ActionGuardOptions } from "../guard/types.ts";
import { memoryCheckpointStore, type YieldHost } from "./checkpoints.ts";
import { runFlow } from "./runner.ts";

async function run(step: string, guard?: ActionGuardOptions, yieldHost?: YieldHost, lax = false) {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  driver.setSnapshot(
    makeSnapshot({
      url: "about:blank",
      interactiveElements: [
        makeInteractiveElement({
          ref: "e1",
          role: "button",
          name: "Action",
          attributes: { id: "action" },
        }),
      ],
    }),
  );
  driver.setResolveAll([
    makeRankedCandidate({ ref: "e1", role: "button", name: "Action", selector: "#action" }),
  ]);
  driver.setEvaluateResult(true);
  driver.setWebmcpResult({
    ok: true,
    result: {},
    phase: "invoke",
    retrySafe: false,
    dispatchState: "dispatched",
  });
  const result = await runFlow({
    flowPath: "/flow.toml",
    flowSource: `version=1\nkind="flow"\nid="guard"\ndescription="guard"\n${step}`,
    config: resolveConfigWithDefaults([
      {
        timeouts: { settle_ms: 0 },
        run: {
          assertions: lax ? "deferred" : "eager",
          fail_on_assertion: !lax,
          assert_timeout_ms: 1,
        },
      },
    ]),
    fs,
    out: "/runs",
    env: {},
    driverFactory: () => driver,
    actionGuard: guard,
    yieldHost,
  });
  return { result, driver, fs };
}
for (const [name, step, method] of [
  ["click", '[[steps]]\nid="action"\ndo="click"\ntarget="Action"', "batch"],
  ["fill", '[[steps]]\nid="action"\ndo="fill"\ntarget="Action"\nvalue="text"', "batch"],
  ["press", '[[steps]]\nid="action"\ndo="press"\nkey="Enter"', "press"],
  ["goto", '[[steps]]\nid="action"\ndo="goto"\nurl="https://example.com"', "goto"],
  [
    "evaluate",
    '[[steps]]\nid="action"\ndo="evaluate"\nexpression="1"\neffect="observe"',
    "evaluateExpression",
  ],
  ["eval", '[[steps]]\nid="action"\ndo="eval"\nscript="1"\neffect="observe"', "evalInFrame"],
  [
    "webmcp",
    '[[steps]]\nid="action"\ndo="webmcp_call"\ntool="read"\neffect="observe"',
    "webmcpCall",
  ],
] as const) {
  test(`runFlow guard deny reports no dispatch for ${name}`, async () => {
    const { result, driver } = await run(step, {
      mode: "enforce",
      policyVersion: "v1",
      evaluate: async () => ({ decision: "deny", reason: "denied" }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(driver.calls.filter((call) => call.method === method)).toHaveLength(0);
    expect(result.summary.steps[0]?.dispatchState).toBe("not_dispatched");
  });
}
test("runFlow shadow records separate guard decisions and preserves action", async () => {
  const { result, driver, fs } = await run('[[steps]]\nid="enter"\ndo="press"\nkey="Enter"', {
    mode: "shadow",
    policyVersion: "v1",
    evaluate: async () => ({ decision: "deny", reason: "denied" }),
  });
  expect(result.exitCode).toBe(0);
  expect(driver.callsTo("press")).toHaveLength(1);
  const trace = await fs.readTextFile(`${result.runDir}/trace.jsonl`);
  expect(trace).toContain('"type":"guard_decision"');
  expect(trace).toContain('"decision":"deny"');
});
test("configured global guard is active without an injected API hook", async () => {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  const result = await runFlow({
    flowPath: "/flow.toml",
    flowSource:
      'version=1\nkind="flow"\nid="configured"\ndescription="configured"\n[[steps]]\nid="enter"\ndo="press"\nkey="Enter"',
    fs,
    out: "/runs",
    env: {},
    driverFactory: () => driver,
    config: resolveConfigWithDefaults([
      {
        guard: {
          mode: "enforce",
          policy: "No actions",
          policy_version: "v1",
          api_key_env: "MISSING",
          images: "deny",
          timeout_ms: 100,
          max_evaluations: 1,
        },
      },
    ]),
  });
  expect(result.exitCode).not.toBe(0);
  expect(driver.callsTo("press")).toHaveLength(0);
  expect(result.summary.steps[0]?.dispatchState).toBe("not_dispatched");
  expect(await fs.readTextFile(`${result.runDir}/trace.jsonl`)).toContain(
    "credentials_unavailable",
  );
});
test("runFlow yield invokes bounded host control before authored return assertions", async () => {
  const calls: string[] = [];
  const host: YieldHost = {
    store: memoryCheckpointStore(),
    binding: "caller-v1",
    currentIdentity: async () => ({ ownerEpoch: "one", grantToken: "old", pageIdentity: "page" }),
    releaseFlightplan: async () => {
      calls.push("release_fp");
    },
    acquireHost: async () => {
      calls.push("acquire_host");
    },
    perform: async () => {
      calls.push("perform");
      return { pageIdentity: "page" };
    },
    releaseHost: async () => {
      calls.push("release_host");
    },
    acquireFlightplan: async () => ({ ownerEpoch: "one", grantToken: "new", pageIdentity: "page" }),
    refresh: async () => {
      calls.push("refresh");
    },
    verifyReturn: async () => true,
  };
  const { result } = await run(
    '[[steps]]\nid="host"\ndo="yield"\ntask="Find order"\n[[steps.assert]]\ntype="url"\nurl="about:blank"\nmatch="exact"',
    undefined,
    host,
  );
  expect(result.exitCode).toBe(0);
  expect(calls).toEqual(["release_fp", "acquire_host", "perform", "release_host", "refresh"]);
});

test("failed authored yield return checks block lax runs and prohibit host replay", async () => {
  let performed = 0;
  const host: YieldHost = {
    store: memoryCheckpointStore(),
    binding: "caller",
    currentIdentity: async () => ({ ownerEpoch: "one", grantToken: "old", pageIdentity: "page" }),
    releaseFlightplan: async () => {},
    acquireHost: async () => {},
    perform: async () => {
      performed++;
      return { pageIdentity: "page" };
    },
    releaseHost: async () => {},
    acquireFlightplan: async () => ({ ownerEpoch: "one", grantToken: "new", pageIdentity: "page" }),
    refresh: async () => {},
    verifyReturn: async () => true,
  };
  const { result, driver } = await run(
    '[[steps]]\nid="host"\ndo="yield"\ntask="Open order"\n[[steps.assert]]\ntype="url"\nurl="https://wrong.example"\nmatch="exact"\ntimeout_ms=1\n[[steps]]\nid="must_not_run"\ndo="press"\nkey="Enter"',
    undefined,
    host,
    true,
  );
  expect(result.summary.verdict).toBe("failed");
  expect(performed).toBe(1);
  expect(driver.callsTo("press")).toHaveLength(0);
  expect(result.summary.steps[0]?.dispatchState).toBe("dispatched");
});

test("yield authoring rejects self replay and missing effective return assertions", async () => {
  const { YieldStepSchema } = await import("../flow/schema.ts");
  expect(
    YieldStepSchema.safeParse({
      id: "host",
      do: "yield",
      task: "task",
      on_fail: { goto: "self" },
      assert: [{ type: "url", url: "https://example.com" }],
    }).success,
  ).toBe(false);
  expect(
    YieldStepSchema.safeParse({
      id: "host",
      do: "yield",
      task: "task",
      assert: [{ type: "url", url: "https://example.com", when: "before" }],
    }).success,
  ).toBe(false);
});

test("native shadow images never capture post-dispatch browser pixels", async () => {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  let captures = 0;
  Object.assign(driver, {
    captureJevEvidence: async () => {
      captures++;
      throw new Error("unexpected capture");
    },
  });
  const result = await runFlow({
    flowPath: "/flow.toml",
    flowSource:
      'version=1\nkind="flow"\nid="shadow_images"\ndescription="shadow_images"\n[[steps]]\nid="enter"\ndo="press"\nkey="Enter"',
    fs,
    out: "/runs",
    env: { FAKE_GUARD_KEY: "fake" },
    driverFactory: () => driver,
    config: resolveConfigWithDefaults([
      {
        guard: {
          mode: "shadow",
          policy: "read",
          policy_version: "v1",
          api_key_env: "FAKE_GUARD_KEY",
          images: "allow",
          timeout_ms: 100,
          max_evaluations: 1,
        },
      },
    ]),
  });
  expect(result.exitCode).toBe(0);
  expect(driver.callsTo("press")).toHaveLength(1);
  expect(captures).toBe(0);
  expect(await fs.readTextFile(`${result.runDir}/trace.jsonl`)).toContain('"decision":"unknown"');
});
