import { expect, test } from "bun:test";
import { z } from "zod";
import { memoryFileSystem } from "../adapters/memory.ts";
import { ConfigSchema } from "../config/schema.ts";
import { executeConfig } from "./config.ts";

test("effective config is offline and never serializes credential values", async () => {
  const fs = memoryFileSystem();
  await fs.writeTextFile(
    "/flow.toml",
    'version=1\nkind="flow"\nid="config-test"\ndescription="test"\n[config.ai]\nclassifier="jev"\n[config.ai.jev]\nprofile="text"\n[[steps]]\nid="open"\ndo="goto"\nurl="http://localhost"',
  );
  const output: string[] = [];
  expect(
    await executeConfig("/flow.toml", {
      fs,
      cwd: "/",
      env: { TYPESAFE_API_KEY: "CANARY_SECRET" },
      stdout: (s) => output.push(s),
      stderr: (s) => output.push(s),
    }),
  ).toBe(0);
  expect(output.join("")).not.toContain("CANARY_SECRET");
  const result = JSON.parse(output[0]!);
  expect(result.jev.stages).toEqual(["text_choice", "text_verify"]);
  expect(result.timeouts).toMatchObject({ action_ms: 5000, nav_ms: 2000, settle_ms: 150 });
  expect(result.run).toHaveProperty("assert_timeout_ms");
  expect(result.execution_policy).toMatchObject({ ai: "disabled" });
  expect(result.policy_issues).toContainEqual(
    expect.objectContaining({ code: "AI_DISABLED", feature: "config.ai.classifier" }),
  );
  expect(result.timeouts.goto_ms).toBe(30000);
  expect(result.timeout_sources.goto_ms).toBe("default");
  expect(result.credentials.jev).toEqual({ env: "TYPESAFE_API_KEY", available: true });
});

test("published config schema matches strict parser generation", async () => {
  const published = await Bun.file(
    new URL("../../docs/schemas/config.schema.json", import.meta.url),
  ).json();
  expect(published).toEqual(z.toJSONSchema(ConfigSchema));
});

test.each(["run", "id-run", "setup", "teardown"])(
  "config reports AI requirements in %s without binding inputs or credentials",
  async (relation) => {
    const fs = memoryFileSystem();
    const header = 'version=1\nkind="flow"\nid="root"\ndescription="inspection"\n';
    const reference =
      relation === "run" || relation === "id-run"
        ? `${relation === "id-run" ? 'imports=["./child.toml"]\n' : ""}[[steps]]\nid="call"\ndo="run"\nflow="${relation === "id-run" ? "child" : "./child.toml"}"`
        : `${relation}="./child.toml"\n[[steps]]\nid="wait"\ndo="wait"\nms=0`;
    await fs.writeTextFile("/flow.toml", header + reference);
    await fs.writeTextFile(
      "/child.toml",
      header.replace('id="root"', 'id="child"') +
        '[config.ai]\nenabled=true\n[inputs.token]\ntype="string"\nrequired=true\nsecret=true\n[[steps]]\nid="judge"\ndo="assert"\nassert=[{type="ai_judge",prompt="Ready?"}]',
    );
    const output: string[] = [];
    expect(
      await executeConfig("/flow.toml", {
        fs,
        cwd: "/",
        env: {},
        stdout: (s) => output.push(s),
        stderr: (s) => output.push(s),
      }),
    ).toBe(0);
    expect(JSON.parse(output[0] ?? "{}").policy_issues).toContainEqual(
      expect.objectContaining({ feature: "ai_judge assertion" }),
    );
  },
);

test("config excludes unused imports and exposes effective assertion defaults with a run budget", async () => {
  const fs = memoryFileSystem();
  const header = 'version=1\nkind="flow"\nid="root"\ndescription="inspection"\n';
  await fs.writeTextFile(
    "/flow.toml",
    header + 'imports=["./child.toml"]\n[run]\nmax_steps=5\n[[steps]]\nid="wait"\ndo="wait"\nms=0',
  );
  await fs.writeTextFile(
    "/child.toml",
    header.replace('id="root"', 'id="child"') +
      '[[steps]]\nid="judge"\ndo="assert"\nassert=[{type="ai_judge",prompt="Ready?"}]',
  );
  const output: string[] = [];
  expect(
    await executeConfig("/flow.toml", {
      fs,
      cwd: "/",
      env: {},
      stdout: (s) => output.push(s),
      stderr: (s) => output.push(s),
    }),
  ).toBe(0);
  const result = JSON.parse(output[0] ?? "{}");
  expect(result.policy_issues).toEqual([]);
  expect(result.run).toEqual({
    max_steps: 5,
    assertions: "eager",
    fail_on_assertion: true,
    assert_timeout_ms: 5000,
  });
});
