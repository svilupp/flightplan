import { expect, test } from "bun:test";
import { memoryFileSystem } from "../adapters/memory.ts";
import { MockDriver } from "../driver/index.ts";
import {
  type CommandIO,
  executeCheck,
  executeDiscovery,
  executeRun,
  parseArgs,
} from "./commands.ts";

function context() {
  const fs = memoryFileSystem();
  const stdout: string[] = [],
    stderr: string[] = [];
  const driver = new MockDriver();
  let factories = 0;
  const io: CommandIO = {
    fs,
    cwd: "/flows",
    env: { TOKEN: "test-secret-canary" },
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    driverFactory: () => {
      factories++;
      return driver;
    },
  };
  return { io, stdout, stderr, driver, factories: () => factories };
}
const header = 'version=1\nkind="flow"\nid="recipe"\ndescription="Open an order"\n';
const go = '[[steps]]\nid="open"\ndo="goto"\nurl="https://example.test/${inputs.order}"\n';

test("CLI input assignment preserves equals and parses according to declared types", async () => {
  const c = context();
  await c.io.fs.writeTextFile(
    "/flows/flow.toml",
    `${header}[inputs.order]\ntype="string"\nrequired=true\n${go}`,
  );
  expect(
    (
      await executeRun(
        ["run", "flow.toml", "--input", "order=D=123", "--no-lock-write", "--json"],
        c.io,
      )
    ).exitCode,
  ).toBe(0);
  expect(c.driver.callsTo("goto")[0]?.args).toEqual(["https://example.test/D=123"]);
});
test("all input validation happens before driver creation", async () => {
  const c = context();
  await c.io.fs.writeTextFile(
    "/flows/flow.toml",
    header +
      '[inputs.order]\ntype="string"\nrequired=true\n[inputs.other]\ntype="boolean"\nrequired=true\n' +
      go,
  );
  expect((await executeRun(["run", "flow.toml", "--input", "typo=x"], c.io)).exitCode).toBe(2);
  expect(c.factories()).toBe(0);
  expect(c.stderr.join("\n")).toContain("INPUT_UNKNOWN");
  expect(c.stderr.join("\n")).toContain("INPUT_REQUIRED: order");
  expect(c.stderr.join("\n")).toContain("INPUT_REQUIRED: other");
});
test("declared secret references are redacted even without secret fill", async () => {
  const c = context();
  await c.io.fs.writeTextFile(
    "/flows/flow.toml",
    `${header}[inputs.order]\ntype="string"\nsecret=true\nrequired=true\n${go}`,
  );
  expect(
    (
      await executeRun(
        ["run", "flow.toml", "--input-env", "order=TOKEN", "--json", "--no-lock-write"],
        c.io,
      )
    ).exitCode,
  ).toBe(0);
  expect([...c.stdout, ...c.stderr].join("\n")).not.toContain("test-secret-canary");
  const summary = JSON.parse(c.stdout[0]!);
  for (const name of ["summary.json", "run.jsonl", "trace.jsonl"]) {
    const path = `${summary.run_dir}/${name}`;
    if (await c.io.fs.fileExists(path))
      expect(await c.io.fs.readTextFile(path)).not.toContain("test-secret-canary");
  }
});
test("JSON inputs file supports defaults and CLI precedence", async () => {
  const c = context();
  await c.io.fs.writeTextFile(
    "/flows/flow.toml",
    `${header}[inputs.order]\ntype="string"\ndefault="default"\n${go}`,
  );
  await c.io.fs.writeTextFile("/flows/params.json", '{"order":"file"}');
  expect(
    (
      await executeRun(
        [
          "run",
          "flow.toml",
          "--inputs-file",
          "params.json",
          "--input",
          "order=cli",
          "--no-lock-write",
        ],
        c.io,
      )
    ).exitCode,
  ).toBe(0);
  expect(c.driver.callsTo("goto")[0]?.args).toEqual(["https://example.test/cli"]);
});
test("catalogue stays offline and suppresses secret defaults", async () => {
  const c = context();
  await c.io.fs.writeTextFile(
    "/flows/a.toml",
    header +
      '[inputs.order]\ntype="string"\nrequired=true\n[inputs.token]\ntype="string"\nsecret=true\ndefault={from_env="MISSING"}\n' +
      go,
  );
  await c.io.fs.writeTextFile("/flows/b.toml", header + go);
  await c.io.fs.writeTextFile("/flows/config.toml", 'version=1\nkind="config"\n');
  expect((await executeDiscovery(["list", "/flows", "--json"], c.io)).exitCode).toBe(1);
  const result = JSON.parse(c.stdout[0]!);
  expect(result.recipes).toHaveLength(2);
  expect(result.recipes[0].inputs.token.default).toBeUndefined();
  expect(result.diagnostics[0].code).toBe("RECIPE_ID_DUPLICATE");
  expect(c.factories()).toBe(0);
});
test("CLI rejects duplicate input source and dangling flags", () => {
  expect(() => parseArgs(["run", "x", "--inputs-file", "a", "--inputs-file", "b"])).toThrow(
    "only be specified once",
  );
  expect(() => parseArgs(["run", "x", "--input", "--json"])).toThrow("requires a value");
});

test("inputs file rejects duplicate keys including escaped nested names", async () => {
  for (const text of ['{"order":"a","order":"b"}', '{"data":{"a":1,"\\u0061":2}}']) {
    const c = context();
    await c.io.fs.writeTextFile(
      "/flows/flow.toml",
      `${header}[inputs.order]\ntype="string"\n${go}`,
    );
    await c.io.fs.writeTextFile("/flows/params.json", text);
    expect(
      (await executeRun(["run", "flow.toml", "--inputs-file", "params.json"], c.io)).exitCode,
    ).toBe(2);
    expect(c.factories()).toBe(0);
    expect(c.stderr.join("\n")).toContain("duplicate object keys");
  }
});

test("caller template tokens remain literal through a child invocation", async () => {
  const c = context();
  await c.io.fs.writeTextFile(
    "/flows/flow.toml",
    header +
      '[inputs.order]\ntype="string"\nrequired=true\n[[steps]]\nid="child"\ndo="run"\nflow="child.toml"\n[steps.with]\norder="${inputs.order}"\n',
  );
  await c.io.fs.writeTextFile(
    "/flows/child.toml",
    header.replace('id="recipe"', 'id="child"') +
      '[inputs.order]\ntype="string"\nrequired=true\n' +
      go,
  );
  expect(
    (
      await executeRun(
        ["run", "flow.toml", "--input", "order=${env.TOKEN}", "--no-lock-write"],
        c.io,
      )
    ).exitCode,
  ).toBe(0);
  expect(c.driver.callsTo("goto")[0]?.args[0]).toBe("https://example.test/${env.TOKEN}");
});

test("check borrows an explicit session, inspects entry, and marks later states unchecked", async () => {
  const c = context();
  let detached = 0,
    handedBack = 0;
  await c.io.fs.writeTextFile(
    "/flows/check.toml",
    `${header}[[before]]\ntype="url"\nurl="https://example.test/start"\nmatch="exact"\n[[steps]]\nid="open"\ndo="goto"\nurl="https://example.test/next"\n[[steps]]\nid="later"\ndo="wait"\nms=1\n`,
  );
  const page = {
    targetId: "page-1",
    onDialog: async () => {},
    getCurrentFrame: () => null,
    url: async () => "https://example.test/start",
    snapshot: async () => ({
      url: "https://example.test/start",
      text: "",
      interactiveElements: [],
      accessibilityTree: { role: "RootWebArea", name: "" },
    }),
    goto: async () => {
      throw new Error("mutator called");
    },
  };
  c.io.namedSessionBorrower = async () => ({
    protocolVersion: 1,
    ownerEpoch: "owner",
    fencingToken: "grant-1",
    exclusive: true,
    capabilities: { ownerProtocolVersion: 2, rawCompatibility: true, nativeAtomic: false },
    page: page as never,
    browser: { listTargets: async () => [{ targetId: "page-1", type: "page" }] } as never,
    handback: async () => {
      handedBack++;
      return {
        confirmed: true,
        ownerEpoch: "owner",
        targetId: "page-1",
        refsInvalidated: true,
        pendingActions: "drained",
        bindingRevision: 1,
        observationEpoch: "observation-1",
      };
    },
    detach: async () => {
      detached++;
    },
  });
  const checked = await executeCheck(["check", "check.toml", "--session", "work", "--json"], c.io);
  expect({ code: checked.exitCode, output: c.stdout, errors: c.stderr }).toMatchObject({ code: 0 });
  const report = JSON.parse(c.stdout[0]!);
  expect(report.items).toContainEqual(
    expect.objectContaining({ code: "ENTRY_CONDITION", status: "verified" }),
  );
  expect(report.items).toContainEqual(
    expect.objectContaining({ code: "LATER_STATE_UNCHECKED", status: "unchecked", step: "later" }),
  );
  expect(detached).toBe(1);
  expect(handedBack).toBe(1);
  expect(c.factories()).toBe(0);
});

test("check reports static-only unknown when no session is selected", async () => {
  const c = context();
  await c.io.fs.writeTextFile(
    "/flows/check.toml",
    `${header}[[steps]]\nid="open"\ndo="goto"\nurl="https://example.test/"\n`,
  );
  expect((await executeCheck(["check", "check.toml", "--json"], c.io)).exitCode).toBe(1);
  expect(JSON.parse(c.stdout[0]!).items[0].code).toBe("SESSION_REQUIRED");
  expect(c.factories()).toBe(0);
});

test("session handback is persisted with the original idempotent CLI result", async () => {
  const { MemoryInvocationStore } = await import("../invocation/index.ts");
  const c = context();
  let borrows = 0,
    detaches = 0;
  c.io.invocationStore = new MemoryInvocationStore();
  await c.io.fs.writeTextFile(
    "/flows/session.toml",
    `${header}[[steps]]\nid="observe"\ndo="wait"\nms=0\n`,
  );
  c.io.namedSessionBorrower = async () => {
    borrows++;
    return {
      protocolVersion: 1,
      ownerEpoch: "owner",
      fencingToken: String(borrows),
      exclusive: true,
      capabilities: { ownerProtocolVersion: 2, rawCompatibility: true, nativeAtomic: false },
      page: { targetId: "page", onDialog: async () => {} } as never,
      browser: { listTargets: async () => [{ targetId: "page", type: "page" }] } as never,
      handback: async () => ({
        confirmed: true,
        ownerEpoch: "owner",
        targetId: "page",
        refsInvalidated: true,
        pendingActions: "drained",
        bindingRevision: 1,
        observationEpoch: "observation-1",
      }),
      detach: async () => {
        detaches++;
      },
    };
  };
  const args = [
    "run",
    "session.toml",
    "--session",
    "work",
    "--idempotency-key",
    "observe-once",
    "--json",
    "--no-lock-write",
  ];
  expect((await executeRun(args, c.io)).exitCode).toBe(0);
  expect((await executeRun(args, c.io)).exitCode).toBe(0);
  expect(c.stdout[1]).toBe(c.stdout[0]);
  expect(JSON.parse(c.stdout[0]!).session_handback).toMatchObject({
    status: "verified",
    target_id: "page",
  });
  expect(borrows).toBe(1);
  expect(detaches).toBe(1);
});

test("check does not print a successful report when owner handback fails", async () => {
  const c = context();
  let detaches = 0;
  await c.io.fs.writeTextFile(
    "/flows/check.toml",
    `${header}[[steps]]\nid="observe"\ndo="wait"\nms=0\n`,
  );
  c.io.namedSessionBorrower = async () => ({
    protocolVersion: 1,
    ownerEpoch: "owner",
    fencingToken: "grant",
    exclusive: true,
    capabilities: { ownerProtocolVersion: 2, rawCompatibility: true, nativeAtomic: false },
    page: { targetId: "page", onDialog: async () => {} } as never,
    browser: { listTargets: async () => [{ targetId: "page", type: "page" }] } as never,
    handback: async () => {
      throw new Error("owner unavailable");
    },
    detach: async () => {
      detaches++;
    },
  });
  expect(
    (await executeCheck(["check", "check.toml", "--session", "work", "--json"], c.io)).exitCode,
  ).toBe(2);
  expect(JSON.parse(c.stdout[0]!).ok).toBe(false);
  expect(JSON.parse(c.stdout[0]!).diagnostics[0].code).toBe("CHECK_UNAVAILABLE");
  expect(detaches).toBe(1);
});

test("JSON check binding failures aggregate diagnostics without connecting", async () => {
  const c = context();
  await c.io.fs.writeTextFile(
    "/flows/check.toml",
    `${header}[inputs.order]\ntype="string"\nrequired=true\n${go}`,
  );
  expect(
    (await executeCheck(["check", "check.toml", "--input", "typo=value", "--json"], c.io)).exitCode,
  ).toBe(2);
  const errors = JSON.parse(c.stdout[0]!).diagnostics;
  expect(errors.map((issue: { code: string }) => issue.code)).toEqual([
    "INPUT_UNKNOWN",
    "INPUT_REQUIRED",
  ]);
  expect(c.stderr).toHaveLength(0);
  expect(c.factories()).toBe(0);
});

test("JSON discovery and lint usage failures remain machine-readable", async () => {
  const { executeLint } = await import("./commands.ts");
  for (const [command, execute] of [
    ["list", executeDiscovery],
    ["describe", executeDiscovery],
    ["lint", executeLint],
  ] as const) {
    const c = context();
    expect((await execute([command, "--json"], c.io)).exitCode).toBe(2);
    expect(JSON.parse(c.stdout[0]!).diagnostics).toHaveLength(1);
    expect(c.stderr).toHaveLength(0);
  }
});

test("catalogue validates dependency structure without binding required child inputs", async () => {
  const c = context();
  await c.io.fs.writeTextFile(
    "/flows/root.toml",
    header + 'imports=["./child.toml","./missing.toml"]\n' + go,
  );
  await c.io.fs.writeTextFile(
    "/flows/child.toml",
    header.replace('id="inputs"', 'id="child"') +
      '[inputs.required]\ntype="string"\nrequired=true\n[[steps]]\nid="choice"\ndo="click"\ntarget="Fresh product"\nresolve="ai"\neffect="idempotent"\n',
  );
  const result = await executeDiscovery(["describe", "/flows/root.toml", "--json"], c.io);
  expect(result.exitCode).toBe(1);
  const report = JSON.parse(c.stdout[0]!);
  expect(report.recipes).toHaveLength(1);
  expect(report.recipes[0].capabilities.ai).toBe(true);
  expect(report.diagnostics).toEqual([
    expect.objectContaining({ code: "RECIPE_DEPENDENCY_INVALID", file: "/flows/missing.toml" }),
  ]);
  expect(c.factories()).toBe(0);
});

test("catalogue reports cycles and fresh semantic or learned extraction AI requirements", async () => {
  const c = context();
  await c.io.fs.writeTextFile("/flows/root.toml", header + 'imports="./child.toml"\n' + go);
  await c.io.fs.writeTextFile(
    "/flows/child.toml",
    header +
      'imports="./root.toml"\n[[steps]]\nid="read"\ndo="extract"\nselector=".row"\n[steps.fields.price]\ntype="number"\nsource="text"\n',
  );
  expect((await executeDiscovery(["describe", "/flows/root.toml", "--json"], c.io)).exitCode).toBe(
    1,
  );
  const report = JSON.parse(c.stdout[0]!);
  expect(report.recipes[0].capabilities.ai).toBe(true);
  expect(report.diagnostics[0].code).toBe("RECIPE_DEPENDENCY_CYCLE");
  expect(c.factories()).toBe(0);
});

test("catalogue structured input example invokes with an inputs file and valid scalar examples", async () => {
  const c = context();
  await c.io.fs.writeTextFile(
    "/flows/root.toml",
    header +
      '[inputs.payload]\ntype="object"\nrequired=true\n[inputs.ids]\ntype="array"\nrequired=true\n[inputs.count]\ntype="number"\nrequired=true\n[inputs.enabled]\ntype="boolean"\nrequired=true\n' +
      go.replace("${inputs.order}", "example"),
  );
  expect((await executeDiscovery(["describe", "/flows/root.toml", "--json"], c.io)).exitCode).toBe(
    0,
  );
  const recipe = JSON.parse(c.stdout[0]!).recipes[0];
  expect(recipe.example_inputs_file).toEqual({ payload: {}, ids: [] });
  expect(recipe.example_argv).toContain("--inputs-file");
  expect(recipe.example_argv).toContain("count=0");
  expect(recipe.example_argv).toContain("enabled=false");
  expect(recipe.example_argv.join(" ")).not.toContain("payload=<object>");
  // Substitute the documented placeholders and exercise the same command parser/binder.
  await c.io.fs.writeTextFile("/flows/params.json", JSON.stringify(recipe.example_inputs_file));
  const argv: string[] = recipe.example_argv.slice(1);
  const session = argv.indexOf("--session");
  argv.splice(session, 2);
  argv[argv.indexOf("<inputs.json>")] = "/flows/params.json";
  expect((await executeRun([...argv, "--no-lock-write"], c.io)).exitCode).toBe(0);
});

test("catalogue rejects unresolved id-form child calls without binding inputs", async () => {
  const c = context();
  await c.io.fs.writeTextFile(
    "/flows/root.toml",
    header + '[[steps]]\nid="child"\ndo="run"\nflow="missing.id"\n',
  );
  expect((await executeDiscovery(["describe", "/flows/root.toml", "--json"], c.io)).exitCode).toBe(
    1,
  );
  const report = JSON.parse(c.stdout[0]!);
  expect(report.diagnostics).toEqual([
    expect.objectContaining({ code: "RECIPE_DEPENDENCY_INVALID", file: "/flows/root.toml" }),
  ]);
  expect(c.factories()).toBe(0);
});

test("check rejects incompatible bound scalar fields before session acquisition", async () => {
  const c = context();
  let borrows = 0;
  c.io.namedSessionBorrower = async () => {
    borrows++;
    throw new Error("unexpected browser acquisition");
  };
  await c.io.fs.writeTextFile(
    "/flows/check-bound.toml",
    header +
      '[inputs.payload]\ntype="object"\nrequired=true\n[[steps]]\nid="prior"\ndo="goto"\nurl="https://example.test/prior"\n[[steps]]\nid="bad"\ndo="goto"\nurl="${inputs.payload}"\n',
  );
  await c.io.fs.writeTextFile("/flows/bound.json", '{"payload":{"secret":"bound-check-canary"}}');
  const result = await executeCheck(
    ["check", "check-bound.toml", "--inputs-file", "bound.json", "--session", "work", "--json"],
    c.io,
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(c.stdout[0]!).items).toContainEqual(
    expect.objectContaining({ code: "BINDING_INVALID", status: "failed" }),
  );
  expect(c.stdout.join(" ")).not.toContain("bound-check-canary");
  expect(borrows).toBe(0);
});
