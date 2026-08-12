// Flightplan — `emit` step schema + lint tests.
//
// Coverage:
//   - schema accepts a table payload and a string payload, both with await_reply.
//   - schema forces/defaults effect = "at_most_once" and rejects any other explicit value.
//   - schema rejects a channel other than "ws".
//   - lint: steps/required-fields (missing payload/channel), steps/emit-no-retry (retry.max>0).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintFile } from "../lint/index.ts";
import { FlowValidationError, parseFlowFile } from "./load.ts";

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fp-emit-"));
  tmpDirs.push(dir);
  return dir;
}

const HEADER = `
version = 1
kind = "flow"
id = "test.emit.schema"
description = "emit step schema tests"
`;

describe("EmitStepSchema — accepts", () => {
  test("a table payload with await_reply, match, base64", () => {
    const toml = `${HEADER}
[[steps]]
id = "send"
do = "emit"
channel = "ws"
match = "wss://*/session/*"
base64 = false
payload = { type = "client.response.text", content = "say hi" }

[steps.await_reply]
where = { type = "response.end" }
match = "*done*"
timeout_ms = 10000
`;
    const loaded = parseFlowFile(toml, "flow.toml");
    const step = loaded.flow.steps[0]!;
    expect(step.do).toBe("emit");
    if (step.do !== "emit") throw new Error("unreachable");
    expect(step.payload).toEqual({ type: "client.response.text", content: "say hi" });
    expect(step.effect).toBe("at_most_once"); // defaulted
    expect(step.await_reply?.where).toEqual({ type: "response.end" });
    expect(step.await_reply?.timeout_ms).toBe(10000);
  });

  test("a string payload with no await_reply", () => {
    const toml = `${HEADER}
[[steps]]
id = "send"
do = "emit"
channel = "ws"
payload = "hello"
`;
    const loaded = parseFlowFile(toml, "flow.toml");
    const step = loaded.flow.steps[0]!;
    if (step.do !== "emit") throw new Error("unreachable");
    expect(step.payload).toBe("hello");
    expect(step.await_reply).toBeUndefined();
  });

  test('an explicit effect = "at_most_once" is accepted', () => {
    const toml = `${HEADER}
[[steps]]
id = "send"
do = "emit"
channel = "ws"
payload = "hi"
effect = "at_most_once"
`;
    const loaded = parseFlowFile(toml, "flow.toml");
    expect(loaded.flow.steps[0]?.do).toBe("emit");
  });
});

describe("EmitStepSchema — rejects", () => {
  test('channel other than "ws"', () => {
    const toml = `${HEADER}
[[steps]]
id = "send"
do = "emit"
channel = "http"
payload = "hi"
`;
    expect(() => parseFlowFile(toml, "flow.toml")).toThrow(FlowValidationError);
  });

  test("an explicit effect other than at_most_once", () => {
    const toml = `${HEADER}
[[steps]]
id = "send"
do = "emit"
channel = "ws"
payload = "hi"
effect = "idempotent"
`;
    expect(() => parseFlowFile(toml, "flow.toml")).toThrow(FlowValidationError);
  });

  test("a missing payload", () => {
    const toml = `${HEADER}
[[steps]]
id = "send"
do = "emit"
channel = "ws"
`;
    expect(() => parseFlowFile(toml, "flow.toml")).toThrow(FlowValidationError);
  });

  test("an unknown field (strict object)", () => {
    const toml = `${HEADER}
[[steps]]
id = "send"
do = "emit"
channel = "ws"
payload = "hi"
bogus_field = "x"
`;
    expect(() => parseFlowFile(toml, "flow.toml")).toThrow(FlowValidationError);
  });
});

describe("lint — emit step rules", () => {
  test("steps/required-fields fires for a missing payload", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "flow.toml");
    await Bun.write(
      path,
      `${HEADER}
[[steps]]
id = "send"
do = "emit"
channel = "ws"
`,
    );
    const result = await lintFile(path);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.ruleId)).toContain("steps/required-fields");
  });

  test("steps/emit-no-retry fires when retry.max > 0", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "flow.toml");
    await Bun.write(
      path,
      `${HEADER}
[[steps]]
id = "send"
do = "emit"
channel = "ws"
payload = "hi"
retry = { max = 2 }

[[steps.assert]]
type = "text"
text = "sent"
`,
    );
    const result = await lintFile(path);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.ruleId)).toContain("steps/emit-no-retry");
  });

  test("a clean emit step (with a deterministic postcondition) lints ok", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "flow.toml");
    await Bun.write(
      path,
      `${HEADER}
[[steps]]
id = "send"
do = "emit"
channel = "ws"
payload = { type = "client.response.text", content = "hi" }

[[steps.assert]]
type = "text"
text = "sent"
`,
    );
    const result = await lintFile(path);
    expect(result.ok).toBe(true);
  });
});
