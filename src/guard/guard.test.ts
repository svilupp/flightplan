import { expect, test } from "bun:test";
import { MockDriver } from "../driver/mock-driver.ts";
import { createGuardedDriver, GuardBlockedError, setGuardStep } from "./driver.ts";
import { createJevGuard } from "./jev.ts";
import type { ActionGuardOptions, ActionProposal, GuardObservation } from "./types.ts";

const allow = async () => ({ decision: "allow" as const, reason: "allowed" });
const redact = (s: string) => s.replaceAll("canary-secret", "[REDACTED]");
function guarded(options: Partial<ActionGuardOptions> = {}) {
  const raw = new MockDriver();
  const observations: GuardObservation[] = [];
  const driver = createGuardedDriver(
    raw,
    {
      mode: "enforce",
      policyVersion: "test-v1",
      evaluate: allow,
      onObservation: (o) => {
        observations.push(o);
      },
      ...options,
    },
    redact,
  );
  return { raw, driver, observations };
}
for (const decision of ["deny", "unknown"] as const) {
  test(`${decision} vetoes every direct mutation without browser input`, async () => {
    const { raw, driver, observations } = guarded({
      evaluate: async () => ({ decision, reason: "policy" }),
    });
    raw.setEvaluateResult(true);
    raw.setWebmcpResult({
      ok: true,
      result: null,
      phase: "invoke",
      retrySafe: false,
      dispatchState: "dispatched",
    });
    const operations = [
      () => driver.batch([{ action: "click", selector: ["#a", "#b"] }]),
      () => driver.goto("https://example.com"),
      () => driver.press("Enter"),
      () => driver.click("#a"),
      () => driver.fill("#a", "canary-secret"),
      () => driver.type("#a", "canary-secret"),
      () => driver.select("#a", "b"),
      () => driver.check("#a"),
      () => driver.hover("#a"),
      () => driver.submit("#a"),
      () => driver.evalInFrame({ script: "canary-secret" }),
      () => driver.evaluateExpression!("canary-secret"),
      () => driver.webmcpCall!({ tool: "refund", input: {}, allowMutation: true }),
      () => driver.clearBrowserState(),
    ];
    for (const operation of operations)
      await expect(operation()).rejects.toBeInstanceOf(GuardBlockedError);
    expect(
      raw.calls.filter((c) => !["snapshot", "currentUrl", "currentFrame"].includes(c.method)),
    ).toEqual([]);
    expect(observations).toHaveLength(operations.length);
    expect(JSON.stringify(observations)).not.toContain("canary-secret");
  });
}
test("allow without atomic target binding fails closed", async () => {
  const { driver, raw, observations } = guarded();
  await expect(driver.batch([{ action: "click", selector: ["#a", "#b"] }])).rejects.toThrow(
    "atomic_dispatch_unavailable",
  );
  expect(raw.callsTo("batch")).toHaveLength(0);
  expect(observations[0]?.verdict.decision).toBe("unknown");
});
test("owner dispatcher receives exact proposed action and can reject a changed fallback", async () => {
  const { driver, raw } = guarded({
    dispatchAssurance: () => "renderer-same-task-dom",
    dispatch: async (proposal, invocation) => {
      expect(proposal.selectors).toEqual(["#a", "#b"]);
      expect(invocation.operation).toBe("batch");
      throw new GuardBlockedError("target_changed");
    },
  });
  await expect(driver.batch([{ action: "click", selector: ["#a", "#b"] }])).rejects.toThrow(
    "target_changed",
  );
  expect(raw.callsTo("batch")).toHaveLength(0);
});
test("shadow outage, deny and observer rejection preserve authoritative dispatch", async () => {
  for (const evaluate of [
    async () => {
      throw new Error("canary-secret");
    },
    async () => ({ decision: "deny" as const, reason: "denied" }),
  ]) {
    const { driver, raw } = guarded({
      mode: "shadow",
      evaluate,
      onObservation: async () => {
        throw new Error("observer");
      },
    });
    await driver.press("Enter");
    expect(raw.callsTo("press")).toHaveLength(1);
  }
});
test("budget and uncooperative evaluator are bounded and do not dispatch", async () => {
  const { driver, raw } = guarded({ maxEvaluations: 0 });
  await expect(driver.press("Enter")).rejects.toBeInstanceOf(GuardBlockedError);
  const slow = guarded({ timeoutMs: 5, evaluate: () => new Promise(() => {}) });
  await expect(slow.driver.press("Enter")).rejects.toBeInstanceOf(GuardBlockedError);
  expect(raw.callsTo("press")).toHaveLength(0);
  expect(slow.raw.callsTo("press")).toHaveLength(0);
});
test("step intent and fresh evidence are redacted before evaluation", async () => {
  let seen: ActionProposal | undefined;
  const { driver } = guarded({
    evaluate: async (proposal) => {
      seen = structuredClone(proposal);
      return { decision: "deny", reason: "policy" };
    },
  });
  setGuardStep(driver, {
    id: "refund",
    do: "click",
    target: "canary-secret",
    effect: "at_most_once",
  });
  await expect(driver.press("Enter")).rejects.toBeInstanceOf(GuardBlockedError);
  expect(seen?.stepId).toBe("refund");
  expect(seen?.effect).toBe("at_most_once");
  expect(JSON.stringify(seen)).not.toContain("canary-secret");
});
const proposal: ActionProposal = {
  version: 1,
  id: "test",
  policyVersion: "v1",
  operation: "press",
  action: "press",
  selectors: [],
  payload: "redacted",
  evidence: { url: "https://example.com", frame: null, text: "Orders", observedAt: 0 },
};
for (const [values, decision] of [
  [[1, 1, 1], "allow"],
  [[0, 1, 1], "deny"],
  [[1, 0.5, 1], "unknown"],
  [[1, 1, 0], "unknown"],
] as const) {
  test(`JEV combines independent questions ${values.join(",")} as ${decision}`, async () => {
    const evaluate = createJevGuard({
      apiKey: "fake",
      policy: "Never refund",
      fetchFn: (async (_url: unknown, init?: RequestInit) => {
        const request = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        expect(Object.keys(request.questions)).toEqual(["permitted", "matches", "sufficient"]);
        expect(request.state.policy).toBe("Never refund");
        return new Response(
          JSON.stringify({
            model: "jev-1.14.0",
            answers: Object.fromEntries(
              Object.keys(request.questions).map((key, i) => [
                key,
                { type: "noul", noul: values[i] },
              ]),
            ),
            usage: { input_tokens: 20, output_tokens: 0 },
          }),
        );
      }) as unknown as typeof fetch,
    });
    expect((await evaluate(proposal, new AbortController().signal)).decision).toBe(decision);
  });
}
test("JEV malformed response and transport failure remain unknown", async () => {
  for (const fetchFn of [
    (async () => new Response("{}")) as unknown as typeof fetch,
    (async () => {
      throw new Error("canary-secret");
    }) as unknown as typeof fetch,
  ]) {
    expect(
      await createJevGuard({ apiKey: "fake", policy: "policy", fetchFn })(
        proposal,
        new AbortController().signal,
      ),
    ).toEqual({ decision: "unknown", reason: "jev_unavailable" });
  }
});

test("owner atomic dispatcher permits the approved identity once", async () => {
  const identity = {
    documentId: "doc1",
    targetId: "button1",
    resourceId: "order1",
    ownerEpoch: "owner1",
    grantToken: "grant1",
  };
  const { driver, raw, observations } = guarded({
    identify: async () => identity,
    dispatchAssurance: () => "renderer-same-task-dom",
    dispatch: async (proposal, invocation) => {
      expect(proposal.evidence.identity).toEqual(identity);
      return invocation.driver.press("Enter");
    },
  });
  expect(await driver.press("Enter")).toBe(true);
  expect(raw.callsTo("press")).toHaveLength(1);
  expect(observations[0]?.dispatched).toBe(true);
});
for (const field of ["documentId", "targetId", "resourceId", "ownerEpoch", "grantToken"] as const) {
  test(`owner atomic validation rejects changed ${field} after guard approval`, async () => {
    let current = {
      documentId: "doc1",
      targetId: "button1",
      resourceId: "order1",
      ownerEpoch: "owner1",
      grantToken: "grant1",
    };
    const { driver, raw } = guarded({
      identify: async () => ({ ...current }),
      evaluate: async () => {
        current = { ...current, [field]: "changed" };
        return { decision: "allow", reason: "allowed" };
      },
      dispatchAssurance: () => "renderer-same-task-dom",
      dispatch: async (proposal, invocation) => {
        if (JSON.stringify(proposal.evidence.identity) !== JSON.stringify(current))
          throw new GuardBlockedError("identity_changed");
        return invocation.driver.press("Enter");
      },
    });
    await expect(driver.press("Enter")).rejects.toThrow("identity_changed");
    expect(raw.callsTo("press")).toHaveLength(0);
  });
}
test("shadow model latency cannot delay authoritative input or consume a snapshot", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { driver, raw } = guarded({
    mode: "shadow",
    evaluate: async () => {
      await gate;
      return { decision: "deny", reason: "policy" };
    },
  });
  const pending = driver.press("Enter");
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(raw.callsTo("press")).toHaveLength(1);
  expect(raw.callsTo("snapshot")).toHaveLength(0);
  finish();
  await pending;
});
test("unsafe image evidence is withheld before model transport", async () => {
  let requests = 0;
  const evaluate = createJevGuard({
    apiKey: "fake",
    policy: "policy",
    imageEvidence: async (p) => ({
      proposalId: p.id,
      documentId: "doc",
      evidence: { pixelsSafe: false } as never,
    }),
    fetchFn: (async () => {
      requests++;
      return new Response("{}");
    }) as unknown as typeof fetch,
  });
  expect(
    await evaluate(
      {
        ...proposal,
        evidence: {
          ...proposal.evidence,
          identity: {
            documentId: "doc",
            targetId: "target",
            resourceId: "resource",
            ownerEpoch: "owner",
            grantToken: "grant",
          },
        },
      },
      new AbortController().signal,
    ),
  ).toEqual({ decision: "unknown", reason: "jev_unavailable" });
  expect(requests).toBe(0);
});
test("redacted snapshot evidence and payload values never reach guard transport", async () => {
  const raw = new MockDriver();
  raw.setSnapshot({
    url: "https://example.com",
    title: "",
    timestamp: "",
    text: "",
    interactiveElements: [],
    accessibilityTree: "canary-secret" as never,
  });
  let seen = "";
  const driver = createGuardedDriver(
    raw,
    {
      mode: "enforce",
      policyVersion: "v1",
      evaluate: async (p) => {
        seen = JSON.stringify(p);
        return { decision: "deny", reason: "policy" };
      },
    },
    redact,
  );
  await driver.snapshot();
  await expect(driver.fill("#secret", "canary-secret")).rejects.toThrow();
  expect(seen).not.toContain("canary-secret");
  expect(seen).toContain("[REDACTED]");
});

test("cancellation after model approval cannot enter the atomic dispatcher", async () => {
  const controller = new AbortController();
  let dispatched = false;
  const { driver } = guarded({
    signal: controller.signal,
    evaluate: async () => {
      controller.abort();
      return { decision: "allow", reason: "allowed" };
    },
    dispatch: async () => {
      dispatched = true;
      return true;
    },
  });
  await expect(driver.press("Enter")).rejects.toThrow();
  expect(dispatched).toBe(false);
});

test("missing identity keys cannot reach guard evaluation or dispatch", async () => {
  let evaluated = 0,
    dispatched = 0;
  const { driver } = guarded({
    identify: async () => ({}) as never,
    evaluate: async () => {
      evaluated++;
      return { decision: "allow", reason: "allowed" };
    },
    dispatch: async () => {
      dispatched++;
    },
  });
  await expect(driver.press("Enter")).rejects.toThrow();
  expect(evaluated).toBe(0);
  expect(dispatched).toBe(0);
});
test("guard rejects a multiple-action batch instead of approving only its first action", async () => {
  let evaluated = 0;
  const { driver, raw } = guarded({
    evaluate: async () => {
      evaluated++;
      return { decision: "allow", reason: "allowed" };
    },
  });
  await expect(
    driver.batch([
      { action: "click", selector: "#read" },
      { action: "click", selector: "#refund" },
    ]),
  ).rejects.toThrow("multi_action_batch");
  expect(evaluated).toBe(0);
  expect(raw.callsTo("batch")).toHaveLength(0);
});
test("shadow returns authoritative result before evaluator and observer complete", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const observations: GuardObservation[] = [];
  const { driver, raw } = guarded({
    mode: "shadow",
    evaluate: async () => {
      await gate;
      return { decision: "deny", reason: "denied" };
    },
    onObservation: async (observation) => {
      observations.push(observation);
      await new Promise(() => {});
    },
    timeoutMs: 5,
  });
  expect(await driver.press("Enter")).toBe(true);
  expect(raw.callsTo("press")).toHaveLength(1);
  finish();
  const { drainGuardObservations } = await import("./driver.ts");
  await drainGuardObservations(driver);
  expect(observations[0]?.dispatched).toBe(true);
});

test("same URL image from another document cannot enter guard transport", async () => {
  let requests = 0;
  const evaluate = createJevGuard({
    apiKey: "fake",
    policy: "policy",
    imageEvidence: async (p) => ({
      proposalId: p.id,
      documentId: "new-doc",
      evidence: { url: p.evidence.url } as never,
    }),
    fetchFn: (async () => {
      requests++;
      return new Response("{}");
    }) as unknown as typeof fetch,
  });
  const withIdentity = {
    ...proposal,
    evidence: {
      ...proposal.evidence,
      identity: {
        documentId: "old-doc",
        targetId: "target",
        resourceId: "resource",
        ownerEpoch: "owner",
        grantToken: "grant",
      },
    },
  };
  expect(await evaluate(withIdentity, new AbortController().signal)).toEqual({
    decision: "unknown",
    reason: "image_binding_mismatch",
  });
  expect(requests).toBe(0);
});

test("a verified image bound to proposal and document reaches the strict image transport", async () => {
  const source = await Bun.file("src/ai/typesafe.test.ts").text();
  const data = source.match(/data_base64:\s*"([A-Za-z0-9+/=]+)"/)?.[1];
  if (!data) throw new Error("synthetic PNG missing");
  let requests = 0;
  const evaluate = createJevGuard({
    apiKey: "fake",
    policy: "allow read",
    imageEvidence: async (p) => ({
      proposalId: p.id,
      documentId: "doc",
      evidence: {
        captureId: "synthetic",
        url: p.evidence.url,
        frameId: "frame",
        signature: "signature",
        observedAtMs: Date.now(),
        image: { format: "png", data_base64: data, width: 280, height: 280 },
        geometry: {},
        viewport: { width: 280, height: 280, scrollX: 0, scrollY: 0, dpr: 1 },
        pixelsSafe: true,
      },
    }),
    validateImage: async () => true,
    fetchFn: (async (_url: unknown, init?: RequestInit) => {
      requests++;
      const request = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      expect(request.assets.guard_image.format).toBe("png");
      return new Response(
        JSON.stringify({
          model: "jev-1.14.0",
          answers: Object.fromEntries(
            Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 1 }]),
          ),
          usage: { input_tokens: 20, output_tokens: 0 },
        }),
      );
    }) as unknown as typeof fetch,
  });
  expect(
    (
      await evaluate(
        {
          ...proposal,
          evidence: {
            ...proposal.evidence,
            identity: {
              documentId: "doc",
              targetId: "target",
              resourceId: "resource",
              ownerEpoch: "owner",
              grantToken: "grant",
            },
          },
        },
        new AbortController().signal,
      )
    ).decision,
  ).toBe("allow");
  expect(requests).toBe(1);
});

test("native owner serialization cannot silently satisfy renderer-atomic policy", async () => {
  let dispatched = 0;
  const { driver, observations } = guarded({
    dispatchAssurance: () => "owner-serialized-prechecked-native",
    dispatch: async () => {
      dispatched++;
      return true;
    },
  });
  await expect(driver.press("Enter")).rejects.toThrow("dispatch_assurance_unavailable");
  expect(dispatched).toBe(0);
  expect(observations[0]?.dispatched).toBe(false);
});

test("native semantics require explicit host policy and operation capability", async () => {
  const { driver, raw } = guarded({
    requiredAssurance: "owner-serialized-prechecked-native",
    dispatchAssurance: (invocation) =>
      invocation.operation === "press" ? "owner-serialized-prechecked-native" : undefined,
    dispatch: async (_proposal, invocation) => invocation.driver.press("Enter"),
  });
  expect(await driver.press("Enter")).toBe(true);
  await expect(driver.click("#pay")).rejects.toThrow("dispatch_assurance_unavailable");
  expect(raw.callsTo("press")).toHaveLength(1);
  expect(raw.callsTo("click")).toHaveLength(0);
});

test("unclassified custom dispatcher fails closed even after an allow verdict", async () => {
  let dispatched = false;
  const { driver } = guarded({
    dispatch: async () => {
      dispatched = true;
    },
  });
  await expect(driver.press("Enter")).rejects.toThrow("dispatch_assurance_unavailable");
  expect(dispatched).toBe(false);
});
