// Flow tests: load valid, reject malformed (bad `do`, missing required field, ai_judge with
// threshold), discriminated-union narrowing, source_hash.

import { describe, expect, test } from "bun:test";
import {
  computeSourceHash,
  FlowValidationError,
  parseFlowFile,
} from "./index.ts";

const VALID_FLOW = `
version = 1
kind = "flow"
id = "admin.create_test_order"
description = "Create a test order"

[inputs]
base_url = "https://admin.example.com"

[run]
max_steps = 40
assertions = "eager"

[[steps]]
id = "open_orders"
do = "goto"
url = "\${inputs.base_url}/orders"

[[steps.assert]]
type = "visible"
text = "Orders"

[[steps]]
id = "new_order"
do = "click"
target = "button to create a new order"
hints = ["Create order", "[data-testid='create-order']"]

[[steps.assert]]
type = "visible"
text = "Create order"

[[steps]]
id = "enter_pw"
do = "fill"
target = "password field"
value = "\${env.PW}"
secret = true

[[steps]]
id = "pick_product"
do = "ai_pick"
target = "product row"
intent = "Choose any in-stock product"

[[steps.assert]]
type = "ai_judge"
inputs = ["screenshot"]
prompt = "The chosen product row is visibly selected."

[[steps]]
id = "wait_a_bit"
do = "wait"
ms = 500

[[steps]]
id = "press_enter"
do = "press"
key = "Enter"

[[steps]]
id = "check_count"
do = "assert"

[[steps.assert]]
type = "count"
count = 3
selector = ".order-row"
`;

describe("loadFlowFile / parseFlowFile", () => {
  test("loads a valid flow and narrows the discriminated unions", () => {
    const { flow, sourceHash } = parseFlowFile(VALID_FLOW, "valid.toml");
    expect(flow.kind).toBe("flow");
    expect(flow.steps).toHaveLength(7);
    expect(sourceHash.startsWith("sha256:")).toBe(true);

    const goto = flow.steps[0]!;
    expect(goto.do).toBe("goto");
    if (goto.do === "goto") {
      // narrowed → `url` is present and typed
      expect(goto.url).toBe("${inputs.base_url}/orders");
    }

    const fill = flow.steps[2]!;
    if (fill.do === "fill") {
      expect(fill.value).toBe("${env.PW}");
      expect(fill.secret).toBe(true);
    }

    const aiPick = flow.steps[3]!;
    expect(aiPick.do).toBe("ai_pick");

    // ai_judge assertion on the ai_pick step
    const judgeAssert = aiPick.assert?.[0]!;
    expect(judgeAssert.type).toBe("ai_judge");
    if (judgeAssert.type === "ai_judge") {
      expect(judgeAssert.prompt).toBe("The chosen product row is visibly selected.");
      expect(judgeAssert.inputs).toEqual(["screenshot"]);
    }
  });

  test("computeSourceHash is stable and deterministic", () => {
    expect(computeSourceHash("abc")).toBe(computeSourceHash("abc"));
    expect(computeSourceHash("abc")).not.toBe(computeSourceHash("abd"));
  });
});

describe("flow validation rejects malformed input", () => {
  test("rejects an unsupported `do`", () => {
    const bad = `
version = 1
kind = "flow"
id = "x"
description = "d"
[[steps]]
id = "s1"
do = "teleport"
`;
    expect(() => parseFlowFile(bad, "bad.toml")).toThrow(FlowValidationError);
  });

  test("rejects goto missing url", () => {
    const bad = `
version = 1
kind = "flow"
id = "x"
description = "d"
[[steps]]
id = "s1"
do = "goto"
`;
    expect(() => parseFlowFile(bad, "bad.toml")).toThrow(FlowValidationError);
  });

  test("rejects fill missing value", () => {
    const bad = `
version = 1
kind = "flow"
id = "x"
description = "d"
[[steps]]
id = "s1"
do = "fill"
target = "field"
`;
    expect(() => parseFlowFile(bad, "bad.toml")).toThrow(FlowValidationError);
  });

  test("rejects ai_judge carrying a threshold (strict object)", () => {
    const bad = `
version = 1
kind = "flow"
id = "x"
description = "d"
[[steps]]
id = "s1"
do = "click"
target = "btn"
[[steps.assert]]
type = "ai_judge"
prompt = "ok?"
inputs = ["screenshot"]
threshold = 0.8
`;
    expect(() => parseFlowFile(bad, "bad.toml")).toThrow(FlowValidationError);
  });

  test("rejects an unsupported assert type", () => {
    const bad = `
version = 1
kind = "flow"
id = "x"
description = "d"
[[steps]]
id = "s1"
do = "click"
target = "btn"
[[steps.assert]]
type = "screenshot_matches"
`;
    expect(() => parseFlowFile(bad, "bad.toml")).toThrow(FlowValidationError);
  });

  test("rejects a flow with the wrong kind", () => {
    const bad = `
version = 1
kind = "config"
id = "x"
description = "d"
[[steps]]
id = "s1"
do = "wait"
ms = 1
`;
    expect(() => parseFlowFile(bad, "bad.toml")).toThrow(FlowValidationError);
  });

  test("rejects a flow with no steps", () => {
    const bad = `
version = 1
kind = "flow"
id = "x"
description = "d"
`;
    expect(() => parseFlowFile(bad, "bad.toml")).toThrow(FlowValidationError);
  });
});
