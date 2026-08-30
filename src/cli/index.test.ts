import { afterEach, describe, expect, test } from "bun:test";
import { main } from "./index.ts";

const originalError = console.error;

afterEach(() => {
  console.error = originalError;
});

function captureErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  return { lines, restore: () => (console.error = originalError) };
}

describe("command validation", () => {
  test("rejects flags that belong to a different command", async () => {
    const captured = captureErrors();
    try {
      expect(await main(["lint", "flow.toml", "--trials", "2"])).toBe(2);
      expect(captured.lines.join("\n")).toContain("lint: flag --trials is not supported");
    } finally {
      captured.restore();
    }
  });

  test("rejects extra operands for single-flow commands before dispatch", async () => {
    const captured = captureErrors();
    try {
      expect(await main(["run", "flow.toml", "another.toml"])).toBe(2);
      expect(captured.lines.join("\n")).toContain("run: expected exactly one path argument");
    } finally {
      captured.restore();
    }
  });
});
