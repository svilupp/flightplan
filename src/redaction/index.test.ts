// Flightplan — redaction unit tests (PLAN.md §5 Phase 5; acceptance: "no secret reaches ai.jsonl").
//
// Pure + offline: no network, no driver, no SDK. Covers secret masking (substring + wholesale),
// PII patterns, deep JSON walking, fail-closed behavior (a `secret:true` value NEVER survives even
// with mask_text off), the disabled identity case, and `gatherSecretValues`.

import { describe, expect, test } from "bun:test";
import type { Step } from "../flow/types.ts";
import { createRedactor, DEFAULT_PII_PATTERNS, gatherSecretValues, REDACTED } from "./index.ts";

const fill = (over: Partial<Step> = {}): Step =>
  ({ id: "s1", do: "fill", target: "Password", value: "hunter2", ...over }) as Step;

describe("createRedactor — secret masking", () => {
  test("masks an exact secret substring wherever it appears", () => {
    const r = createRedactor({ maskText: true, secrets: ["hunter2"] });
    const out = r.redactText("login with hunter2 then hunter2 again");
    expect(out).not.toContain("hunter2");
    expect(out).toContain(REDACTED);
    // Both occurrences masked.
    expect(out.split(REDACTED).length - 1).toBe(2);
  });

  test("redactValue masks a known secret value wholesale", () => {
    const r = createRedactor({ maskText: true, secrets: ["s3cr3t-token"] });
    expect(r.redactValue("s3cr3t-token")).toBe(REDACTED);
    // A non-secret value passes through redactText (no PII here → unchanged).
    expect(r.redactValue("plain-text")).toBe("plain-text");
  });

  test("longest-overlapping secret wins", () => {
    const r = createRedactor({ maskText: true, secrets: ["abc", "abcdef"] });
    const out = r.redactText("value=abcdef");
    expect(out).toBe(`value=${REDACTED}`);
    expect(out).not.toContain("abc");
  });

  test("secretCount reflects deduped, non-empty secrets", () => {
    const r = createRedactor({ maskText: true, secrets: ["a", "a", "", "b"] });
    expect(r.secretCount).toBe(2);
  });
});

describe("createRedactor — PII patterns (gated on maskText)", () => {
  test("masks email / bearer / sk- / Authorization / long digit runs", () => {
    const r = createRedactor({ maskText: true });
    expect(r.redactText("contact a.b+x@example.com")).not.toContain("example.com");
    expect(r.redactText("Bearer abc123DEF._-456")).not.toContain("abc123DEF");
    expect(r.redactText("key sk-or-abcd1234efgh")).not.toContain("sk-or-abcd1234efgh");
    expect(r.redactText("Authorization: Bearer zzz")).not.toContain("zzz");
    expect(r.redactText("otp 482915 now")).not.toContain("482915");
  });

  test("conservative — leaves ordinary prose untouched", () => {
    const r = createRedactor({ maskText: true });
    const prose = "Click the Create Order button and confirm the modal.";
    expect(r.redactText(prose)).toBe(prose);
  });

  test("DEFAULT_PII_PATTERNS is exported and non-empty", () => {
    expect(DEFAULT_PII_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("createRedactor — fail-closed", () => {
  test("secret values are masked even when maskText is false", () => {
    const r = createRedactor({ maskText: false, secrets: ["hunter2"] });
    expect(r.enabled).toBe(true);
    expect(r.redactText("pw=hunter2")).toBe(`pw=${REDACTED}`);
    // But PII scrubbing is OFF when maskText is false.
    expect(r.redactText("mail a@b.com")).toBe("mail a@b.com");
  });

  test("a marked secret never survives redactJson on any string leaf", () => {
    const r = createRedactor({ maskText: false, secrets: ["topsecret"] });
    const obj = { a: "x topsecret y", nested: { b: ["topsecret", 1, { c: "topsecret!" }] } };
    const out = r.redactJson(obj);
    expect(JSON.stringify(out)).not.toContain("topsecret");
    // Structure + non-string leaves preserved.
    expect(out.nested.b[1]).toBe(1);
  });
});

describe("createRedactor — disabled identity", () => {
  test("no secrets + maskText false → identity (and not enabled)", () => {
    const r = createRedactor({ maskText: false });
    expect(r.enabled).toBe(false);
    const s = "anything a@b.com Bearer xyz 123456";
    expect(r.redactText(s)).toBe(s);
    expect(r.redactValue(s)).toBe(s);
    const inputs = { A: "1", B: "a@b.com" };
    expect(r.redactInputs(inputs)).toEqual(inputs);
    const obj = { x: "a@b.com" };
    expect(r.redactJson(obj)).toBe(obj); // same reference (identity)
  });
});

describe("createRedactor — redactInputs", () => {
  test("secret-backing inputs masked wholesale, other inputs PII-scrubbed", () => {
    const r = createRedactor({ maskText: true, secrets: ["pw-value"] });
    const out = r.redactInputs({ PASSWORD: "pw-value", EMAIL: "a@b.com", NAME: "Jan" });
    expect(out.PASSWORD).toBe(REDACTED);
    expect(out.EMAIL).toBe(REDACTED); // email PII pattern
    expect(out.NAME).toBe("Jan");
  });
});

describe("gatherSecretValues", () => {
  test("collects secret:true fill values", () => {
    const steps: Step[] = [
      fill({ id: "a", value: "pw1", secret: true }),
      fill({ id: "b", value: "not-secret" }), // no secret flag
      fill({ id: "c", value: "pw2", secret: true }),
    ];
    const got = gatherSecretValues(steps, {});
    expect(got.has("pw1")).toBe(true);
    expect(got.has("pw2")).toBe(true);
    expect(got.has("not-secret")).toBe(false);
  });

  test("adds backing input values embedded in a secret fill value", () => {
    // Post-templating: value = "prefix-SECRET" backed by input PASSWORD="SECRET".
    const steps: Step[] = [fill({ id: "a", value: "prefix-SECRET", secret: true })];
    const got = gatherSecretValues(steps, { PASSWORD: "SECRET", OTHER: "unrelated" });
    expect(got.has("prefix-SECRET")).toBe(true);
    expect(got.has("SECRET")).toBe(true); // bare backing input also masked
    expect(got.has("unrelated")).toBe(false);
  });

  test("no secret fills → empty set", () => {
    const steps: Step[] = [fill({ id: "a", value: "x" })];
    expect(gatherSecretValues(steps, { A: "x" }).size).toBe(0);
  });

  test("collects secret:true value on a SELECT step (B7 — not only fills)", () => {
    // A select whose chosen option is a secret must be masked exactly like a secret fill.
    const steps: Step[] = [
      { id: "pick", do: "select", target: "the plan", value: "SECRET-PLAN", secret: true },
      { id: "pick2", do: "select", target: "region", value: "eu-west" }, // no secret flag
    ];
    const got = gatherSecretValues(steps, {});
    expect(got.has("SECRET-PLAN")).toBe(true);
    expect(got.has("eu-west")).toBe(false);
  });

  test("collects a secret:true GOTO url + its backing input (B7)", () => {
    // A goto whose URL embeds a secret token (e.g. a signed link) must be masked.
    const steps: Step[] = [
      {
        id: "open",
        do: "goto",
        url: "https://x.test/callback?token=abc123TOKEN",
        secret: true,
      },
    ];
    const got = gatherSecretValues(steps, { TOKEN: "abc123TOKEN" });
    expect(got.has("https://x.test/callback?token=abc123TOKEN")).toBe(true);
    expect(got.has("abc123TOKEN")).toBe(true); // bare backing input also masked
  });

  test("a non-secret select/goto value is NOT collected", () => {
    const steps: Step[] = [
      { id: "s", do: "select", target: "t", value: "public" },
      { id: "g", do: "goto", url: "https://x.test/public" },
    ];
    expect(gatherSecretValues(steps, {}).size).toBe(0);
  });
});
