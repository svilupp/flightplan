// Import-resolution tests: string/array/table forms, cycle detection, `with` clause.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractRefs,
  ImportCycleError,
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
    const { flow: f } = parseFlowFile(
      flow("a", `imports = ["./b.toml", "./c.toml"]`),
      "a.toml",
    );
    const refs = extractRefs(f);
    expect(refs.map((r) => r.modulePath)).toEqual(["./b.toml", "./c.toml"]);
  });

  test("normalizes [[imports]] table form with `with`", () => {
    const body = `[[imports]]\nmodule = "./b.toml"\nwith = { account = "x" }\n\n[[imports]]\nmodule = "./c.toml"`;
    const { flow: f } = parseFlowFile(flow("a", body), "a.toml");
    const refs = extractRefs(f);
    expect(refs[0]).toEqual({
      modulePath: "./b.toml",
      relation: "import",
      with: { account: "x" },
    });
    expect(refs[1]).toEqual({ modulePath: "./c.toml", relation: "import" });
  });

  test("includes setup and teardown as references", () => {
    const { flow: f } = parseFlowFile(
      flow("a", `setup = "./setup.toml"\nteardown = "./teardown.toml"`),
      "a.toml",
    );
    const refs = extractRefs(f);
    expect(refs.find((r) => r.relation === "setup")?.modulePath).toBe("./setup.toml");
    expect(refs.find((r) => r.relation === "teardown")?.modulePath).toBe(
      "./teardown.toml",
    );
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

  test("passes `with` params into an imported module's inputs", async () => {
    // Module declares an input with a default; the importer overrides it via `with`.
    write(
      "mod.toml",
      flow("mod", `[inputs]\naccount = "default-account"`),
    );
    const rootPath = write(
      "with-root.toml",
      flow(
        "with-root",
        `[[imports]]\nmodule = "./mod.toml"\nwith = { account = "overridden" }`,
      ),
    );
    const root = await loadFlowFile(rootPath);
    const graph = await resolveImports(root, { env: {} });
    const modNode = [...graph.nodes.values()].find(
      (n) => n.loaded.flow.id === "mod",
    )!;
    expect(modNode.inputs.account).toBe("overridden");
    expect(modNode.with).toEqual({ account: "overridden" });
  });

  test("`with` values are templated against the parent env", async () => {
    write("mod2.toml", flow("mod2", `[inputs]\nacct = "fallback"`));
    const rootPath = write(
      "with-env-root.toml",
      flow(
        "with-env-root",
        `[[imports]]\nmodule = "./mod2.toml"\nwith = { acct = "\${env.ACCT}" }`,
      ),
    );
    const root = await loadFlowFile(rootPath);
    const graph = await resolveImports(root, { env: { ACCT: "from-env" } });
    const modNode = [...graph.nodes.values()].find(
      (n) => n.loaded.flow.id === "mod2",
    )!;
    expect(modNode.inputs.acct).toBe("from-env");
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
