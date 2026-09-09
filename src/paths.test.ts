import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { dirname, isAbsolute, join, normalize, resolve } from "./paths.ts";

describe("paths (parity with node:path posix)", () => {
  test("dirname matches node:path.posix.dirname", () => {
    const cases = ["/a/b/c", "/a/b/", "/a", "/", "a/b", "a", "./a/b"];
    for (const c of cases) {
      expect(dirname(c)).toBe(nodePath.posix.dirname(c));
    }
  });

  test("isAbsolute matches node:path.posix.isAbsolute for posix paths", () => {
    const cases = ["/a/b", "a/b", "", "/", "./a"];
    for (const c of cases) {
      expect(isAbsolute(c)).toBe(nodePath.posix.isAbsolute(c));
    }
  });

  test("isAbsolute recognizes Windows drive-letter absolutes", () => {
    expect(isAbsolute("C:\\Users\\me")).toBe(true);
    expect(isAbsolute("C:/Users/me")).toBe(true);
    expect(isAbsolute("relative\\path")).toBe(false);
  });

  test("normalize converts backslashes to forward slashes", () => {
    expect(normalize("a\\b\\c")).toBe("a/b/c");
  });

  test("join matches node:path.posix.join for used shapes", () => {
    const cases: Array<string[]> = [["/a", "b", "c"], ["a", "./b", "../c"], ["/a/b", ".."], ["a"]];
    for (const parts of cases) {
      expect(join(...parts)).toBe(nodePath.posix.join(...parts));
    }
  });

  test("resolve matches node:path.posix.resolve for a required explicit base", () => {
    const cases: Array<[string, string[]]> = [
      ["/a/b", ["c"]],
      ["/a/b", ["../c"]],
      ["/a/b", ["/x/y"]],
      ["/a", ["b", "c", ".."]],
    ];
    for (const [base, parts] of cases) {
      expect(resolve(base, ...parts)).toBe(nodePath.posix.resolve(base, ...parts));
    }
  });

  test("resolve preserves relative bases for the filesystem adapter", () => {
    expect(resolve("flows", "./child.toml")).toBe("flows/child.toml");
    expect(resolve(".", "./child.toml")).toBe("child.toml");
    expect(resolve("flows", "../../child.toml")).toBe("../child.toml");
    expect(resolve("flows", "/shared/child.toml")).toBe("/shared/child.toml");
    expect(resolve("", "child.toml")).toBe("child.toml");
    expect(resolve("flows", "..")).toBe(".");
  });
});
