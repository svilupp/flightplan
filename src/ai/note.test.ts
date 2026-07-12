// Tests for the advisory "note-to-future-self" AI-tier read/emit path (DESIGN §4).
//
// OFFLINE + deterministic (fake GenerateFn + MockDriver): a stored FRESH note is injected into the
// resolver (L2) AND vision (L3) prompt as `note_in`; the model's emitted `note` is captured as
// `note_out` on the returned StepExecution; a STALE note (older than NOTE_TTL_DAYS) is NOT fed back.
// The lock-persistence + redaction side lives in `lock/note.test.ts`.

import { describe, expect, test } from "bun:test";
import type { AiCallEvent } from "../artifacts/events.ts";
import {
  MockDriver,
  makeFailureBatch,
  makeInteractiveElement,
  makeRankedCandidate,
  makeSnapshot,
  makeSuccessBatch,
} from "../driver/index.ts";
import type { Step } from "../flow/types.ts";
import type { CachedRecipe, LockHook, ResolveContext } from "../ladder/index.ts";
import { resolveStep } from "../ladder/orchestrator.ts";
import { composeLocks } from "../lock/compose.ts";
import { createLockHook } from "../lock/hook.ts";
import { NOTE_TTL_DAYS } from "../lock/index.ts";
import type { LockFile } from "../lock/types.ts";
import { createAiRuntime } from "./runtime.ts";
import type { AiCallSink, GenerateFn, GenerateRequest } from "./types.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-07-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

class RecordingSink implements AiCallSink {
  readonly events: Array<Omit<AiCallEvent, "ts" | "type">> = [];
  emitAiCall(p: Omit<AiCallEvent, "ts" | "type">): void {
    this.events.push(p);
  }
}

interface FakeResponse {
  output: unknown;
}

function makeFakeGenerate(responses: FakeResponse[]): { fn: GenerateFn; calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = [];
  let i = 0;
  const fn: GenerateFn = async (req) => {
    calls.push(req);
    const r = responses[Math.min(i, responses.length - 1)] ?? { output: {} };
    i += 1;
    return { output: r.output, model: req.models[0]!, usage: { inputTokens: 10, outputTokens: 5 } };
  };
  return { fn, calls };
}

const clickStep = (over: Partial<Step> = {}): Step =>
  ({ id: "s1", do: "click", target: "Save", ...over }) as Step;

/** A fixed lock hook that returns `recipe` for any step (note-context source for L2/L3). */
function fixedLockHook(recipe: CachedRecipe | undefined): LockHook {
  return { lookup: () => recipe };
}

function ctxFor(driver: MockDriver, ai: ResolveContext["ai"], lock?: LockHook): ResolveContext {
  return { driver, ai, now: () => T0, ...(lock ? { lock } : {}) };
}

// Concatenate every text part of a request's prompt/messages (what the model actually saw).
function requestText(req: GenerateRequest): string {
  if (req.prompt) return req.prompt;
  const parts: string[] = [];
  for (const m of req.messages ?? []) {
    for (const c of m.content) if (c.type === "text") parts.push(c.text);
  }
  return parts.join("\n");
}

describe("L2 resolver — note_in / note_out (DESIGN §4)", () => {
  test("a stored note is injected into the resolver prompt and the emitted note is captured", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Save" })],
      }),
    );
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Save" })]);
    d.setSignature("http://x/save|sig");
    d.enqueueBatchResult(makeFailureBatch("hidden")); // L1 escalates
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save")); // L2 acts

    const NOTE_IN = "icon-only toolbar, floppy-disk glyph top-right, no testid";
    const NOTE_OUT = "still glyph-only; picked the top-right icon";
    const { fn, calls } = makeFakeGenerate([
      { output: { decision: "pick", index: 0, confidence: 0.9, note: NOTE_OUT } },
    ]);
    const rt = createAiRuntime({ config: {}, generate: fn, aiWriter: new RecordingSink() });

    const lock = fixedLockHook({
      selector: "role:button:Save",
      strategy: "role_name",
      note: NOTE_IN,
    });
    const { execution } = await resolveStep(clickStep(), ctxFor(d, rt.hooks, lock));

    expect(execution.ok).toBe(true);
    expect(execution.tier).toBe("L2");
    // note_in: the stored note appears in the request the fake GenerateFn received.
    expect(requestText(calls[0]!)).toContain(NOTE_IN);
    // note_out: the model's emitted note is captured on the execution for write-back.
    expect(execution.note).toBe(NOTE_OUT);
  });

  test("no stored note → the prompt carries no injected note; no note_out when the model omits it", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Save" })],
      }),
    );
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Save" })]);
    d.setSignature("http://x/save|sig");
    d.enqueueBatchResult(makeFailureBatch("hidden"));
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save"));

    const { fn, calls } = makeFakeGenerate([
      { output: { decision: "pick", index: 0, confidence: 0.9 } },
    ]);
    const rt = createAiRuntime({ config: {}, generate: fn, aiWriter: new RecordingSink() });

    const { execution } = await resolveStep(
      clickStep(),
      ctxFor(d, rt.hooks, fixedLockHook(undefined)),
    );

    expect(execution.ok).toBe(true);
    expect(requestText(calls[0]!)).not.toContain("previous resolution of this target");
    expect(execution.note).toBeUndefined();
  });

  test("a STALE stored note (older than NOTE_TTL_DAYS) is NOT fed into the prompt", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Save" })],
      }),
    );
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Save" })]);
    d.setSignature("http://x/save|sig");
    d.enqueueBatchResult(makeFailureBatch("hidden"));
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save"));

    const STALE_NOTE = "OUTDATED HINT SHOULD NOT APPEAR";
    // Real lock hook over a composed lock whose note is well past the TTL — decay must drop it.
    const lockFile: LockFile = {
      version: 2,
      source: "f",
      source_hash: "h",
      description: "",
      targets: [
        {
          step: "s1",
          target: "Save",
          match: { url_glob: "http://x/save*", sig: "http://x/save|sig" },
          strategies: [
            { kind: "role_name", selector: "role:button:Save", greens: 3, last_ok: iso(T0) },
          ],
          memory: { note: STALE_NOTE, note_updated: iso(T0 - (NOTE_TTL_DAYS + 5) * DAY) },
        },
      ],
    };
    const lock = createLockHook(composeLocks(lockFile), { prefilterUrl: false });

    const { fn, calls } = makeFakeGenerate([
      { output: { decision: "pick", index: 0, confidence: 0.9 } },
    ]);
    const rt = createAiRuntime({ config: {}, generate: fn, aiWriter: new RecordingSink() });

    const { execution } = await resolveStep(clickStep(), ctxFor(d, rt.hooks, lock));

    expect(execution.ok).toBe(true);
    expect(requestText(calls[0]!)).not.toContain(STALE_NOTE);
  });
});

describe("L2 resolver — note confidence gate (PLAN_v003 §6 v003-4)", () => {
  test("an UNCORROBORATED, low-confidence pick writes NO note (confident-but-wrong guard)", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "button", name: "Save" }),
          makeInteractiveElement({ ref: "e2", role: "button", name: "Save draft" }),
        ],
      }),
    );
    // Two candidates; the model picks the SECOND (index 1), so it does NOT agree with the
    // deterministic fuzzy #1 → uncorroborated. Its confidence (0.6) clears L2_MIN_CONFIDENCE (0.5)
    // so the pick is ACTED on, but is BELOW NOTE_CONFIDENCE_MIN (0.8) → not high-confidence either.
    d.setResolveAll([
      makeRankedCandidate({ ref: "e1", role: "button", name: "Save", score: 0.9 }),
      makeRankedCandidate({ ref: "e2", role: "button", name: "Save draft", score: 0.8 }),
    ]);
    d.setSignature("http://x/save|sig");
    // L1 now vetoes the close Save/Save draft ranking before dispatch, so only L2 consumes a
    // scripted browser result.
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save draft")); // L2 acts

    const { fn } = makeFakeGenerate([
      { output: { decision: "pick", index: 1, confidence: 0.6, note: "SHOULD NOT PERSIST" } },
    ]);
    const rt = createAiRuntime({ config: {}, generate: fn, aiWriter: new RecordingSink() });

    const { execution } = await resolveStep(
      clickStep(),
      ctxFor(d, rt.hooks, fixedLockHook(undefined)),
    );

    expect(execution.ok).toBe(true);
    expect(execution.tier).toBe("L2");
    // The pick acted, but the note is dropped — nothing corroborated it and it was not high-conf.
    expect(execution.note).toBeUndefined();
  });

  test("a CORROBORATED pick (model agrees with fuzzy #1) persists its note even at mid confidence", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Save" })],
      }),
    );
    // The model picks index 0 — the deterministic fuzzy #1 with a real score → corroborated. Its
    // confidence (0.6) is BELOW NOTE_CONFIDENCE_MIN, so corroboration alone must carry the note.
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Save", score: 0.9 })]);
    d.setSignature("http://x/save|sig");
    d.enqueueBatchResult(makeFailureBatch("hidden"));
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save"));

    const NOTE_OUT = "floppy-disk glyph, no testid";
    const { fn } = makeFakeGenerate([
      { output: { decision: "pick", index: 0, confidence: 0.6, note: NOTE_OUT } },
    ]);
    const rt = createAiRuntime({ config: {}, generate: fn, aiWriter: new RecordingSink() });

    const { execution } = await resolveStep(
      clickStep(),
      ctxFor(d, rt.hooks, fixedLockHook(undefined)),
    );

    expect(execution.ok).toBe(true);
    expect(execution.note).toBe(NOTE_OUT);
  });

  test("a HIGH-CONFIDENCE but uncorroborated pick persists its note (confidence >= 0.8)", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "button", name: "Save" }),
          makeInteractiveElement({ ref: "e2", role: "button", name: "Save draft" }),
        ],
      }),
    );
    // Model picks index 1 (NOT fuzzy #1 → uncorroborated) but with confidence 0.85 ≥ 0.8.
    d.setResolveAll([
      makeRankedCandidate({ ref: "e1", role: "button", name: "Save", score: 0.9 }),
      makeRankedCandidate({ ref: "e2", role: "button", name: "Save draft", score: 0.8 }),
    ]);
    d.setSignature("http://x/save|sig");
    d.enqueueBatchResult(makeFailureBatch("hidden"));
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save draft"));

    const NOTE_OUT = "prefer the draft action on this form";
    const { fn } = makeFakeGenerate([
      { output: { decision: "pick", index: 1, confidence: 0.85, note: NOTE_OUT } },
    ]);
    const rt = createAiRuntime({ config: {}, generate: fn, aiWriter: new RecordingSink() });

    const { execution } = await resolveStep(
      clickStep(),
      ctxFor(d, rt.hooks, fixedLockHook(undefined)),
    );

    expect(execution.ok).toBe(true);
    expect(execution.note).toBe(NOTE_OUT);
  });
});

describe("L3 vision — note_in / note_out (DESIGN §4)", () => {
  test("a stored note is injected into the vision prompt and the emitted note is captured", async () => {
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Save" })],
      }),
    );
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Save", score: 0.3 })]);
    d.setSignature("http://x/icons|sig");
    d.enqueueScreenshot("BASE64JPEGDATA"); // L3 screenshot
    d.enqueueBatchResult(makeSuccessBatch("role:button:Save")); // L3 acts

    const NOTE_IN = "vision needed: unlabeled glyph, top-right";
    const NOTE_OUT = "confirmed glyph-only; vision required";
    const { fn, calls } = makeFakeGenerate([
      { output: { decision: "screenshot_needed", reason: "unlabeled" } }, // L2 → L3
      { output: { decision: "pick", index: 0, confidence: 0.95, note: NOTE_OUT } }, // L3 picks
    ]);
    const rt = createAiRuntime({ config: {}, generate: fn, aiWriter: new RecordingSink() });

    const lock = fixedLockHook({
      selector: "role:button:Save",
      strategy: "role_name",
      note: NOTE_IN,
    });
    const { execution } = await resolveStep(
      clickStep({ target: "glyph" }),
      ctxFor(d, rt.hooks, lock),
    );

    expect(execution.ok).toBe(true);
    expect(execution.tier).toBe("L3");
    // The vision (2nd) call carries the injected note.
    const visionText = requestText(calls[1]!);
    expect(visionText).toContain(NOTE_IN);
    expect(execution.note).toBe(NOTE_OUT);
  });
});
