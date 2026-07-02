// for_each expansion tests: load-time expansion into concrete steps with stable/unique ids,
// `${item}` / `${loop.*}` templating into target/hints/value/url, array-of-tables items, token
// scoping (loop tokens outside a for_each step is a hard error), and `${inputs.*}` left intact.

import { describe, expect, test } from "bun:test";
import { FlowValidationError, parseFlowFile } from "./index.ts";
import { expandForEachSteps, ForEachError } from "./normalize.ts";

describe("expandForEachSteps (raw)", () => {
  test("expands a string array into N concrete steps with stable 1-based ids", () => {
    const steps = [
      {
        id: "add_item",
        do: "click",
        for_each: ["Headphones", "Keyboard", "Cable"],
        target: "the Add-to-cart button for ${item}",
        hints: ["[data-testid='add-${item}']"],
      },
    ];
    const out = expandForEachSteps(steps, "x.toml");
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.id)).toEqual(["add_item#1", "add_item#2", "add_item#3"]);
    expect(out[0]!.target).toBe("the Add-to-cart button for Headphones");
    expect(out[1]!.target).toBe("the Add-to-cart button for Keyboard");
    expect(out[0]!.hints).toEqual(["[data-testid='add-Headphones']"]);
    // `for_each` is consumed — never leaks downstream.
    expect("for_each" in out[0]!).toBe(false);
  });

  test("templates ${loop.index} (0-based) and ${loop.index1} (1-based)", () => {
    const steps = [
      {
        id: "row",
        do: "fill",
        for_each: ["a", "b"],
        value: "row ${loop.index} / ${loop.index1}: ${item}",
      },
    ];
    const out = expandForEachSteps(steps, "x.toml");
    expect(out[0]!.value).toBe("row 0 / 1: a");
    expect(out[1]!.value).toBe("row 1 / 2: b");
  });

  test("array-of-tables items expose ${item.key}", () => {
    const steps = [
      {
        id: "add",
        do: "fill",
        for_each: [
          { name: "Sam", email: "sam@acme.com" },
          { name: "Lee", email: "lee@acme.com" },
        ],
        target: "the field for ${item.name}",
        value: "${item.email}",
      },
    ];
    const out = expandForEachSteps(steps, "x.toml");
    expect(out).toHaveLength(2);
    expect(out[0]!.target).toBe("the field for Sam");
    expect(out[0]!.value).toBe("sam@acme.com");
    expect(out[1]!.value).toBe("lee@acme.com");
  });

  test("leaves ${inputs.*} / ${env.*} untouched for the later templating pass", () => {
    const steps = [{ id: "s", do: "goto", for_each: ["one"], url: "${inputs.base_url}/${item}" }];
    const out = expandForEachSteps(steps, "x.toml");
    expect(out[0]!.url).toBe("${inputs.base_url}/one");
  });

  test("passes non-for_each steps through unchanged", () => {
    const steps = [{ id: "keep", do: "wait", ms: 5 }];
    const out = expandForEachSteps(steps, "x.toml");
    expect(out).toEqual(steps);
  });

  test("throws on a ${item} token in a step WITHOUT for_each (scoping)", () => {
    const steps = [{ id: "stray", do: "click", target: "click ${item}" }];
    expect(() => expandForEachSteps(steps, "x.toml")).toThrow(ForEachError);
  });

  test("throws on an unknown loop token inside a for_each step", () => {
    const steps = [{ id: "s", do: "click", for_each: ["a"], target: "${loop.bogus}" }];
    expect(() => expandForEachSteps(steps, "x.toml")).toThrow(ForEachError);
  });

  test("throws on ${item.key} against a plain-string item", () => {
    const steps = [{ id: "s", do: "click", for_each: ["a"], target: "${item.name}" }];
    expect(() => expandForEachSteps(steps, "x.toml")).toThrow(ForEachError);
  });

  test("throws on an empty for_each array", () => {
    const steps = [{ id: "s", do: "click", for_each: [], target: "x" }];
    expect(() => expandForEachSteps(steps, "x.toml")).toThrow(ForEachError);
  });
});

describe("parseFlowFile with for_each", () => {
  const FLOW = `
version = 1
kind = "flow"
id = "test.loops"
description = "for_each expansion"

[inputs]
base_url = "http://localhost:3100"

[[steps]]
id = "open"
do = "goto"
url = "\${inputs.base_url}/checkout"

[[steps]]
id = "add_item"
do = "click"
for_each = ["Headphones", "Keyboard", "Cable"]
target = ["[data-testid='add-\${item}']", "the Add to cart button for \${item}"]
`;

  test("the parsed flow sees concrete, uniquely-id'd expanded steps", () => {
    const { flow } = parseFlowFile(FLOW, "loops.toml");
    // 1 goto + 3 expanded clicks.
    expect(flow.steps).toHaveLength(4);
    const ids = flow.steps.map((s) => s.id);
    expect(ids).toEqual(["open", "add_item#1", "add_item#2", "add_item#3"]);
    // Lock-key uniqueness: expanded ids are all distinct.
    expect(new Set(ids).size).toBe(ids.length);
    const first = flow.steps[1]!;
    if (first.do === "click") {
      // `${inputs.*}` was NOT touched by loop expansion (resolved later at run time), and each
      // target list entry (selector + NL) was templated with the per-iteration ${item}.
      expect(first.target).toEqual([
        "[data-testid='add-Headphones']",
        "the Add to cart button for Headphones",
      ]);
    }
  });

  test("a stray ${item} outside a for_each step fails flow validation", () => {
    const bad = `
version = 1
kind = "flow"
id = "x"
description = "d"
[[steps]]
id = "s1"
do = "click"
target = "click \${item}"
`;
    expect(() => parseFlowFile(bad, "bad.toml")).toThrow(FlowValidationError);
  });
});
