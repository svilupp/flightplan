// Flow tests: load valid, reject malformed (bad `do`, missing required field, ai_judge with
// threshold), discriminated-union narrowing, source_hash.

import { describe, expect, test } from "bun:test";
import { computeSourceHash, FlowValidationError, parseFlowFile } from "./index.ts";

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
target = ["[data-testid='create-order']", "button to create a new order"]

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
target = "any in-stock product row"

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
    const judgeAssert = aiPick.assert![0]!;
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

// verify (fill-verification normalization mode): schema acceptance/rejection.
describe("fill step verify option", () => {
  function flowWith(stepToml: string): string {
    return `
version = 1
kind = "flow"
id = "x"
description = "d"
[[steps]]
${stepToml}
`;
  }

  test.each(["exact", "normalized", "off"])("accepts verify = %s on a fill step", (mode) => {
    const { flow } = parseFlowFile(
      flowWith(`id = "s1"\ndo = "fill"\ntarget = "field"\nvalue = "x"\nverify = "${mode}"`),
      "ok.toml",
    );
    const step = flow.steps[0]!;
    expect("verify" in step && step.verify).toBe(mode);
  });

  test("omitting verify leaves it undefined (default is applied at ladder dispatch time)", () => {
    const { flow } = parseFlowFile(
      flowWith('id = "s1"\ndo = "fill"\ntarget = "field"\nvalue = "x"'),
      "ok.toml",
    );
    const step = flow.steps[0]!;
    expect(step.do === "fill" ? step.verify : "n/a").toBeUndefined();
  });

  test("rejects an invalid verify value", () => {
    expect(() =>
      parseFlowFile(
        flowWith('id = "s1"\ndo = "fill"\ntarget = "field"\nvalue = "x"\nverify = "bogus"'),
        "bad.toml",
      ),
    ).toThrow(FlowValidationError);
  });
});

// tier_hint (PLAN_v003 §4 v003-3): the vision-batch opt-in on targeting steps.
describe("tier_hint = vision on targeting steps", () => {
  function flowWith(stepToml: string): string {
    return `
version = 1
kind = "flow"
id = "x"
description = "d"
[[steps]]
${stepToml}
`;
  }

  test.each(["click", "ai_pick"])("accepts tier_hint = vision on a %s step", (verb) => {
    const { flow } = parseFlowFile(
      flowWith(`id = "s1"\ndo = "${verb}"\ntarget = "trash icon"\ntier_hint = "vision"`),
      "ok.toml",
    );
    const step = flow.steps[0]!;
    // The field is present on the narrowed step (types derive from the schema via z.infer).
    expect("tier_hint" in step && step.tier_hint).toBe("vision");
  });

  test("accepts tier_hint = vision on fill / select (alongside value)", () => {
    const fill = parseFlowFile(
      flowWith(`id = "s1"\ndo = "fill"\ntarget = "field"\nvalue = "x"\ntier_hint = "vision"`),
      "ok.toml",
    ).flow.steps[0]!;
    const select = parseFlowFile(
      flowWith(`id = "s1"\ndo = "select"\ntarget = "menu"\nvalue = "x"\ntier_hint = "vision"`),
      "ok.toml",
    ).flow.steps[0]!;
    expect("tier_hint" in fill && fill.tier_hint).toBe("vision");
    expect("tier_hint" in select && select.tier_hint).toBe("vision");
  });

  test("omitting tier_hint leaves it undefined (normal cheap-first ladder)", () => {
    const { flow } = parseFlowFile(flowWith(`id = "s1"\ndo = "click"\ntarget = "btn"`), "ok.toml");
    const step = flow.steps[0]!;
    expect(step.do).toBe("click");
    // Narrow to the click variant so `tier_hint` is a typed (optional) field, absent here.
    if (step.do === "click") expect(step.tier_hint).toBeUndefined();
  });

  test("rejects an invalid tier_hint value (only 'vision' is allowed)", () => {
    expect(() =>
      parseFlowFile(
        flowWith(`id = "s1"\ndo = "click"\ntarget = "btn"\ntier_hint = "text"`),
        "bad.toml",
      ),
    ).toThrow(FlowValidationError);
  });

  test("rejects tier_hint on a non-targeting step (goto is strict)", () => {
    expect(() =>
      parseFlowFile(
        flowWith(`id = "s1"\ndo = "goto"\nurl = "http://x"\ntier_hint = "vision"`),
        "bad.toml",
      ),
    ).toThrow(FlowValidationError);
  });
});
