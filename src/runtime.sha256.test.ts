import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { sha256Text } from "./runtime.ts";

describe("sha256Text (noble/hashes)", () => {
  test("matches known vectors", () => {
    expect(sha256Text("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("matches node:crypto sha256 over a corpus", () => {
    const corpus = [
      "",
      "hello",
      "hello world",
      "hello world éü — unicode",
      "a".repeat(10_000),
      JSON.stringify({ a: 1, b: [1, 2, 3], c: "x".repeat(500) }),
    ];
    for (const text of corpus) {
      expect(sha256Text(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });
});
