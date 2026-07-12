// Flightplan — L3 vision BATCHING tests (PLAN_v003 §4 v003-3; OFFLINE + deterministic).
//
// NO network, NO AI SDK: every model call goes through a FAKE `GenerateFn` returning canned
// `{ output, usage }`, and the page boundary is `MockDriver`. Covers the batch spine:
//   (a) ≥2 same-page vision targets resolve in ONE screenshot + ONE vision call.
//   (b) a malformed / partial batch response cleanly falls back to single-call-per-target.
// Plus the orchestrator `resolveVisionBatch` wiring (attempts recorded; L4 fall-through).

import { describe, expect, test } from "bun:test";
import type { AiCallEvent } from "../artifacts/events.ts";
import {
  MockDriver,
  makeInteractiveElement,
  makeRankedCandidate,
  makeSnapshot,
  makeSuccessBatch,
} from "../driver/index.ts";
import type { Step } from "../flow/types.ts";
import type { ResolveContext, StepExecution } from "../ladder/index.ts";
import { resolveVisionBatch } from "../ladder/orchestrator.ts";
import { createAiRuntime } from "./runtime.ts";
import type { AiCallSink, GenerateFn, GenerateRequest } from "./types.ts";
import { resolveBatchL3, type VisionRuntime } from "./vision-l3.ts";

// ---------------------------------------------------------------------------
// Test doubles (mirrors ai.test.ts)
// ---------------------------------------------------------------------------

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

/** Build a VisionRuntime + the shared runtime (for hooks) from a fake generate + sink. */
function buildVisionRuntime(generate: GenerateFn, sink: AiCallSink) {
  const ai = createAiRuntime({ config: {}, generate, aiWriter: sink });
  const rt: VisionRuntime = {
    registry: ai.registry,
    budget: ai.budget,
    cost: ai.cost,
    generate: ai.generate,
    aiWriter: ai.aiWriter,
  };
  return { rt, ai };
}

const clickStep = (id: string, target: string): Step => ({ id, do: "click", target });

function ctxFor(driver: MockDriver, ai?: ResolveContext["ai"]): ResolveContext {
  return { driver, ...(ai ? { ai } : {}), now: () => 0 };
}

/**
 * A MockDriver whose native ranking answers per-target by intent: the `save` intent surfaces the
 * "Save" button, the `trash`/`delete` intent surfaces the "Delete" button — so each batched target
 * has its OWN distinct candidate and index 0 maps back to a different element.
 */
function twoIconPage(): MockDriver {
  const d = new MockDriver();
  d.setSnapshot(
    makeSnapshot({
      interactiveElements: [
        makeInteractiveElement({ ref: "e1", role: "button", name: "Save" }),
        makeInteractiveElement({ ref: "e2", role: "button", name: "Delete" }),
      ],
    }),
  );
  d.setSignature("http://x/icons|sig");
  d.onResolveAll((intent) => {
    if (/save|disk|floppy/i.test(intent)) {
      return [makeRankedCandidate({ ref: "e1", role: "button", name: "Save", score: 0.3 })];
    }
    return [makeRankedCandidate({ ref: "e2", role: "button", name: "Delete", score: 0.3 })];
  });
  return d;
}

// ---------------------------------------------------------------------------
// (a) Batch happy path — ≥2 targets, ONE screenshot, ONE vision call
// ---------------------------------------------------------------------------

describe("resolveBatchL3 — ≥2 same-page vision targets resolve in a single call", () => {
  test("one screenshot + one vision call answers both targets, each acts", async () => {
    const d = twoIconPage();
    d.enqueueScreenshot("BATCHSHOT"); // the ONE shared screenshot
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save")); // target A acts
    d.enqueueBatchResult(makeSuccessBatch("role:button:Delete")); // target B acts

    const sink = new RecordingSink();
    const { fn, calls } = makeFakeGenerate([
      {
        output: {
          picks: [
            { key: "s1", decision: "pick", index: 0, confidence: 0.95 },
            { key: "s2", decision: "pick", index: 0, confidence: 0.9 },
          ],
        },
      },
    ]);
    const { rt } = buildVisionRuntime(fn, sink);

    const execs = await resolveBatchL3(
      rt,
      [clickStep("s1", "save disk icon"), clickStep("s2", "trash icon")],
      ctxFor(d),
    );

    expect(execs).toHaveLength(2);
    expect(execs.every((e) => e.ok && e.tier === "L3")).toBe(true);
    expect(execs[0]!.pinnedLabel).toBe("Save");
    expect(execs[1]!.pinnedLabel).toBe("Delete");

    // ONE screenshot for the whole batch; exactly ONE model call (a batch, not N singles).
    expect(d.callsTo("screenshot")).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.modelRole).toBe("vision");
    expect(sink.events.filter((e) => e.role === "vision")).toHaveLength(1);
    expect(sink.events[0]!.purpose).toBe("vision-batch:s1,s2");
    // The batch prompt is keyed per target.
    const promptText = calls[0]!.messages?.[0]?.content.find((c) => c.type === "text")?.text ?? "";
    expect(promptText).toContain('key="s1"');
    expect(promptText).toContain('key="s2"');
  });
});

// ---------------------------------------------------------------------------
// (b) Malformed / partial batch → per-target fallback to single-call-per-target
// ---------------------------------------------------------------------------

describe("resolveBatchL3 — malformed / partial batch triggers per-target fallback", () => {
  test("a fully malformed batch response falls back to N single vision calls", async () => {
    const d = twoIconPage();
    d.setScreenshot("SHOT"); // used by the batch call AND each fallback single call
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save")); // fallback A acts
    d.enqueueBatchResult(makeSuccessBatch("role:button:Delete")); // fallback B acts

    const sink = new RecordingSink();
    // Response 1: garbage (schema-invalid → the batch call throws inside aiCall.parse).
    // Responses 2 & 3: valid single-target picks for the two fallback calls.
    const { fn, calls } = makeFakeGenerate([
      { output: { totally: "wrong", not: "picks" } }, // malformed batch
      { output: { decision: "pick", index: 0, confidence: 0.9 } }, // fallback single A
      { output: { decision: "pick", index: 0, confidence: 0.9 } }, // fallback single B
    ]);
    const { rt } = buildVisionRuntime(fn, sink);

    const execs = await resolveBatchL3(
      rt,
      [clickStep("s1", "save disk icon"), clickStep("s2", "trash icon")],
      ctxFor(d),
    );

    expect(execs).toHaveLength(2);
    expect(execs.every((e) => e.ok && e.tier === "L3")).toBe(true);
    expect(execs[0]!.pinnedLabel).toBe("Save");
    expect(execs[1]!.pinnedLabel).toBe("Delete");

    // 3 model calls total: 1 (failed batch) + 2 (per-target fallback singles).
    expect(calls).toHaveLength(3);
    // Fallback singles use the single-target purpose (vision:<id>), NOT the batch purpose.
    const purposes = sink.events.map((e) => e.purpose);
    expect(purposes).toContain("vision:s1");
    expect(purposes).toContain("vision:s2");
  });

  test("a PARTIAL batch answers one target and falls back only for the missing key", async () => {
    const d = twoIconPage();
    d.setScreenshot("SHOT");
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save")); // s1 acts from the batch pick
    d.enqueueBatchResult(makeSuccessBatch("role:button:Delete")); // s2 acts from the fallback single

    const sink = new RecordingSink();
    // Batch answers s1 only (s2 missing). Second response is the s2 fallback single.
    const { fn, calls } = makeFakeGenerate([
      { output: { picks: [{ key: "s1", decision: "pick", index: 0, confidence: 0.95 }] } },
      { output: { decision: "pick", index: 0, confidence: 0.9 } }, // s2 fallback single
    ]);
    const { rt } = buildVisionRuntime(fn, sink);

    const execs = await resolveBatchL3(
      rt,
      [clickStep("s1", "save disk icon"), clickStep("s2", "trash icon")],
      ctxFor(d),
    );

    expect(execs).toHaveLength(2);
    expect(execs.every((e) => e.ok && e.tier === "L3")).toBe(true);
    expect(execs[0]!.pinnedLabel).toBe("Save");
    expect(execs[1]!.pinnedLabel).toBe("Delete");

    // 2 model calls: the batch (answered s1) + one fallback single (s2).
    expect(calls).toHaveLength(2);
    const purposes = sink.events.map((e) => e.purpose);
    expect(purposes).toContain("vision-batch:s1,s2");
    expect(purposes).toContain("vision:s2");
    expect(purposes).not.toContain("vision:s1"); // s1 never needed a fallback
    // Two screenshots total: 1 batch + 1 fallback single (s2).
    expect(d.callsTo("screenshot")).toHaveLength(2);
  });

  test("a schema-invalid pick is dropped per-target (its well-formed siblings resolve from the batch)", async () => {
    const d = twoIconPage();
    d.setScreenshot("SHOT"); // shared batch shot + one for the s2 fallback single
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save")); // s1 acts from the batch pick
    d.enqueueBatchResult(makeSuccessBatch("role:button:Delete")); // s2 acts from the fallback single

    const sink = new RecordingSink();
    // s1 is a well-formed pick; s2 is OFF-CONTRACT (invalid `decision`). The pre-fix strict schema
    // would have rejected the WHOLE batch → both fall back; now only s2 is dropped + falls back.
    const { fn, calls } = makeFakeGenerate([
      {
        output: {
          picks: [
            { key: "s1", decision: "pick", index: 0, confidence: 0.95 },
            { key: "s2", decision: "not-a-valid-decision", index: 0 },
          ],
        },
      },
      { output: { decision: "pick", index: 0, confidence: 0.9 } }, // s2 fallback single
    ]);
    const { rt } = buildVisionRuntime(fn, sink);

    const execs = await resolveBatchL3(
      rt,
      [clickStep("s1", "save disk icon"), clickStep("s2", "trash icon")],
      ctxFor(d),
    );

    expect(execs).toHaveLength(2);
    expect(execs.every((e) => e.ok && e.tier === "L3")).toBe(true);
    expect(execs[0]!.pinnedLabel).toBe("Save");
    expect(execs[1]!.pinnedLabel).toBe("Delete");

    // The bad pick did NOT throw the whole batch: s1 resolved from the batch, only s2 fell back.
    expect(calls).toHaveLength(2);
    const purposes = sink.events.map((e) => e.purpose);
    expect(purposes).toContain("vision-batch:s1,s2"); // the batch call succeeded (lenient envelope)
    expect(purposes).toContain("vision:s2"); // only s2 needed a per-target fallback
    expect(purposes).not.toContain("vision:s1"); // s1 never fell back
  });

  test("a duplicated key is treated as unanswered and falls back", async () => {
    const d = twoIconPage();
    d.setScreenshot("SHOT");
    d.enqueueBatchResult(makeSuccessBatch("role:button:Delete")); // s2 acts from the batch pick
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save")); // s1 fallback single

    const sink = new RecordingSink();
    // s1 appears twice (ambiguous) → dropped → fallback. s2 answered once → used from the batch.
    const { fn, calls } = makeFakeGenerate([
      {
        output: {
          picks: [
            { key: "s1", decision: "pick", index: 0, confidence: 0.9 },
            { key: "s1", decision: "pick", index: 0, confidence: 0.8 },
            { key: "s2", decision: "pick", index: 0, confidence: 0.9 },
          ],
        },
      },
      { output: { decision: "pick", index: 0, confidence: 0.9 } }, // s1 fallback single
    ]);
    const { rt } = buildVisionRuntime(fn, sink);

    const execs = await resolveBatchL3(
      rt,
      [clickStep("s1", "save disk icon"), clickStep("s2", "trash icon")],
      ctxFor(d),
    );

    expect(execs.every((e) => e.ok)).toBe(true);
    expect(calls).toHaveLength(2); // batch + 1 fallback (s1 only)
    const purposes = sink.events.map((e) => e.purpose);
    expect(purposes).toContain("vision:s1");
    expect(purposes).not.toContain("vision:s2");
  });
});

// ---------------------------------------------------------------------------
// Degenerate + escalation cases
// ---------------------------------------------------------------------------

describe("resolveBatchL3 — degrade + escalate", () => {
  test("a single-step group degrades to one single-target vision call", async () => {
    const d = twoIconPage();
    d.setScreenshot("SHOT");
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save"));

    const sink = new RecordingSink();
    const { fn, calls } = makeFakeGenerate([
      { output: { decision: "pick", index: 0, confidence: 0.9 } },
    ]);
    const { rt } = buildVisionRuntime(fn, sink);

    const execs = await resolveBatchL3(rt, [clickStep("s1", "save disk icon")], ctxFor(d));

    expect(execs).toHaveLength(1);
    expect(execs[0]!.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(sink.events[0]!.purpose).toBe("vision:s1"); // single, not batch
  });

  test("a batch pick below confidence escalates that target (still per-target)", async () => {
    const d = twoIconPage();
    d.enqueueScreenshot("SHOT");
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save")); // s1 acts

    const sink = new RecordingSink();
    const { fn } = makeFakeGenerate([
      {
        output: {
          picks: [
            { key: "s1", decision: "pick", index: 0, confidence: 0.95 },
            { key: "s2", decision: "give_up", reason: "no match" },
          ],
        },
      },
    ]);
    const { rt } = buildVisionRuntime(fn, sink);

    const execs = await resolveBatchL3(
      rt,
      [clickStep("s1", "save disk icon"), clickStep("s2", "trash icon")],
      ctxFor(d),
    );

    expect(execs[0]!.ok).toBe(true);
    expect(execs[0]!.tier).toBe("L3");
    expect(execs[1]!.ok).toBe(false);
    expect(execs[1]!.escalate).toBe(true);
    expect(execs[1]!.tier).toBe("L3");
  });
});

// ---------------------------------------------------------------------------
// Orchestrator wiring — resolveVisionBatch records attempts + L4 fall-through
// ---------------------------------------------------------------------------

describe("resolveVisionBatch (orchestrator) — one L3 attempt per target + L4 fall-through", () => {
  test("records one L3 attempt per target and returns one LadderResult each", async () => {
    const d = twoIconPage();
    d.enqueueScreenshot("SHOT");
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save"));
    d.enqueueBatchResult(makeSuccessBatch("role:button:Delete"));

    const sink = new RecordingSink();
    const { fn } = makeFakeGenerate([
      {
        output: {
          picks: [
            { key: "s1", decision: "pick", index: 0, confidence: 0.95 },
            { key: "s2", decision: "pick", index: 0, confidence: 0.9 },
          ],
        },
      },
    ]);
    const { rt } = buildVisionRuntime(fn, sink);

    const steps = [clickStep("s1", "save disk icon"), clickStep("s2", "trash icon")];
    const results = await resolveVisionBatch(steps, ctxFor(d), (ss, c) =>
      resolveBatchL3(rt, ss, c),
    );

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.execution.ok).toBe(true);
      expect(r.attempts).toHaveLength(1);
      expect(r.attempts[0]!.tier).toBe("L3");
    }
  });

  test("an escalating batched target climbs to the L4 advisor when wired", async () => {
    const d = twoIconPage();
    d.enqueueScreenshot("SHOT");
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save")); // s1 acts (batch pick)

    const sink = new RecordingSink();
    // s2 gives up in the batch → escalates → the wired classifyL4 stub classifies it.
    const { fn } = makeFakeGenerate([
      {
        output: {
          picks: [
            { key: "s1", decision: "pick", index: 0, confidence: 0.95 },
            { key: "s2", decision: "give_up", reason: "no match" },
          ],
        },
      },
    ]);
    const { rt } = buildVisionRuntime(fn, sink);

    let l4Calls = 0;
    const classifyL4 = async (
      _step: Step,
      _prior: StepExecution,
      _ctx: ResolveContext,
    ): Promise<StepExecution> => {
      l4Calls += 1;
      return { ok: false, tier: "L4", escalate: false, advisory: { kind: "flake", reason: "x" } };
    };

    const steps = [clickStep("s1", "save disk icon"), clickStep("s2", "trash icon")];
    const results = await resolveVisionBatch(steps, ctxFor(d, { classifyL4 }), (ss, c) =>
      resolveBatchL3(rt, ss, c),
    );

    expect(l4Calls).toBe(1); // only the escalating target hit L4
    expect(results[0]!.execution.tier).toBe("L3");
    expect(results[0]!.attempts).toHaveLength(1);
    // The escalating target has an L3 attempt then an L4 attempt.
    expect(results[1]!.attempts.map((a) => a.tier)).toEqual(["L3", "L4"]);
    expect(results[1]!.execution.tier).toBe("L4");
  });
});
