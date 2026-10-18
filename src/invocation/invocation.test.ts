import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFileSystem } from "../adapters/memory.ts";
import { type CommandIO, executeRun } from "../cli/commands.ts";
import { MockDriver } from "../driver/index.ts";
import { type InvocationStore, MemoryInvocationStore } from "./index.ts";
import { NodeInvocationStore } from "./node.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
const source =
  'version=1\nkind="flow"\nid="once"\ndescription="once"\n[inputs.order]\ntype="string"\nrequired=true\n[[steps]]\nid="open"\ndo="goto"\nurl="https://example.test/${inputs.order}"\n';
async function setup(store: InvocationStore = new MemoryInvocationStore()) {
  const fs = memoryFileSystem();
  await fs.writeTextFile("/flow.toml", source);
  const driver = new MockDriver();
  const out: string[] = [],
    err: string[] = [];
  let factories = 0;
  const io: CommandIO = {
    fs,
    cwd: "/",
    env: {},
    invocationStore: store,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    driverFactory: () => {
      factories++;
      return driver;
    },
  };
  return { io, out, err, driver, factories: () => factories };
}
const args = [
  "run",
  "/flow.toml",
  "--input",
  "order=D123",
  "--idempotency-key",
  "pay-D123",
  "--json",
  "--no-lock-write",
];
test("same CLI invocation returns original JSON summary without connecting or dispatching again", async () => {
  const c = await setup();
  expect((await executeRun(args, c.io)).exitCode).toBe(0);
  expect((await executeRun(args, c.io)).exitCode).toBe(0);
  expect(c.out[1]).toBe(c.out[0]);
  expect(c.factories()).toBe(1);
  expect(c.driver.callsTo("goto")).toHaveLength(1);
  const summary = JSON.parse(c.out[0]!);
  expect(summary.idempotency_key).toBe("pay-D123");
  expect(JSON.parse(await c.io.fs.readTextFile(`${summary.run_dir}/summary.json`))).toEqual(
    summary,
  );
});
test("concurrent caller and changed input cannot acquire the same invocation", async () => {
  const c = await setup();
  const results = await Promise.all([executeRun(args, c.io), executeRun(args, c.io)]);
  expect(results.map((r) => r.exitCode).sort((a, b) => a - b)).toEqual([0, 2]);
  expect(c.factories()).toBe(1);
  const changed = args.map((s) => (s === "order=D123" ? "order=D999" : s));
  expect((await executeRun(changed, c.io)).exitCode).toBe(2);
  expect([...c.out, ...c.err].join("\n")).toContain("INVOCATION_CONFLICT");
  expect(c.driver.callsTo("goto")).toHaveLength(1);
});
test("pending dispatch is durable before entering a driver mutator", async () => {
  const store = new MemoryInvocationStore();
  const c = await setup(store);
  const pending = store.dispatchPending.bind(store);
  let recorded = false;
  store.dispatchPending = async (...parameters) => {
    await pending(...parameters);
    recorded = true;
  };
  const go = c.driver.goto.bind(c.driver);
  c.driver.goto = async (url, options) => {
    expect(recorded).toBe(true);
    await go(url, options);
  };
  expect((await executeRun(args, c.io)).exitCode).toBe(0);
});
test("store failure before dispatch sends no browser input and blocks a retry", async () => {
  const store = new MemoryInvocationStore();
  const c = await setup(store);
  store.dispatchPending = async () => {
    throw new Error("journal unavailable");
  };
  expect((await executeRun(args, c.io)).exitCode).toBe(2);
  expect(c.driver.callsTo("goto")).toHaveLength(0);
  expect((await executeRun(args, c.io)).exitCode).toBe(2);
  expect(c.factories()).toBe(1);
});
test("native atomic claims survive independent processes before and after dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-invocations-"));
  dirs.push(dir);
  const stores = [new NodeInvocationStore(dir), new NodeInvocationStore(dir)];
  const claims = await Promise.all(stores.map((store) => store.claim("race", "binding")));
  expect(claims.filter((c) => c.status === "claimed")).toHaveLength(1);
  const module = new URL("./node.ts", import.meta.url).pathname;
  for (const pending of [false, true]) {
    const key = `crashed-${pending}`;
    const program = `import { NodeInvocationStore } from ${JSON.stringify(module)}; const store=new NodeInvocationStore(${JSON.stringify(dir)});const claim=await store.claim(${JSON.stringify(key)},'binding');if(claim.status!=='claimed')throw new Error('claim');${pending ? `await store.dispatchPending(${JSON.stringify(key)},claim.token);` : ""}`;
    const process = Bun.spawn(["bun", "-e", program], { stdout: "pipe", stderr: "pipe" });
    expect(await process.exited).toBe(0);
    expect((await new NodeInvocationStore(dir).claim(key, "binding")).status).toBe(
      pending ? "needs_reconciliation" : "running",
    );
    expect((await new NodeInvocationStore(dir).claim(key, "changed")).status).toBe("conflict");
  }
});

test("binding uses effective nonsecret defaults and keeps secret values out of claim identity", async () => {
  const store = new MemoryInvocationStore();
  const c = await setup(store);
  await c.io.fs.writeTextFile(
    "/flow.toml",
    source.replace("required=true", 'default="${env.ORDER_ID}"'),
  );
  c.io.env.ORDER_ID = "D123";
  const noOverride = args.filter((_, index) => index !== 2 && index !== 3);
  expect((await executeRun(noOverride, c.io)).exitCode).toBe(0);
  c.io.env.ORDER_ID = "D999";
  expect((await executeRun(noOverride, c.io)).exitCode).toBe(2);
  expect([...c.out, ...c.err].join("\n")).toContain("INVOCATION_CONFLICT");
});

test("secret reference identity survives environment changes without hashing the secret value", async () => {
  const c = await setup();
  await c.io.fs.writeTextFile(
    "/flow.toml",
    source.replace("required=true", "required=true\nsecret=true"),
  );
  c.io.env.TOKEN = "first-secret";
  const secretArgs = args.map((value) =>
    value === "--input" ? "--input-env" : value === "order=D123" ? "order=TOKEN" : value,
  );
  expect((await executeRun(secretArgs, c.io)).exitCode).toBe(0);
  c.io.env.TOKEN = "changed-secret";
  expect((await executeRun(secretArgs, c.io)).exitCode).toBe(0);
  expect(c.factories()).toBe(1);
  expect(c.out[1]).toBe(c.out[0]);
  expect(c.out.join("\n")).not.toContain("first-secret");
  expect(c.out.join("\n")).not.toContain("changed-secret");
});

test("every raw driver mutator records pending before host dispatch", async () => {
  const { runWithInvocation, INVOCATION_MUTATORS } = await import("./run.ts");
  const { resolveConfigWithDefaults } = await import("../config/index.ts");
  const c = await setup();
  const store = new MemoryInvocationStore();
  let pending = 0,
    actions = 0;
  const original = store.dispatchPending.bind(store);
  store.dispatchPending = async (...parameters) => {
    await original(...parameters);
    pending++;
  };
  const driver = Object.fromEntries(
    [...INVOCATION_MUTATORS].map((method) => [
      method,
      async () => {
        actions++;
        expect(pending).toBe(actions);
      },
    ]),
  );
  await runWithInvocation(
    {
      flowPath: "/flow.toml",
      fs: c.io.fs,
      env: {},
      config: resolveConfigWithDefaults([]),
      inputs: { order: "D123" },
      invocationStore: store,
      idempotencyKey: "inventory",
    },
    async (options) => {
      const guarded = options.driverFactory!({ mode: "attach" }) as unknown as Record<
        string,
        () => Promise<unknown>
      >;
      for (const method of INVOCATION_MUTATORS) await guarded[method]!();
      return { runDir: "/result", exitCode: 0, summary: { summary_version: 1 } } as never;
    },
    () => driver as never,
  );
  expect(actions).toBe(INVOCATION_MUTATORS.size);
});

test("native --json rejects literal secret inputs without echoing values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-native-input-"));
  dirs.push(dir);
  const path = join(dir, "flow.toml");
  await Bun.write(path, source.replace("required=true", "required=true\nsecret=true"));
  const cli = new URL("../cli/index.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    ["bun", cli, "run", path, "--input", "order=canary-sensitive-literal", "--json"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(2);
  expect(JSON.parse(stdout).diagnostics).toContainEqual(
    expect.objectContaining({ code: "INPUT_SECRET_REFERENCE" }),
  );
  expect(stdout + stderr).not.toContain("canary-sensitive-literal");
});

test("yield host actions cannot start when pending journal persistence fails", async () => {
  const { runWithInvocation } = await import("./run.ts");
  const { resolveConfigWithDefaults } = await import("../config/index.ts");
  const c = await setup();
  const store = new MemoryInvocationStore();
  store.dispatchPending = async () => {
    throw new Error("journal unavailable");
  };
  let hostActions = 0;
  await expect(
    runWithInvocation(
      {
        flowPath: "/flow.toml",
        fs: c.io.fs,
        env: {},
        config: resolveConfigWithDefaults([]),
        inputs: { order: "D123" },
        invocationStore: store,
        idempotencyKey: "yield-journal",
        yieldHost: {
          perform: async () => {
            hostActions++;
            return { pageIdentity: "page" };
          },
        } as never,
      },
      async (options) => {
        await options.yieldHost!.perform(
          { checkpointId: "checkpoint", task: "task", deadline: Date.now() + 1000 },
          new AbortController().signal,
        );
        throw new Error("unreachable");
      },
      () => c.driver,
    ),
  ).rejects.toThrow("journal unavailable");
  expect(hostActions).toBe(0);
});

test("admitted recipe sources stay pinned when files change after the claim", async () => {
  const store = new MemoryInvocationStore();
  const c = await setup(store);
  const claim = store.claim.bind(store);
  store.claim = async (...parameters) => {
    const result = await claim(...parameters);
    await c.io.fs.writeTextFile(
      "/flow.toml",
      source.replace("https://example.test/", "https://changed.test/"),
    );
    return result;
  };
  expect((await executeRun(args, c.io)).exitCode).toBe(0);
  expect(c.driver.callsTo("goto")[0]?.args[0]).toBe("https://example.test/D123");
});
