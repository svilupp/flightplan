// Import-resolution tests: string/array forms, run-path refs, cycle detection.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractRefs,
  FlowValidationError,
  ImportCycleError,
  isRunFlowPath,
  loadFlowFile,
  parseFlowFile,
  resolveImports,
} from "./index.ts";

const tmp = mkdtempSync(join(tmpdir(), "fp-imports-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function write(name: string, text: string): string {
  const p = join(tmp, name);
  writeFileSync(p, text);
  return p;
}

function flow(id: string, body = ""): string {
  return `version = 1\nkind = "flow"\nid = "${id}"\ndescription = "${id}"\n${body}\n[[steps]]\nid = "s1"\ndo = "wait"\nms = 1\n`;
}

describe("extractRefs", () => {
  test("normalizes string form", () => {
    const { flow: f } = parseFlowFile(flow("a", `imports = "./b.toml"`), "a.toml");
    const refs = extractRefs(f);
    expect(refs).toEqual([{ modulePath: "./b.toml", relation: "import" }]);
  });

  test("normalizes array-of-strings form", () => {
    const { flow: f } = parseFlowFile(flow("a", `imports = ["./b.toml", "./c.toml"]`), "a.toml");
    const refs = extractRefs(f);
    expect(refs.map((r) => r.modulePath)).toEqual(["./b.toml", "./c.toml"]);
  });

  test("the removed [[imports]] table form is a schema error (v002-5)", () => {
    const body = `[[imports]]\nmodule = "./b.toml"\nwith = { account = "x" }`;
    expect(() => parseFlowFile(flow("a", body), "a.toml")).toThrow(FlowValidationError);
  });

  test("includes path-form run references (v002-6)", () => {
    const body = `imports = "./lib.toml"\n\n[[steps]]\nid = "call"\ndo = "run"\nflow = "./child.toml"\n\n[[steps]]\nid = "call_id"\ndo = "run"\nflow = "lib.flow"`;
    const { flow: f } = parseFlowFile(flow("a", body), "a.toml");
    const refs = extractRefs(f);
    // The import + the PATH-form run ref; the id-form ref adds no edge.
    expect(refs.map((r) => [r.modulePath, r.relation])).toEqual([
      ["./lib.toml", "import"],
      ["./child.toml", "run"],
    ]);
  });

  test("includes setup and teardown as references", () => {
    const { flow: f } = parseFlowFile(
      flow("a", `setup = "./setup.toml"\nteardown = "./teardown.toml"`),
      "a.toml",
    );
    const refs = extractRefs(f);
    expect(refs.find((r) => r.relation === "setup")?.modulePath).toBe("./setup.toml");
    expect(refs.find((r) => r.relation === "teardown")?.modulePath).toBe("./teardown.toml");
  });
});

describe("resolveImports", () => {
  test("resolves a linear graph leaf-first", async () => {
    write("leaf.toml", flow("leaf"));
    write("mid.toml", flow("mid", `imports = "./leaf.toml"`));
    const rootPath = write("root.toml", flow("root", `imports = "./mid.toml"`));

    const root = await loadFlowFile(rootPath);
    const graph = await resolveImports(root);

    expect(graph.nodes.size).toBe(3);
    // Leaf-first composition order: leaf, mid, root.
    const ids = graph.order.map((p) => graph.nodes.get(p)!.loaded.flow.id);
    expect(ids).toEqual(["leaf", "mid", "root"]);
    expect(graph.rootPath).toBe(rootPath);
  });

  test("detects a direct import cycle", async () => {
    write("cyc-a.toml", flow("cyc-a", `imports = "./cyc-b.toml"`));
    write("cyc-b.toml", flow("cyc-b", `imports = "./cyc-a.toml"`));
    const root = await loadFlowFile(join(tmp, "cyc-a.toml"));
    await expect(resolveImports(root)).rejects.toThrow(ImportCycleError);
  });

  test("detects a self-import cycle", async () => {
    write("self.toml", flow("self", `imports = "./self.toml"`));
    const root = await loadFlowFile(join(tmp, "self.toml"));
    await expect(resolveImports(root)).rejects.toThrow(ImportCycleError);
  });

  test("a shared diamond import is not a cycle", async () => {
    write("d-shared.toml", flow("shared"));
    write("d-left.toml", flow("left", `imports = "./d-shared.toml"`));
    write("d-right.toml", flow("right", `imports = "./d-shared.toml"`));
    const rootPath = write(
      "d-root.toml",
      flow("root", `imports = ["./d-left.toml", "./d-right.toml"]`),
    );
    const root = await loadFlowFile(rootPath);
    const graph = await resolveImports(root);
    // shared appears once (DAG dedupe), root last.
    expect(graph.nodes.size).toBe(4);
    expect(graph.order[graph.order.length - 1]).toBe(rootPath);
  });

  test("resolves an imported module's declared inputs against env", async () => {
    write("mod.toml", flow("mod", `[inputs]\naccount = "\${env.ACCT}"`));
    const rootPath = write("inputs-root.toml", flow("inputs-root", `imports = "./mod.toml"`));
    const root = await loadFlowFile(rootPath);
    const graph = await resolveImports(root, { env: { ACCT: "from-env" } });
    const modNode = [...graph.nodes.values()].find((n) => n.loaded.flow.id === "mod")!;
    expect(modNode.inputs.account).toBe("from-env");
  });

  test("detects a cycle through a path-form run reference", async () => {
    write(
      "run-cyc-a.toml",
      flow("run-cyc-a", "") + `[[steps]]\nid = "call"\ndo = "run"\nflow = "./run-cyc-b.toml"\n`,
    );
    write(
      "run-cyc-b.toml",
      flow("run-cyc-b", "") + `[[steps]]\nid = "call"\ndo = "run"\nflow = "./run-cyc-a.toml"\n`,
    );
    const root = await loadFlowFile(join(tmp, "run-cyc-a.toml"));
    await expect(resolveImports(root)).rejects.toThrow(ImportCycleError);
  });

  test("throws when an imported module does not exist", async () => {
    const rootPath = write(
      "missing-root.toml",
      flow("missing-root", `imports = "./does-not-exist.toml"`),
    );
    const root = await loadFlowFile(rootPath);
    await expect(resolveImports(root)).rejects.toThrow();
  });
});

describe("isRunFlowPath", () => {
  test("path iff it contains '/' or ends '.toml' (v002-6)", () => {
    expect(isRunFlowPath("./auth/google-login.toml")).toBe(true);
    expect(isRunFlowPath("auth/login.toml")).toBe(true);
    expect(isRunFlowPath("login.toml")).toBe(true);
    expect(isRunFlowPath("/abs/path.toml")).toBe(true);
    // Everything else is an imported flow id.
    expect(isRunFlowPath("auth.google_login")).toBe(false);
    expect(isRunFlowPath("checkout")).toBe(false);
    expect(isRunFlowPath("shop.checkout.pay")).toBe(false);
  });
});
