import { describe, expect, test } from "bun:test";
import type { AiCallEvent } from "../artifacts/events.ts";
import { resolveConfigWithDefaults } from "../config/resolve.ts";
import { ConfigSchema } from "../config/schema.ts";
import type { Step } from "../flow/types.ts";
import { type BudgetLimits, BudgetTracker } from "./budget.ts";
import { CostAccumulator } from "./cost.ts";
import { compileJevProfile } from "./jev-profile.ts";
import { JevStrategyRuntime, ProfileJevChooser } from "./jev-strategies.ts";
import { createAiRuntime } from "./runtime.ts";
import { type JevVisualEvidence, validateVisualEvidence } from "./vision-evidence.ts";

const step = { id: "pick", do: "click", target: "Save" } as Step;
const packet = [{ index: 2, role: "button", name: "Save", score: 0.5 }];
function setup(max = 2, limits: BudgetLimits = {}) {
  const events: Omit<AiCallEvent, "type" | "ts">[] = [];
  let calls = 0;
  const deps = {
    config: {
      ai: {
        classifier: "jev" as const,
        jev: { profile: "text" as const, max_calls_per_step: max },
      },
    },
    jevApiKey: "test",
    aiWriter: {
      emitAiCall: (e: Omit<AiCallEvent, "type" | "ts">) => {
        events.push(e);
      },
    },
    fetchFn: (async () => {
      calls++;
      return Response.json({
        model: "jev-1.14.0",
        answers: {
          pick: {
            type: "choice",
            choice: "c2",
            confidence: 0.95,
            probabilities: { c2: 0.98, none_of_the_above: 0.02 },
          },
        },
        usage: { input_tokens: 100, output_tokens: 0 },
      });
    }) as unknown as typeof fetch,
  };
  const rt = new JevStrategyRuntime(
    deps,
    compileJevProfile(deps.config)!,
    new BudgetTracker(limits),
    new CostAccumulator(),
  );
  return { rt, chooser: new ProfileJevChooser(rt), events, calls: () => calls };
}
describe("explicit JEV profiles", () => {
  test("absent block leaves compiler absent", () => expect(compileJevProfile({})).toBeUndefined());
  test("strict options reject typos and image contradictions", () => {
    expect(ConfigSchema.safeParse({ ai: { jev: { profile: "visual" } } }).success).toBe(false);
    expect(
      ConfigSchema.safeParse({ ai: { jev: { profile: "text", image: "allow" } } }).success,
    ).toBe(false);
    expect(
      ConfigSchema.safeParse({ ai: { classifier: "llm", jev: { profile: "text" } } }).success,
    ).toBe(false);
    expect(
      ConfigSchema.safeParse({ ai: { classifier: "llm", jev: { profile: "shadow" } } }).success,
    ).toBe(true);
  });
  test("deep merge preserves explicit denial and budgets", () => {
    const config = resolveConfigWithDefaults([
      { ai: { jev: { profile: "text", max_calls_per_step: 1 } } },
      { ai: { jev: { profile: "text", images: "deny" } } },
    ]);
    expect(compileJevProfile(config)).toMatchObject({
      images: "deny",
      maxCallsPerStep: 1,
      model: "jev-1.14.0",
    });
  });
  test("profiles require credentials even with auto", () =>
    expect(() =>
      createAiRuntime({
        config: { ai: { jev: { profile: "text" } } },
        aiWriter: { emitAiCall() {} },
      }),
    ).toThrow("jev_missing_key"));
  test("sparse original index is returned and profile is pinned", async () => {
    const s = setup();
    expect(await s.chooser.choose("save", packet, { step, action: "click" })).toMatchObject({
      kind: "pick",
      index: 2,
    });
    expect(s.events[0]?.model).toBe("jev-1.14.0");
  });
  test("shared actual cap cannot reset between invocations", async () => {
    const s = setup(1);
    await s.chooser.choose("save", packet, { step, action: "click" });
    expect((await s.chooser.choose("save", packet, { step, action: "click" })).kind).toBe(
      "abstain",
    );
    expect(s.calls()).toBe(1);
  });
  test("observational duplicates abstain locally", async () => {
    const s = setup();
    expect(
      (
        await s.chooser.choose("save", [...packet, { ...packet[0]!, index: 4 }], {
          step,
          action: "click",
        })
      ).kind,
    ).toBe("abstain");
    expect(s.calls()).toBe(0);
  });
  test("visual JEV runtime supplies L3 without generative planner", () => {
    const rt = createAiRuntime({
      config: { ai: { classifier: "jev", jev: { profile: "visual", images: "allow" } } },
      jevApiKey: "test",
      aiWriter: { emitAiCall() {} },
    });
    expect(typeof rt.hooks.resolveL3).toBe("function");
    expect(rt.planner).toBeUndefined();
    expect(typeof rt.hooks.classifyL4).toBe("undefined");
  });
  test("explicit JEV judge without profile fails closed", async () => {
    const rt = createAiRuntime({
      config: { ai: { classifier: "heuristic" } },
      generate: async () => {
        throw new Error("must not call");
      },
      aiWriter: { emitAiCall() {} },
    });
    expect(
      (
        await rt.judge!(
          { type: "ai_judge", backend: "jev", prompt: "ready" },
          { driver: {} as never, timeoutMs: 100 },
        )
      ).pass,
    ).toBe(false);
  });
});
function evidence(): JevVisualEvidence {
  return {
    captureId: "x",
    url: "https://example.test",
    frameId: "main",
    signature: "sig",
    observedAtMs: Date.now(),
    pixelsSafe: true,
    image: { format: "png", width: 400, height: 300, data_base64: "AAAA" },
    viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0, dpr: 1 },
    geometry: { e1: { x: 10, y: 10, width: 20, height: 20 } },
  };
}
test("visual evidence enforces pixel safety, freshness, viewport and candidate identity", () => {
  const e = evidence();
  expect(() => validateVisualEvidence(e, ["e1"])).not.toThrow();
  expect(() => validateVisualEvidence({ ...e, pixelsSafe: false }, ["e1"])).toThrow(
    "jev_pixels_unsafe",
  );
  expect(() => validateVisualEvidence({ ...e, observedAtMs: 0 }, ["e1"])).toThrow(
    "jev_snapshot_stale",
  );
  expect(() => validateVisualEvidence(e, ["missing"])).toThrow("jev_transform_unknown");
  expect(() =>
    validateVisualEvidence({ ...e, viewport: { ...e.viewport, dpr: 2 } }, ["e1"]),
  ).toThrow("jev_transform_unknown");
});

test("JEV predicates fail closed on denied screenshot and share step requests", async () => {
  const s = setup(1);
  await s.chooser.choose("save", packet, { step, action: "click" });
  const denied = await s.rt.judge(
    { type: "ai_judge", backend: "jev", prompt: "ready", inputs: ["screenshot"] },
    { driver: {} as never, timeoutMs: 500, stepId: step.id },
  );
  expect(denied.pass).toBe(false);
  expect(s.calls()).toBe(1);
});

test.each([
  { name: "normal", sink: "ok", cap: undefined, funded: true },
  { name: "throwing observer", sink: "observer", cap: undefined, funded: true },
  { name: "rejecting writer", sink: "writer", cap: undefined, funded: true },
  { name: "funded cost cap", sink: "ok", cap: 100, funded: true },
  { name: "exhausted cost cap", sink: "ok", cap: 0, funded: false },
  {
    name: "baseline uses remaining cost",
    sink: "ok",
    cap: 0.003,
    funded: false,
    baselineCost: 0.001,
  },
  {
    name: "baseline uses final logical call",
    sink: "ok",
    cap: undefined,
    funded: false,
    maxCalls: 1,
  },
])(
  "shadow preserves baseline success with $name",
  async ({ sink, cap, funded, baselineCost, maxCalls }) => {
    const { MockDriver, makeSnapshot, makeRankedCandidate, makeSuccessBatch } = await import(
      "../driver/index.ts"
    );
    const driver = new MockDriver();
    driver.setSnapshot(makeSnapshot({ interactiveElements: [] }));
    driver.setResolveAll([
      makeRankedCandidate({ role: "button", ref: "e1", name: "First" }),
      makeRankedCandidate({ role: "button", ref: "e2", name: "Second" }),
    ]);
    driver.setBatchResult(makeSuccessBatch("ref:e1"));
    let snapshots = 0;
    const snapshot = driver.snapshot.bind(driver);
    driver.snapshot = async (...args) => {
      snapshots++;
      return snapshot(...args);
    };
    const events: Omit<AiCallEvent, "type" | "ts">[] = [];
    let fetches = 0;
    let actions = 0;
    const batch = driver.batch.bind(driver);
    driver.batch = async (...args) => {
      actions++;
      return batch(...args);
    };
    const rt = createAiRuntime({
      config: {
        ai: { classifier: "heuristic", jev: { profile: "shadow" } },
        run: {
          ...(cap === undefined ? {} : { max_cost_usd: cap }),
          ...(maxCalls === undefined ? {} : { max_model_calls: maxCalls }),
        },
      },
      jevApiKey: "test",
      choosers: [
        {
          kind: "heuristic",
          choose: async () => {
            if (baselineCost) rt.budget.addCost(baselineCost);
            if (maxCalls) rt.budget.noteModelCall();
            return { kind: "pick", index: 0, confidence: 1 };
          },
        },
      ],
      aiWriter: {
        async emitAiCall(e) {
          events.push(e);
          if (sink === "writer") throw new Error("writer secret");
        },
      },
      onAiCall() {
        if (sink === "observer") throw new Error("observer secret");
      },
      fetchFn: (async () => {
        fetches++;
        expect(actions).toBe(1);
        return Response.json({
          model: "jev-1.14.0",
          answers: {
            pick: {
              type: "choice",
              choice: "c1",
              confidence: 0.99,
              probabilities: { c0: 0.01, c1: 0.98, none_of_the_above: 0.01 },
            },
          },
          usage: { input_tokens: 100, output_tokens: 0 },
        });
      }) as unknown as typeof fetch,
    });
    const result = await rt.hooks.resolveL2(
      step,
      { ok: false, tier: "L1", candidates: [], escalate: true },
      { driver, now: Date.now },
    );
    expect(result.ok).toBe(true);
    expect(result.pinnedLabel).toBe("First");
    expect(actions).toBe(1);
    expect(fetches).toBe(funded ? 1 : 0);
    expect(snapshots).toBe(1);
    if (!funded) {
      expect(rt.budget.modelCalls).toBe(maxCalls ? 1 : 0);
      expect(rt.budget.cost_usd).toBe(baselineCost ?? 0);
      return;
    }
    expect(events[0]?.jev?.shadow).toEqual({
      candidate: 1,
      authoritativeCandidate: 0,
      disagreement: true,
      actionSucceeded: true,
    });
  },
);

test("a locally denied JEV request preserves the fallback logical allowance", async () => {
  const s = setup(1, { max_model_calls: 2 });
  expect((await s.chooser.choose("save", packet, { step, action: "click" })).kind).toBe("pick");
  expect((await s.chooser.choose("save", packet, { step, action: "click" })).kind).toBe("abstain");
  expect(s.calls()).toBe(1);
  expect(s.rt.budget.modelCalls).toBe(1);
  expect(() => s.rt.budget.noteModelCall()).not.toThrow();
});

test("JEV telemetry callbacks cannot discard a successful evaluation", async () => {
  const s = setup();
  s.rt.deps.onAiCall = () => {
    throw new Error("observer secret");
  };
  expect((await s.chooser.choose("save", packet, { step, action: "click" })).kind).toBe("pick");
  expect(s.calls()).toBe(1);
});

function verifierFixture(unique: number) {
  const sent: Record<string, unknown>[] = [];
  const deps = {
    config: { ai: { classifier: "jev" as const, jev: { profile: "text" as const } } },
    jevApiKey: "test",
    aiWriter: { emitAiCall() {} },
    fetchFn: (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sent.push(body);
      return Response.json({
        model: "jev-1.14.0",
        answers: body.questions.match
          ? { match: { type: "noul", noul: 1 }, unique: { type: "noul", noul: unique } }
          : {
              pick: {
                type: "choice",
                choice: "c2",
                confidence: 0.99,
                probabilities: { c2: 0.99, none_of_the_above: 0.01 },
              },
            },
        usage: { input_tokens: 100, output_tokens: 0 },
      });
    }) as unknown as typeof fetch,
  };
  const runtime = new JevStrategyRuntime(
    deps,
    compileJevProfile(deps.config)!,
    new BudgetTracker(),
    new CostAccumulator(),
  );
  return { sent, runtime, chooser: new ProfileJevChooser(runtime) };
}
test("text verifier uses new scoped evidence and requires match plus uniqueness", async () => {
  const f = verifierFixture(1);
  const result = await f.chooser.choose("save", packet, {
    step,
    action: "click",
    verificationEvidence: async () => ({
      candidate: { title: "Save invoice" },
      alternative: { title: "Discard invoice" },
    }),
  });
  expect(result.kind).toBe("pick");
  expect(f.sent).toHaveLength(2);
  expect(JSON.stringify(f.sent[0])).not.toContain("Save invoice");
  expect(JSON.stringify(f.sent[1])).toContain("Save invoice");
});
test("text verifier uncertainty rejects a previously accepted choice", async () => {
  const f = verifierFixture(0.98);
  const result = await f.chooser.choose("save", packet, {
    step,
    action: "click",
    verificationEvidence: async () => ({ candidate: { title: "Save invoice" } }),
  });
  expect(result.kind).toBe("abstain");
  expect(f.sent).toHaveLength(2);
});
test("no new verification evidence skips second call", async () => {
  const f = verifierFixture(1);
  const result = await f.chooser.choose("save", packet, {
    step,
    action: "click",
    verificationEvidence: async () => undefined,
  });
  expect(result.kind).toBe("pick");
  expect(f.sent).toHaveLength(1);
});
test("verifier cannot replenish shared per-step allowance", async () => {
  const f = verifierFixture(1);
  await f.chooser.choose("save", packet, {
    step,
    action: "click",
    verificationEvidence: async () => ({ candidate: { title: "Save" } }),
  });
  const result = await f.chooser.choose("save", packet, {
    step,
    action: "click",
    verificationEvidence: async () => ({ candidate: { title: "Save" } }),
  });
  expect(result.kind).toBe("abstain");
  expect(f.sent).toHaveLength(2);
});
