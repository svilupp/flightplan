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
  expect(result.credentials.jev).toEqual({ env: "TYPESAFE_API_KEY", available: true });
});

test("published config schema matches strict parser generation", async () => {
  const published = await Bun.file(
    new URL("../../docs/schemas/config.schema.json", import.meta.url),
  ).json();
  expect(published).toEqual(z.toJSONSchema(ConfigSchema));
});
