import { expect, test } from "bun:test";
import { memoryFileSystem } from "../adapters/memory.ts";
import { createAiRuntime } from "../ai/runtime.ts";
import { FakeClock } from "../assert/clock.ts";
import { resolveConfigWithDefaults } from "../config/resolve.ts";
import { MockDriver } from "../driver/mock-driver.ts";
import { MemoryInvocationStore } from "../invocation/index.ts";
import type { FileSystemPort } from "../runtime.ts";
import { runFlow } from "./runner.ts";
import type { RunOptions, RunResult } from "./types.ts";

function header(id: string): string {
  return `version=1\nkind="flow"\nid="${id}"\ndescription="composition safety fixture"\n`;
}

function pressChild(key: string): string {
  return `${header("child")}[[steps]]\nid="key"\ndo="press"\nkey="${key}"\neffect="idempotent"\n`;
}

function options(fs: FileSystemPort, driver: MockDriver): RunOptions {
  return {
    flowPath: "/root.toml",
    fs,
    driverFactory: () => driver,
    config: resolveConfigWithDefaults([]),
    clock: new FakeClock(),
    env: {},
    out: "/runs",
    noLockWrite: true,
  };
}

async function invocationFixture() {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  await fs.writeTextFile(
    "/root.toml",
    `${header("root")}[[steps]]\nid="call"\ndo="run"\nflow="./child.toml"\n`,
  );
  await fs.writeTextFile("/child.toml", pressChild("Escape"));
  const store = new MemoryInvocationStore();
  return {
    fs,
    driver,
    store,
    opts: { ...options(fs, driver), idempotencyKey: "one", invocationStore: store },
  };
}

test("an invocation key conflicts when a path-called child's source changes", async () => {
  const { fs, driver, opts } = await invocationFixture();
  expect((await runFlow(opts)).summary.verdict).toBe("passed");
  expect(driver.callsTo("press").map((call) => call.args[0])).toEqual(["Escape"]);
  await fs.writeTextFile("/child.toml", pressChild("Enter"));
  await expect(runFlow(opts)).rejects.toThrow("INVOCATION_CONFLICT");
  expect(driver.callsTo("connect")).toHaveLength(1);
  expect(driver.callsTo("press").map((call) => call.args[0])).toEqual(["Escape"]);
});

test("claim-time changes cannot replace the admitted path-called child", async () => {
  const { fs, driver, store, opts } = await invocationFixture();
  const claim = store.claim.bind(store);
  store.claim = async (...parameters) => {
    const result = await claim(...parameters);
    if (result.status === "claimed") await fs.writeTextFile("/child.toml", pressChild("Enter"));
    return result;
  };
  expect((await runFlow(opts)).summary.verdict).toBe("passed");
  expect(await fs.readTextFile("/child.toml")).toContain('key="Enter"');
  expect(driver.callsTo("press").map((call) => call.args[0])).toEqual(["Escape"]);
});

test("id-form child required inputs use actual call bindings in invocation identity", async () => {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  await fs.writeTextFile(
    "/root.toml",
    header("root") +
      'imports=["./child.toml"]\n[[steps]]\nid="call"\ndo="run"\nflow="child"\nwith={target="${env.TARGET}"}\n',
  );
  await fs.writeTextFile(
    "/child.toml",
    header("child") +
      '[inputs.target]\ntype="string"\nrequired=true\n[[steps]]\nid="open"\ndo="goto"\nurl="${inputs.target}"\n',
  );
  const env = { TARGET: "https://example.test/first" };
  const opts = {
    ...options(fs, driver),
    env,
    idempotencyKey: "bound-child",
    invocationStore: new MemoryInvocationStore(),
  };
  expect((await runFlow(opts)).summary.verdict).toBe("passed");
  expect(driver.callsTo("goto").map((call) => call.args[0])).toEqual([env.TARGET]);
  env.TARGET = "https://example.test/second";
  await expect(runFlow(opts)).rejects.toThrow("INVOCATION_CONFLICT");
  expect(driver.callsTo("connect")).toHaveLength(1);
  expect(driver.callsTo("goto")).toHaveLength(1);
});

async function environmentInvocation(secret: boolean) {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  await fs.writeTextFile(
    "/root.toml",
    header("root") +
      '[[steps]]\nid="open"\ndo="goto"\nurl="${env.TARGET}"\n' +
      (secret ? "secret=true\n" : ""),
  );
  const env = { TARGET: "https://example.test/first" };
  const store = new MemoryInvocationStore();
  return {
    fs,
    driver,
    env,
    store,
    opts: { ...options(fs, driver), env, idempotencyKey: "environment", invocationStore: store },
  };
}

test("a changed nonsecret environment URL conflicts with the same invocation key", async () => {
  const { driver, env, opts } = await environmentInvocation(false);
  expect((await runFlow(opts)).summary.verdict).toBe("passed");
  env.TARGET = "https://example.test/second";
  await expect(runFlow(opts)).rejects.toThrow("INVOCATION_CONFLICT");
  expect(driver.callsTo("connect")).toHaveLength(1);
  expect(driver.callsTo("goto").map((call) => call.args[0])).toEqual([
    "https://example.test/first",
  ]);
});

test("a changed secret environment URL conflicts instead of replaying a different destination", async () => {
  const { fs, driver, env, opts } = await environmentInvocation(true);
  const first = await runFlow(opts);
  expect(first.summary.verdict).toBe("passed");
  expect(await runFlow(opts)).toEqual(first);
  env.TARGET = "https://example.test/second";
  await expect(runFlow(opts)).rejects.toThrow("INVOCATION_CONFLICT");
  expect(driver.callsTo("connect")).toHaveLength(1);
  expect(driver.callsTo("goto").map((call) => call.args[0])).toEqual([
    "https://example.test/first",
  ]);
  await expectRedactedArtifacts(fs, first, ["https://example.test/first"]);
});

test("a single secret login URL binds its destination and unclassified credential changes", async () => {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  const env = { BASE: "https://staging.example.test", TOKEN: "fixture-login-token" };
  await fs.writeTextFile(
    "/root.toml",
    header("root") +
      '[[steps]]\nid="login"\ndo="goto"\nurl="${env.BASE}/login?token=${env.TOKEN}"\nsecret=true',
  );
  const opts = {
    ...options(fs, driver),
    env,
    idempotencyKey: "secret-destination",
    invocationStore: new MemoryInvocationStore(),
  };
  const first = await runFlow(opts);
  expect(first.summary.verdict).toBe("passed");
  expect(await runFlow(opts)).toEqual(first);
  env.BASE = "https://production.example.test";
  await expect(runFlow(opts)).rejects.toThrow("INVOCATION_CONFLICT");
  env.BASE = "https://staging.example.test";
  env.TOKEN = "rotated-unclassified-token";
  await expect(runFlow(opts)).rejects.toThrow("INVOCATION_CONFLICT");
  expect(driver.callsTo("connect")).toHaveLength(1);
  expect(driver.callsTo("goto")).toHaveLength(1);
});

for (const location of ["entry", "child", "setup", "teardown"] as const) {
  test(`secret substrings cannot erase a changed public destination in a ${location} scope`, async () => {
    const fs = memoryFileSystem();
    const driver = new MockDriver();
    const env = { A: "oldtenant", B: "newtenant", BASE: "https://oldtenant.example.test" };
    const secretFlow =
      header("protected") +
      '[inputs.a]\ntype="string"\nsecret=true\ndefault={from_env="A"}\n' +
      '[inputs.b]\ntype="string"\nsecret=true\ndefault={from_env="B"}\n' +
      '[[steps]]\nid="open"\ndo="goto"\nurl="${env.BASE}/login"\nsecret=true';
    await fs.writeTextFile("/protected.toml", secretFlow);
    await fs.writeTextFile(
      "/root.toml",
      location === "entry"
        ? secretFlow
        : location === "child"
          ? `${header("root")}[[steps]]\nid="child"\ndo="run"\nflow="./protected.toml"`
          : `${header("root")}${location}="./protected.toml"\n[[steps]]\nid="wait"\ndo="wait"\nms=0`,
    );
    const opts = {
      ...options(fs, driver),
      env,
      idempotencyKey: "public-destination",
      invocationStore: new MemoryInvocationStore(),
    };
    expect((await runFlow(opts)).summary.verdict).toBe("passed");
    env.BASE = "https://newtenant.example.test";
    await expect(runFlow(opts)).rejects.toThrow("INVOCATION_CONFLICT");
    expect(driver.callsTo("connect")).toHaveLength(1);
    expect(driver.callsTo("goto")).toHaveLength(1);
  });
}

for (const child of [false, true]) {
  test(`explicit secret rotation does not alter matching public hostname text (${child ? "child with override" : "entry"})`, async () => {
    const fs = memoryFileSystem();
    const driver = new MockDriver();
    const env = { BASE: "https://oldtenant.example.test", TOKEN: "oldtenant" };
    const destination =
      '[[steps]]\nid="login"\ndo="goto"\nurl="${env.BASE}/login?token=${inputs.token}"\nsecret=true';
    await fs.writeTextFile(
      "/root.toml",
      child
        ? `${header("root")}[[steps]]\nid="call"\ndo="run"\nflow="./child.toml"\nwith={token="\${env.TOKEN}"}`
        : header("root") + secretInput("TOKEN") + destination,
    );
    if (child) await fs.writeTextFile("/child.toml", header("child") + secretInput() + destination);
    const opts = {
      ...options(fs, driver),
      env,
      idempotencyKey: "credential-rotation",
      invocationStore: new MemoryInvocationStore(),
    };
    const first = await runFlow(opts);
    expect(first.summary.verdict).toBe("passed");
    env.TOKEN = "rotated-credential";
    expect(await runFlow(opts)).toEqual(first);
    expect(driver.callsTo("connect")).toHaveLength(1);
    expect(driver.callsTo("goto")).toHaveLength(1);
  });
}

test("claim-time environment mutation cannot change the admitted destination", async () => {
  const { driver, env, store, opts } = await environmentInvocation(false);
  const claim = store.claim.bind(store);
  store.claim = async (...parameters) => {
    const result = await claim(...parameters);
    if (result.status === "claimed") env.TARGET = "https://example.test/second";
    return result;
  };
  expect((await runFlow(opts)).summary.verdict).toBe("passed");
  expect(env.TARGET).toBe("https://example.test/second");
  expect(driver.callsTo("goto").map((call) => call.args[0])).toEqual([
    "https://example.test/first",
  ]);
});

test("a child secret URL also redacts its contributing parent input", async () => {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  const token = "parent-composed-token-913";
  await fs.writeTextFile(
    "/root.toml",
    header("root") +
      '[inputs]\ntoken="${env.TOKEN}"\n[[steps]]\nid="call"\ndo="run"\nflow="./child.toml"\nwith={url="https://example.test/${inputs.token}"}',
  );
  await fs.writeTextFile(
    "/child.toml",
    header("child") +
      '[inputs]\nurl=""\n[[steps]]\nid="open"\ndo="goto"\nurl="${inputs.url}"\nsecret=true',
  );
  const result = await runFlow({ ...options(fs, driver), env: { TOKEN: token } });
  expect(result.summary.verdict).toBe("passed");
  expect(driver.callsTo("goto")[0]?.args[0]).toBe(`https://example.test/${token}`);
  await expectRedactedArtifacts(fs, result, [token]);
});

test.each(["setup", "teardown"])(
  "%s uses the same environment as secret preparation",
  async (phase) => {
    const fs = memoryFileSystem();
    const driver = new MockDriver();
    const env = { TOKEN: "first-hook-token-4372" };
    await fs.writeTextFile(
      "/root.toml",
      header("root") + `${phase}="./hook.toml"\n[[steps]]\nid="wait"\ndo="wait"\nms=0`,
    );
    await fs.writeTextFile("/hook.toml", secretDestination("hook", "TOKEN"));
    const connect = driver.connect.bind(driver);
    driver.connect = async (config) => {
      env.TOKEN = "rotated-hook-token-9416";
      await connect(config);
    };
    const result = await runFlow({ ...options(fs, driver), env });
    expect(result.summary.verdict).toBe("passed");
    expect(driver.callsTo("goto")[0]?.args[0]).toBe("https://example.test/first-hook-token-4372");
    await expectRedactedArtifacts(fs, result, ["first-hook-token-4372", env.TOKEN]);
  },
);

test("AI policy rejection leaves an invocation key available for an authorized retry", async () => {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  await fs.writeTextFile(
    "/root.toml",
    header("root") +
      '[[steps]]\nid="judge"\ndo="assert"\n[[steps.assert]]\ntype="ai_judge"\ninputs=["text"]\nprompt="Ready?"',
  );
  const opts: RunOptions = {
    ...options(fs, driver),
    idempotencyKey: "policy-retry",
    invocationStore: new MemoryInvocationStore(),
    aiRuntimeFactory: (deps) =>
      createAiRuntime({
        ...deps,
        generate: async () => ({
          output: { pass: true },
          model: "fixture",
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      }),
  };
  await expect(runFlow(opts)).rejects.toMatchObject({ code: "AI_DISABLED" });
  expect(driver.callsTo("connect")).toHaveLength(0);
  const result = await runFlow({
    ...opts,
    config: resolveConfigWithDefaults([{ ai: { enabled: true } }]),
  });
  expect(result.summary.verdict).toBe("passed");
  expect(driver.callsTo("connect")).toHaveLength(1);
});

test("credential text matching a step ID does not change invocation identity on rotation", async () => {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  const env = { TOKEN: "open" };
  await fs.writeTextFile("/root.toml", secretDestination("root", "TOKEN"));
  const opts = {
    ...options(fs, driver),
    env,
    idempotencyKey: "short-secret",
    invocationStore: new MemoryInvocationStore(),
  };
  const first = await runFlow(opts);
  env.TOKEN = "closed";
  expect(await runFlow(opts)).toEqual(first);
  expect(driver.callsTo("connect")).toHaveLength(1);
});

test("immutable filesystem ports support a complete run", async () => {
  const fs = Object.freeze(memoryFileSystem());
  const driver = new MockDriver();
  await fs.writeTextFile("/root.toml", header("root") + '[[steps]]\nid="wait"\ndo="wait"\nms=0');
  expect((await runFlow(options(fs, driver))).summary.verdict).toBe("passed");
});

test("a private login does not hide a changed public destination from an invocation key", async () => {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  const env = { BASE: "https://staging.example.test", TOKEN: "fixture-login-token" };
  await fs.writeTextFile(
    "/root.toml",
    header("root") +
      '[[steps]]\nid="login"\ndo="goto"\nurl="${env.BASE}/login?token=${env.TOKEN}"\nsecret=true\n[[steps]]\nid="checkout"\ndo="goto"\nurl="${env.BASE}/checkout"',
  );
  const opts = {
    ...options(fs, driver),
    env,
    idempotencyKey: "destination",
    invocationStore: new MemoryInvocationStore(),
  };
  expect((await runFlow(opts)).summary.verdict).toBe("passed");
  env.BASE = "https://production.example.test";
  await expect(runFlow(opts)).rejects.toThrow("INVOCATION_CONFLICT");
  expect(driver.callsTo("connect")).toHaveLength(1);
});

test("an overridden default does not change invocation identity", async () => {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  const env = { BASE: "https://unused.example.test" };
  await fs.writeTextFile(
    "/root.toml",
    header("root") +
      '[inputs.destination]\ntype="string"\ndefault="${env.BASE}"\n[[steps]]\nid="checkout"\ndo="goto"\nurl="${inputs.destination}"',
  );
  const opts = {
    ...options(fs, driver),
    env,
    inputs: { destination: "https://checkout.example.test" },
    idempotencyKey: "overridden",
    invocationStore: new MemoryInvocationStore(),
  };
  const first = await runFlow(opts);
  env.BASE = "https://another-unused.example.test";
  expect(await runFlow(opts)).toEqual(first);
  expect(driver.callsTo("connect")).toHaveLength(1);
});

test("runtime capture binding registers a secret URL before tracing it", async () => {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  const token = "fixture-private-url-token";
  driver.currentUrl = async () => "public-item";
  await fs.writeTextFile(
    "/root.toml",
    header("root") +
      '[[steps]]\nid="capture"\ndo="wait"\nms=0\ncapture={name="item",type="url"}\n[[steps]]\nid="open"\ndo="goto"\nurl="https://example.test/${env.TOKEN}/${capture.item}"\nsecret=true',
  );
  const result = await runFlow({ ...options(fs, driver), env: { TOKEN: token } });
  expect(result.summary.verdict).toBe("passed");
  expect(driver.callsTo("goto")[0]?.args[0]).toBe(`https://example.test/${token}/public-item`);
  await expectRedactedArtifacts(fs, result, [token]);
});

test.each(["${literal}", "\u0000flightplan:literal:"])(
  "rotating a typed secret containing %j replays without leaking protected literals",
  async (marker) => {
    const fs = memoryFileSystem();
    const driver = new MockDriver();
    const first = `canary-first-${marker}-9361`;
    const second = `canary-second-${marker}-5147`;
    const env = { TOKEN: first };
    await fs.writeTextFile("/root.toml", secretDestination("root", "TOKEN"));
    const opts = {
      ...options(fs, driver),
      env,
      idempotencyKey: "literal-secret",
      invocationStore: new MemoryInvocationStore(),
    };
    const result = await runFlow(opts);
    expect(result.summary.verdict).toBe("passed");
    expect(driver.callsTo("goto").map((call) => call.args[0])).toEqual([
      `https://example.test/${first}`,
    ]);
    env.TOKEN = second;
    expect(await runFlow(opts)).toEqual(result);
    expect(driver.callsTo("connect")).toHaveLength(1);
    expect(driver.callsTo("goto")).toHaveLength(1);
    await expectRedactedArtifacts(fs, result, [first, second]);
  },
);

test.each(["${literal}", "\u0000flightplan:literal:"])(
  "a nonsecret input containing %j is redacted when used in a secret step",
  async (marker) => {
    const fs = memoryFileSystem();
    const driver = new MockDriver();
    const value = `https://example.test/canary-${marker}-7263`;
    await fs.writeTextFile(
      "/root.toml",
      header("root") +
        '[inputs.value]\ntype="string"\nrequired=true\n[[steps]]\nid="open"\ndo="goto"\nurl="${inputs.value}"\nsecret=true\n',
    );
    const result = await runFlow({ ...options(fs, driver), inputs: { value } });
    expect(result.summary.verdict).toBe("passed");
    expect(driver.callsTo("goto").map((call) => call.args[0])).toEqual([value]);
    await expectRedactedArtifacts(fs, result, [value]);
  },
);

function secretInput(defaultEnv?: string): string {
  return (
    '[inputs.token]\ntype="string"\nsecret=true\n' +
    (defaultEnv ? `default={from_env="${defaultEnv}"}\n` : "required=true\n")
  );
}

function secretDestination(id: string, defaultEnv?: string): string {
  return (
    header(id) +
    secretInput(defaultEnv) +
    '[[steps]]\nid="open"\ndo="goto"\nurl="https://example.test/${inputs.token}"\n'
  );
}

async function expectRedactedArtifacts(
  fs: FileSystemPort,
  result: RunResult,
  secrets: readonly string[],
): Promise<void> {
  const artifacts = new Map<string, string>();
  async function readDirectory(directory: string): Promise<void> {
    for (const entry of await fs.readDir(directory)) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory) await readDirectory(path);
      else if (entry.isFile) artifacts.set(path, await fs.readTextFile(path));
    }
  }
  await readDirectory(result.runDir);
  for (const filename of ["run.jsonl", "trace.jsonl", "summary.json"])
    expect(artifacts.has(`${result.runDir}/${filename}`)).toBe(true);
  const serializedSummary = JSON.stringify(result.summary);
  for (const secret of secrets) {
    // JSON escapes control characters, including the literal-protection sentinel's NUL.
    const encodedSecret = JSON.stringify(secret).slice(1, -1);
    for (const [path, content] of artifacts) {
      expect(content, path).not.toContain(secret);
      expect(content, path).not.toContain(encodedSecret);
    }
    expect(serializedSummary).not.toContain(secret);
    expect(serializedSummary).not.toContain(encodedSecret);
  }
}

test("a path-called child's typed secret from_env default stays out of artifacts", async () => {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  const canary = "canary-child-default-4193";
  await fs.writeTextFile(
    "/root.toml",
    `${header("root")}[[steps]]\nid="call"\ndo="run"\nflow="./child.toml"\n`,
  );
  await fs.writeTextFile("/child.toml", secretDestination("child", "CHILD_VALUE"));
  const result = await runFlow({ ...options(fs, driver), env: { CHILD_VALUE: canary } });
  expect(result.summary.verdict).toBe("passed");
  expect(driver.callsTo("goto").map((call) => call.args[0])).toEqual([
    `https://example.test/${canary}`,
  ]);
  await expectRedactedArtifacts(fs, result, [canary]);
});

for (const nested of [false, true]) {
  test(`distinct typed secret overrides stay redacted at two ${nested ? "nested" : "direct"} call sites`, async () => {
    const fs = memoryFileSystem();
    const driver = new MockDriver();
    const first = "canary-first-call-2519";
    const second = "canary-second-call-6731";
    const target = nested ? "wrapper" : "child";
    const calls = ["FIRST_VALUE", "SECOND_VALUE"]
      .map(
        (name, index) =>
          `[[steps]]\nid="call${index}"\ndo="run"\nflow="./${target}.toml"\nwith={token="\${env.${name}}"}\n`,
      )
      .join("");
    await fs.writeTextFile("/root.toml", header("root") + calls);
    await fs.writeTextFile("/child.toml", secretDestination("child", "UNUSED_DEFAULT"));
    if (nested)
      await fs.writeTextFile(
        "/wrapper.toml",
        header("wrapper") +
          secretInput() +
          '[[steps]]\nid="nested"\ndo="run"\nflow="./child.toml"\nwith={token="${inputs.token}"}\n',
      );
    const result = await runFlow({
      ...options(fs, driver),
      env: {
        FIRST_VALUE: first,
        SECOND_VALUE: second,
        UNUSED_DEFAULT: "canary-unused-default-9707",
      },
    });
    expect(result.summary.verdict).toBe("passed");
    expect(driver.callsTo("goto").map((call) => call.args[0])).toEqual([
      `https://example.test/${first}`,
      `https://example.test/${second}`,
    ]);
    await expectRedactedArtifacts(fs, result, [first, second]);
  });
}

for (const phase of ["setup", "teardown"] as const) {
  for (const nested of [false, true]) {
    test(`${phase} typed secret defaults stay redacted ${nested ? "through a nested callable" : "in direct actions"}`, async () => {
      const fs = memoryFileSystem();
      const driver = new MockDriver();
      const canary = `canary-${phase}-${nested ? "nested" : "direct"}-8329`;
      await fs.writeTextFile(
        "/root.toml",
        `${header("root")}${phase}="./hook.toml"\n[[steps]]\nid="root"\ndo="wait"\nms=0\n`,
      );
      await fs.writeTextFile(
        "/hook.toml",
        nested
          ? header("hook") +
              secretInput("HOOK_VALUE") +
              '[[steps]]\nid="nested"\ndo="run"\nflow="./child.toml"\nwith={token="${inputs.token}"}\n'
          : secretDestination("hook", "HOOK_VALUE"),
      );
      if (nested) await fs.writeTextFile("/child.toml", secretDestination("child"));
      const result = await runFlow({ ...options(fs, driver), env: { HOOK_VALUE: canary } });
      expect(result.summary.verdict).toBe("passed");
      expect(driver.callsTo("goto").map((call) => call.args[0])).toEqual([
        `https://example.test/${canary}`,
      ]);
      await expectRedactedArtifacts(fs, result, [canary]);
    });
  }
}

test.each(["setup", "teardown"])(
  "%s secret extraction suppresses recording throughout the run",
  async (phase) => {
    const fs = memoryFileSystem();
    const canary = `canary-${phase}-extraction-5483`;
    const driver = new MockDriver().setScreenshot("YWJj").setExtractResult([{ token: canary }]);
    await fs.writeTextFile(
      "/root.toml",
      `${header("root")}${phase}="./hook.toml"\n[[steps]]\nid="root"\ndo="wait"\nms=0\n`,
    );
    await fs.writeTextFile(
      "/hook.toml",
      header("hook") +
        '[[steps]]\nid="private"\ndo="extract"\nselector=".row"\n[steps.fields.token]\nselector=".token"\nsource="text"\ntype="string"\nsecret=true\n',
    );
    const result = await runFlow({
      ...options(fs, driver),
      config: resolveConfigWithDefaults([{ browser: { record: true } }]),
    });
    expect(result.summary.verdict).toBe("passed");
    const events = (await fs.readTextFile(`${result.runDir}/run.jsonl`))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "step_end", stepId: "private", ok: true }),
    );
    expect(driver.callsTo("screenshot")).toHaveLength(0);
    expect(driver.callsTo("saveScreenshot")).toHaveLength(0);
    expect(result.summary.screenshot_paths).toEqual([]);
    expect(await fs.readDir(`${result.runDir}/screenshots`)).toEqual([]);
    await expectRedactedArtifacts(fs, result, [canary]);
  },
);
