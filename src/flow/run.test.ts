// `run` step flattening tests (PLAN_v002 §3): id-vs-path resolution, call-site namespacing,
// `with` overrides + `${inputs.*}` pre-templating, on_fail rewriting, budget roll-up, cycles.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flattenRunSteps,
  ImportCycleError,
  loadFlowFile,
  loadFlowFileFlattened,
  RunResolutionError,
} from "./index.ts";

const tmp = mkdtempSync(join(tmpdir(), "fp-run-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function write(name: string, text: string): string {
  const p = join(tmp, name);
  writeFileSync(p, text);
  return p;
}

function header(id: string): string {
  return `version = 1\nkind = "flow"\nid = "${id}"\ndescription = "${id}"\n`;
}

// A small child flow: declared inputs + steps referencing ${inputs.*} and ${env.*}.
const CHILD = `${header("auth.login")}
[inputs]
account = "default-account"

[[steps]]
id = "open"
do = "goto"
url = "https://example.com/login?u=\${inputs.account}&t=\${env.TOKEN}"

[[steps]]
id = "submit"
do = "press"
key = "Enter"
on_fail = { goto = "open", max = 2 }
`;

describe("loadFlowFileFlattened", () => {
  test("flattens an id-form run into namespaced child steps", async () => {
    write("child.toml", CHILD);
    const rootPath = write(
      "root-id.toml",
      `${header("root")}imports = "./child.toml"

[[steps]]
id = "login"
do = "run"
flow = "auth.login"
`,
    );
    const loaded = await loadFlowFileFlattened(rootPath, { env: {} });
    expect(loaded.flow.steps.map((s) => s.id)).toEqual(["login:open", "login:submit"]);
    // The child's on_fail.goto is rewritten to the namespaced form (v002-9).
    const submit = loaded.flow.steps[1]!;
    expect(submit.on_fail).toEqual({ goto: "login:open", max: 2 });
  });

  test("pre-templates ${inputs.*} against with-overridden inputs, leaves ${env.*}", async () => {
    write("child.toml", CHILD);
    const rootPath = write(
      "root-with.toml",
      `${header("root")}imports = "./child.toml"

[inputs]
acct = "\${env.PARENT_ACCT}"

[[steps]]
id = "login"
do = "run"
flow = "auth.login"
with = { account = "\${inputs.acct}" }
`,
    );
    // `with` is templated against the PARENT's scope (env + parent inputs).
    const loaded = await loadFlowFileFlattened(rootPath, { env: { PARENT_ACCT: "jane" } });
    const open = loaded.flow.steps[0]!;
    expect(open.do).toBe("goto");
    if (open.do !== "goto") throw new Error("unreachable");
    // ${inputs.account} resolved at flatten time; ${env.TOKEN} left for the runtime pass.
    expect(open.url).toBe("https://example.com/login?u=jane&t=${env.TOKEN}");
  });

  test("child defaults apply when `with` is omitted", async () => {
    write("child.toml", CHILD);
    const rootPath = write(
      "root-default.toml",
      `${header("root")}
[[steps]]
id = "login"
do = "run"
flow = "./child.toml"
`,
    );
    const loaded = await loadFlowFileFlattened(rootPath, { env: {} });
    const open = loaded.flow.steps[0]!;
    if (open.do !== "goto") throw new Error("unreachable");
    expect(open.url).toContain("u=default-account");
  });

  test("the same child at two call sites gets distinct namespaces", async () => {
    write("child.toml", CHILD);
    const rootPath = write(
      "root-twice.toml",
      `${header("root")}
steps = [
  { id = "first",  do = "run", flow = "./child.toml" },
  { id = "second", do = "run", flow = "./child.toml" },
]
`,
    );
    const loaded = await loadFlowFileFlattened(rootPath, { env: {} });
    expect(loaded.flow.steps.map((s) => s.id)).toEqual([
      "first:open",
      "first:submit",
      "second:open",
      "second:submit",
    ]);
  });

  test("nested runs flatten depth-first with stacked namespaces", async () => {
    write("leaf.toml", `${header("leaf")}\n[[steps]]\nid = "wait"\ndo = "wait"\nms = 1\n`);
    write(
      "mid.toml",
      `${header("mid")}
[[steps]]
id = "inner"
do = "run"
flow = "./leaf.toml"
`,
    );
    const rootPath = write(
      "root-nested.toml",
      `${header("root")}
[[steps]]
id = "outer"
do = "run"
flow = "./mid.toml"
`,
    );
    const loaded = await loadFlowFileFlattened(rootPath, { env: {} });
    expect(loaded.flow.steps.map((s) => s.id)).toEqual(["outer:inner:wait"]);
  });

  test("budget roll-up: the child's [run] block is dropped (parent-governed, v002-8)", async () => {
    write(
      "budgeted-child.toml",
      `${header("budgeted")}
[run]
max_steps = 1

[[steps]]
id = "a"
do = "wait"
ms = 1

[[steps]]
id = "b"
do = "wait"
ms = 1
`,
    );
    const rootPath = write(
      "root-budget.toml",
      `${header("root")}
[[steps]]
id = "call"
do = "run"
flow = "./budgeted-child.toml"
`,
    );
    const loaded = await loadFlowFileFlattened(rootPath, { env: {} });
    // Both child steps are spliced in; the child's own max_steps never surfaces on the parent.
    expect(loaded.flow.steps.map((s) => s.id)).toEqual(["call:a", "call:b"]);
    expect(loaded.flow.run).toBeUndefined();
  });

  test("call-site assertions ride on the last embedded step", async () => {
    write("child.toml", CHILD);
    const rootPath = write(
      "root-assert.toml",
      `${header("root")}
[[steps]]
id = "login"
do = "run"
flow = "./child.toml"

[[steps.assert]]
type = "url"
url = "**/dashboard"
`,
    );
    const loaded = await loadFlowFileFlattened(rootPath, { env: {} });
    const last = loaded.flow.steps[loaded.flow.steps.length - 1]!;
    expect(last.id).toBe("login:submit");
    expect(last.assert?.some((a) => a.type === "url")).toBe(true);
  });
});

describe("run resolution errors + cycles", () => {
  test("id-form not in scope throws with the ids in scope", async () => {
    write("child.toml", CHILD);
    const rootPath = write(
      "root-badid.toml",
      `${header("root")}imports = "./child.toml"

[[steps]]
id = "login"
do = "run"
flow = "auth.nope"
`,
    );
    const loaded = await loadFlowFile(rootPath);
    await expect(flattenRunSteps(loaded, { env: {} })).rejects.toThrow(RunResolutionError);
    await expect(flattenRunSteps(loaded, { env: {} })).rejects.toThrow(/auth\.login/);
  });

  test("path-form self-cycle throws ImportCycleError", async () => {
    const p = write(
      "self-run.toml",
      `${header("selfy")}
[[steps]]
id = "again"
do = "run"
flow = "./self-run.toml"
`,
    );
    await expect(loadFlowFileFlattened(p, { env: {} })).rejects.toThrow(ImportCycleError);
  });

  test("transitive run cycle throws ImportCycleError", async () => {
    write(
      "cyc-x.toml",
      `${header("cyc-x")}\n[[steps]]\nid = "go"\ndo = "run"\nflow = "./cyc-y.toml"\n`,
    );
    write(
      "cyc-y.toml",
      `${header("cyc-y")}\n[[steps]]\nid = "go"\ndo = "run"\nflow = "./cyc-x.toml"\n`,
    );
    await expect(loadFlowFileFlattened(join(tmp, "cyc-x.toml"), { env: {} })).rejects.toThrow(
      ImportCycleError,
    );
  });

  test("a mixed import+run cycle throws ImportCycleError", async () => {
    // A imports B; B runs A by path — the combined DAG has a cycle (v002-6).
    write(
      "mix-a.toml",
      `${header("mix-a")}imports = "./mix-b.toml"

[[steps]]
id = "call"
do = "run"
flow = "mix-b"
`,
    );
    write(
      "mix-b.toml",
      `${header("mix-b")}\n[[steps]]\nid = "back"\ndo = "run"\nflow = "./mix-a.toml"\n`,
    );
    await expect(loadFlowFileFlattened(join(tmp, "mix-a.toml"), { env: {} })).rejects.toThrow(
      ImportCycleError,
    );
  });
});
