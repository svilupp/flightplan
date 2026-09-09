import { describe, expect, test } from "bun:test";
import { memoryFileSystem } from "../adapters/memory.ts";
import { MockDriver } from "../driver/index.ts";
import { runFlightplan } from "./index.ts";

const header = (id: string) => `version=1\nkind="flow"\nid="${id}"\ndescription="test"\n`;
const step = (id: string) => `[[steps]]\nid="${id}"\ndo="goto"\nurl="https://example.test/${id}"\n`;

describe("generic shell host", () => {
  test("lints and runs relative imports with only a FileSystemPort and driver", async () => {
    const fs = memoryFileSystem();
    const driver = new MockDriver();
    const context = { fs, cwd: "/workspace" };
    await fs.writeTextFile(
      "/workspace/root.toml",
      header("root") + 'imports="./child.toml"\n[[steps]]\nid="child"\ndo="run"\nflow="child"\n',
    );
    await fs.writeTextFile("/workspace/child.toml", header("child") + step("open"));
    const lint = await runFlightplan(["lint", "root.toml", "--json"], context);
    expect(lint.exitCode).toBe(0);
    const result = await runFlightplan(
      ["run", "root.toml", "--json", "--no-lock-write", "-o", "evidence"],
      context,
      { driverFactory: () => driver },
    );
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(result.stdout) as { verdict: string; run_dir: string };
    expect(summary.verdict).toBe("passed");
    expect(summary.run_dir.startsWith("/workspace/evidence/")).toBe(true);
    expect(await fs.fileExists(`${summary.run_dir}/summary.json`)).toBe(true);
    expect(driver.callsTo("goto")).toHaveLength(1);
  });

  test("host capability policy prevents execution", async () => {
    let calls = 0;
    const result = await runFlightplan(
      ["run", "missing.toml"],
      { fs: memoryFileSystem(), cwd: "/" },
      {
        capabilities: { run: false },
        driverFactory: () => {
          calls++;
          return new MockDriver();
        },
      },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not granted");
    expect(calls).toBe(0);
  });

  test("oversize UTF-8 output fails without returning a truncated document", async () => {
    const result = await runFlightplan(
      ["--version"],
      { fs: memoryFileSystem(), cwd: "/" },
      { version: "東京", limits: { maxOutputBytes: 4 } },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("output limit");
  });
});
