// Flightplan — AI module unit tests (OFFLINE + deterministic).
//
// NO network, NO AI SDK: every model call goes through a FAKE `GenerateFn` returning canned
// `{ output, usage }`, and the page boundary is `MockDriver`. Cost is therefore deterministic
// (registry pricing × fake token counts). Covers L1→L2/L3 escalation + StepExecution shape,
// ambiguity, vision routing, advisor verdicts, ai_judge routing, budgets, cost aggregation, and
// registry merge. (The one SDK-touching test lives in `provider.test.ts`, isolated.)

import { describe, expect, test } from "bun:test";
import {
  MockDriver,
  makeFailureBatch,
  makeInteractiveElement,
  makeRankedCandidate,
  makeSnapshot,
  makeSuccessBatch,
} from "../driver/index.ts";
import type { Config } from "../config/types.ts";
import type { Step } from "../flow/types.ts";
import type { AiJudgeAssertion } from "../flow/types.ts";
import type { AiCallEvent } from "../artifacts/events.ts";
import { resolveStep } from "../ladder/orchestrator.ts";
import type { ResolveContext, StepExecution } from "../ladder/index.ts";
import type { AdvisoryVerdict } from "../types.ts";
import { createAiRuntime } from "./runtime.ts";
import { resolveRegistry, DEFAULT_MODEL_REGISTRY } from "./registry.ts";
import { BudgetExceededError } from "./budget.ts";
import type { AiCallSink, GenerateFn, GenerateRequest } from "./types.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Records every `ai_call` event (the SDK-free `AiCallSink`). */
class RecordingSink implements AiCallSink {
  readonly events: Array<Omit<AiCallEvent, "ts" | "type">> = [];
  emitAiCall(p: Omit<AiCallEvent, "ts" | "type">): void {
    this.events.push(p);
  }
}

interface FakeResponse {
  output: unknown;
  usage?: { inputTokens: number; outputTokens: number; cost?: number };
}

/** A scripted fake GenerateFn: returns `responses` in order (last response repeats). */
function makeFakeGenerate(responses: FakeResponse[]): { fn: GenerateFn; calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = [];
  let i = 0;
  const fn: GenerateFn = async (req) => {
    calls.push(req);
    const r = responses[Math.min(i, responses.length - 1)] ?? { output: {} };
    i += 1;
    return {
      output: r.output,
      model: req.models[0]!,
      usage: r.usage ?? { inputTokens: 10, outputTokens: 5 },
    };
  };
  return { fn, calls };
}

function buildRuntime(generate: GenerateFn, sink: AiCallSink, config: Pick<Config, "ai" | "run"> = {}) {
  return createAiRuntime({ config, generate, aiWriter: sink });
}

const clickStep = (over: Partial<Step> = {}): Step =>
  ({ id: "s1", do: "click", target: "Create order", ...over }) as Step;

function ctxFor(driver: MockDriver, ai: ResolveContext["ai"]): ResolveContext {
  return { driver, ai, now: () => 0 };
}

const priorL1: StepExecution = { ok: false, tier: "L1", escalate: true, error: "L1 lost" };

// ---------------------------------------------------------------------------
// L1 → L2
// ---------------------------------------------------------------------------

describe("L2 resolver — L1 escalates, resolver picks index 0, action succeeds", () => {
  test("returns a tier:'L2' StepExecution with the L1 shape + one resolver ai_call", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Create order" })],
      }),
    );
    // The AI tier now ranks via the driver's native resolveAll (not Flightplan's own matcher).
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Create order" })]);
    d.setSignature("http://localhost:3000/order|sig1");
    d.enqueueBatchResult(makeFailureBatch("hidden")); // L1 acts → fails → escalate
    d.enqueueBatchResult(makeSuccessBatch("role:button:Create order")); // L2 acts → succeeds

    const sink = new RecordingSink();
    const { fn } = makeFakeGenerate([{ output: { decision: "pick", index: 0, confidence: 0.9 } }]);
    const rt = buildRuntime(fn, sink);

    const { execution } = await resolveStep(clickStep(), ctxFor(d, rt.hooks));

    expect(execution.ok).toBe(true);
    expect(execution.tier).toBe("L2");
    expect(execution.strategy).toBe("role_name");
    expect(execution.durableSelector).toBe("role:button:Create order");
    expect(execution.signatureBasis).toBeDefined();
    expect(execution.candidates && execution.candidates.length).toBeGreaterThan(0);
    expect(execution.pinnedLabel).toBe("Create order"); // carried for ai_pick labeling

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.role).toBe("resolver");
    expect(sink.events[0]!.purpose).toBe("resolve:s1");
    expect(sink.events[0]!.outcome).toBe("ok");
  });
});

describe("L2 resolver — ambiguous L1 match is disambiguated", () => {
  test("picks the resolver's chosen index among two close candidates", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "button", name: "Submit order" }),
          makeInteractiveElement({ ref: "e2", role: "button", name: "Submit draft" }),
        ],
      }),
    );
    // Native ranking returns both close candidates (index 0 = order, index 1 = draft).
    d.setResolveAll([
      makeRankedCandidate({ ref: "e1", role: "button", name: "Submit order" }),
      makeRankedCandidate({ ref: "e2", role: "button", name: "Submit draft" }),
    ]);
    d.setSignature("http://x/submit|sig");
    d.enqueueBatchResult(makeSuccessBatch("role:button:Submit order")); // L1 acts but ambiguous → escalate
    d.enqueueBatchResult(makeSuccessBatch("role:button:Submit draft")); // L2 acts on the chosen one

    const sink = new RecordingSink();
    const { fn } = makeFakeGenerate([{ output: { decision: "pick", index: 1, confidence: 0.85 } }]);
    const rt = buildRuntime(fn, sink);

    const { execution } = await resolveStep(clickStep({ target: "Submit" }), ctxFor(d, rt.hooks));

    expect(execution.ok).toBe(true);
    expect(execution.tier).toBe("L2");
    expect(execution.pinnedLabel).toBe("Submit draft"); // index 1
    expect(sink.events.filter((e) => e.role === "resolver")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// L3 vision
// ---------------------------------------------------------------------------

describe("L3 vision — resolver requests a screenshot, vision resolves", () => {
  test("screenshot_needed → L3 takes a screenshot → picks → tier:'L3'", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Delete" })],
      }),
    );
    // L3 re-snapshots and re-ranks via the driver's native resolveAll. "Delete" scores below L1's
    // 0.4 floor for intent "trash icon" so L1 escalates WITHOUT acting, but stays in the ranked list
    // so L3 vision has a candidate to pick.
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Delete", score: 0.3 })]);
    d.setSignature("http://x/icons|sig");
    // L1 finds no plausible target ("Delete" vs intent "trash icon" scores below L1's 0.4 floor),
    // so it escalates WITHOUT acting (no batch). L2 returns screenshot_needed (no batch). The only
    // batch is L3's action on the chosen candidate.
    d.enqueueScreenshot("BASE64JPEGDATA"); // L3 screenshot
    d.enqueueBatchResult(makeSuccessBatch("role:button:Delete")); // L3 acts

    const sink = new RecordingSink();
    const { fn } = makeFakeGenerate([
      { output: { decision: "screenshot_needed", reason: "icons unlabeled" } }, // resolver
      { output: { decision: "pick", index: 0, confidence: 0.92 } }, // vision
    ]);
    const rt = buildRuntime(fn, sink);

    const { execution } = await resolveStep(clickStep({ target: "trash icon" }), ctxFor(d, rt.hooks));

    expect(execution.ok).toBe(true);
    expect(execution.tier).toBe("L3");
    expect(d.callsTo("screenshot")).toHaveLength(1);
    expect(sink.events.map((e) => e.role)).toEqual(["resolver", "vision"]);
  });
});

// ---------------------------------------------------------------------------
// L4 advisor — every verdict kind
// ---------------------------------------------------------------------------

describe("L4 advisor — produces each verdict kind, terminal + attached", () => {
  const verdicts: AdvisoryVerdict[] = [
    {
      kind: "heal",
      target: "Create order",
      recipe: { strategy: "role_name", selector: "role:button:Create order" },
      confidence: 0.8,
    },
    { kind: "bug", summary: "order failed to submit", evidence: ["error banner shown"] },
    { kind: "flake", reason: "transient network blip" },
    {
      kind: "intent_changed",
      summary: "wizard replaced by single page",
      proposed_patch_path: "proposed-patches/s1.patch",
    },
  ];

  for (const verdict of verdicts) {
    test(`kind=${verdict.kind} → terminal StepExecution.advisory + ai_call.advisoryVerdict`, async () => {
      const d = new MockDriver();
      const sink = new RecordingSink();
      const { fn } = makeFakeGenerate([{ output: verdict }]);
      const rt = buildRuntime(fn, sink);

      const exec = await rt.hooks.classifyL4(clickStep(), priorL1, ctxFor(d, rt.hooks));

      expect(exec.ok).toBe(false);
      expect(exec.tier).toBe("L4");
      expect(exec.escalate).toBe(false); // terminal — advisor never climbs further
      expect(exec.advisory).toEqual(verdict);
      expect(exec.error).toContain("advisor:");

      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]!.role).toBe("advisor");
      expect(sink.events[0]!.advisoryVerdict).toBe(verdict.kind);
      expect(sink.events[0]!.outcome).toBe(verdict.kind);
    });
  }
});

// ---------------------------------------------------------------------------
// ai_judge routing
// ---------------------------------------------------------------------------

describe("ai_judge — routing follows the modality", () => {
  const judgeAssertion = (over: Partial<AiJudgeAssertion> = {}): AiJudgeAssertion =>
    ({ type: "ai_judge", prompt: "An order-confirmation is shown.", ...over }) as AiJudgeAssertion;

  test("inputs include screenshot → vision path (screenshot + role:'judge')", async () => {
    const d = new MockDriver();
    d.setScreenshot("BASE64SHOT");
    d.setSnapshot(makeSnapshot({ text: "Order confirmed" }));
    const sink = new RecordingSink();
    const { fn, calls } = makeFakeGenerate([{ output: { pass: true, reason: "confirmation visible" } }]);
    const rt = buildRuntime(fn, sink);

    const result = await rt.judge(judgeAssertion({ inputs: ["text", "screenshot"] }), {
      driver: d,
      timeoutMs: 1000,
      stepId: "s3",
      when: "after",
    });

    expect(result.type).toBe("ai_judge");
    expect(result.pass).toBe(true);
    expect(result.message).toBe("confirmation visible");
    expect(d.callsTo("screenshot")).toHaveLength(1);
    expect(calls[0]!.modelRole).toBe("vision");
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.role).toBe("judge");
    expect(sink.events[0]!.purpose).toBe("judge:s3");
  });

  test("text-only judge does NOT screenshot and runs on a text model", async () => {
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ text: "No banner here" }));
    const sink = new RecordingSink();
    const { fn, calls } = makeFakeGenerate([{ output: { pass: false, reason: "no confirmation" } }]);
    const rt = buildRuntime(fn, sink);

    const result = await rt.judge(judgeAssertion({ inputs: ["text"] }), {
      driver: d,
      timeoutMs: 1000,
      stepId: "s4",
    });

    expect(result.pass).toBe(false);
    expect(d.callsTo("screenshot")).toHaveLength(0);
    expect(calls[0]!.modelRole).toBe("resolver");
    expect(sink.events[0]!.role).toBe("judge");
  });
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

describe("budgets — each ceiling throws from the right choke point", () => {
  test("max_model_calls:0 → BudgetExceededError('max_model_calls') from aiCall", async () => {
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Go" })] }));
    d.setSignature("u|s");
    const sink = new RecordingSink();
    const { fn } = makeFakeGenerate([{ output: { decision: "pick", index: 0, confidence: 0.9 } }]);
    const rt = buildRuntime(fn, sink, { run: { max_model_calls: 0 } });

    let err: unknown;
    try {
      await rt.hooks.resolveL2(clickStep({ target: "Go" }), priorL1, ctxFor(d, rt.hooks));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).limit).toBe("max_model_calls");
    expect(sink.events).toHaveLength(0); // never reached the model
  });

  test("max_screenshots:0 → BudgetExceededError('max_screenshots') before any screenshot", async () => {
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Go" })] }));
    const sink = new RecordingSink();
    const { fn } = makeFakeGenerate([{ output: { decision: "pick", index: 0, confidence: 0.9 } }]);
    const rt = buildRuntime(fn, sink, { run: { max_screenshots: 0 } });

    let err: unknown;
    try {
      await rt.hooks.resolveL3(clickStep({ target: "Go" }), priorL1, ctxFor(d, rt.hooks));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).limit).toBe("max_screenshots");
    expect(d.callsTo("screenshot")).toHaveLength(0);
  });

  test("tiny max_cost_usd → BudgetExceededError('max_cost_usd') after the call accrues cost", async () => {
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Go" })] }));
    d.setSignature("u|s");
    const sink = new RecordingSink();
    // resolver cost for 10/5 tokens = 0.0000018 > 0.0000001 ceiling.
    const { fn } = makeFakeGenerate([{ output: { decision: "pick", index: 0, confidence: 0.9 } }]);
    const rt = buildRuntime(fn, sink, { run: { max_cost_usd: 0.0000001 } });

    let err: unknown;
    try {
      await rt.hooks.resolveL2(clickStep({ target: "Go" }), priorL1, ctxFor(d, rt.hooks));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).limit).toBe("max_cost_usd");
    expect(sink.events).toHaveLength(1); // the call WAS logged before the ceiling tripped
  });
});

// ---------------------------------------------------------------------------
// Cost aggregation
// ---------------------------------------------------------------------------

describe("cost aggregation — usageTotals matches fake tokens × registry pricing", () => {
  test("per-role rows + total are deterministic", async () => {
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Go" })] }));
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Go" })]); // native ranking → L2 acts
    d.setSignature("u|s");
    d.enqueueBatchResult(makeSuccessBatch("role:button:Go")); // L2 acts
    const sink = new RecordingSink();
    const { fn } = makeFakeGenerate([
      { output: { decision: "pick", index: 0, confidence: 0.9 }, usage: { inputTokens: 10, outputTokens: 5 } }, // resolver
      { output: { kind: "flake", reason: "x" }, usage: { inputTokens: 20, outputTokens: 10 } }, // advisor
    ]);
    const rt = buildRuntime(fn, sink);

    await rt.hooks.resolveL2(clickStep({ target: "Go" }), priorL1, ctxFor(d, rt.hooks));
    await rt.hooks.classifyL4(clickStep({ target: "Go" }), priorL1, ctxFor(d, rt.hooks));

    const resolverCost = (10 / 1e6) * 0.09 + (5 / 1e6) * 0.18; // 0.0000018
    const advisorCost = (20 / 1e6) * 0.94 + (10 / 1e6) * 3.0; // 0.0000488
    const totals = rt.usageTotals();

    expect(totals.total_cost_usd).toBeCloseTo(resolverCost + advisorCost, 12);
    expect(totals.model_usage).toEqual([
      { role: "advisor", model: "z-ai/glm-5.2", calls: 1, cost_usd: advisorCost },
      { role: "resolver", model: "deepseek/deepseek-v4-flash", calls: 1, cost_usd: resolverCost },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Registry merge
// ---------------------------------------------------------------------------

describe("registry — config overriding only resolver.model keeps the rest of the defaults", () => {
  test("resolver.model overridden; resolver fallbacks/pricing + vision/advisor stay default", () => {
    const reg = resolveRegistry({ ai: { models: { resolver: { model: "custom/resolver-x" } } } });

    expect(reg.resolver.model).toBe("custom/resolver-x");
    expect(reg.resolver.fallbacks).toEqual(DEFAULT_MODEL_REGISTRY.resolver.fallbacks);
    expect(reg.resolver.pricing).toEqual(DEFAULT_MODEL_REGISTRY.resolver.pricing);
    expect(reg.vision).toEqual(DEFAULT_MODEL_REGISTRY.vision);
    expect(reg.advisor).toEqual(DEFAULT_MODEL_REGISTRY.advisor);
  });

  test("defaults are returned for an empty config", () => {
    const reg = resolveRegistry({});
    expect(reg.resolver.model).toBe("deepseek/deepseek-v4-flash");
    expect(reg.vision.model).toBe("google/gemini-3-flash-preview");
    expect(reg.advisor.model).toBe("z-ai/glm-5.2");
  });
});
