// Flightplan — runner vision-BATCHING end-to-end tests (PLAN_v003 §4 v003-3, OFFLINE).
//
// Drive the full `runFlow` with the AI tiers wired via the `aiRuntimeFactory` seam and a scripted
// fake `GenerateFn` (NO network, NO API key, NO SDK; the page boundary is `MockDriver`). These
// exercise the runner's grouping of consecutive same-page `tier_hint = "vision"` targeting steps
// into ONE screenshot + ONE vision call via `resolveVisionBatch` + `resolveBatchL3`, plus the
// safety conditions that SPLIT a group and the per-target fallback.
//
// Coverage:
//   - ≥2 consecutive same-page vision-hinted steps → ONE screenshot + ONE vision call; both act.
//   - a navigation (goto) between two vision-hinted steps → SPLIT (never one batch call).
//   - malformed batch response → per-target fallback (each target resolves via its own vision call).
//   - a lone vision-hinted step → normal single path (no batch call).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateFn, GenerateRequest } from "../ai/index.ts";
import { createAiRuntime } from "../ai/index.ts";
import { FakeClock } from "../assert/clock.ts";
import type { ConnectConfig, ResolvedConfig } from "../config/index.ts";
import { resolveConfigWithDefaults } from "../config/index.ts";
import {
  MockDriver,
  makeInteractiveElement,
  makeRankedCandidate,
  makeSnapshot,
  makeSuccessBatch,
} from "../driver/index.ts";
import { runFlow } from "./runner.ts";
import type { AiRuntimeFactory, RunOptions } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers (mirror runner.ai.test.ts)
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fp-runner-vbatch-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function writeFlow(toml: string): Promise<{ flowPath: string; outDir: string }> {
  const dir = await makeTmpDir();
  const flowPath = join(dir, "flow.toml");
  await Bun.write(flowPath, toml);
  return { flowPath, outDir: join(dir, "runs") };
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function readAiCalls(runDir: string): Promise<Array<Record<string, unknown>>> {
  try {
    return await readJsonl(join(runDir, "ai.jsonl"));
  } catch {
    return [];
  }
}

function defaultConfig(overrides: Partial<ResolvedConfig["run"]> = {}): ResolvedConfig {
  return resolveConfigWithDefaults([{ run: { ...overrides } }]);
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

function aiFactory(fn: GenerateFn): AiRuntimeFactory {
  return (deps) => createAiRuntime({ ...deps, generate: fn });
}

function optsFor(
  flowPath: string,
  outDir: string,
  driver: MockDriver,
  config: ResolvedConfig,
  extra: Partial<RunOptions> = {},
): RunOptions {
  return {
    flowPath,
    config,
    out: outDir,
    driverFactory: (_cfg: ConnectConfig) => driver,
    clock: new FakeClock(),
    runId: "vbatch-testrun-0001",
    env: {}, // hermetic: NO API key anywhere → only the injected factory wires AI
    ...extra,
  };
}

const ICONS_URL = "http://localhost:3000/icons";

/** A page with two unlabeled icon buttons (Delete + Edit) the vision tier picks by index. */
function iconsSnapshot() {
  return makeSnapshot({
    url: ICONS_URL,
    interactiveElements: [
      makeInteractiveElement({ ref: "e1", role: "button", name: "Delete" }),
      makeInteractiveElement({ ref: "e2", role: "button", name: "Edit" }),
    ],
  });
}

/** Ranked-candidate list per intent: each vision target sees its own single-candidate packet at
 * index 0 so a `{ index: 0 }` pick maps to a concrete element. Falls back to Delete for any intent. */
function candidateForIntent(intent: string) {
  if (/edit/i.test(intent)) {
    return [makeRankedCandidate({ ref: "e2", role: "button", name: "Edit", score: 0.3 })];
  }
  return [makeRankedCandidate({ ref: "e1", role: "button", name: "Delete", score: 0.3 })];
}

/** The `purpose` field of an ai.jsonl event as a string (`""` when absent/non-string). */
function purposeOf(call: Record<string, unknown>): string {
  return typeof call.purpose === "string" ? call.purpose : "";
}

/** ai.jsonl calls whose purpose marks the ONE shared batch vision call (`vision-batch:<ids>`). */
function batchCalls(aiCalls: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return aiCalls.filter((c) => purposeOf(c).startsWith("vision-batch:"));
}

// ---------------------------------------------------------------------------
// ≥2 consecutive same-page vision-hinted steps → ONE screenshot + ONE vision call
// ---------------------------------------------------------------------------

describe("runFlow vision batching — group ≥2 same-page vision targets into one call", () => {
  const TWO_HINT_FLOW = `
version = 1
kind = "flow"
id = "vbatch.two"
description = "two vision targets on one page"

[[steps]]
id = "trash"
do = "click"
target = "trash icon"
tier_hint = "vision"

[[steps]]
id = "edit"
do = "click"
target = "edit icon"
tier_hint = "vision"
`;

  test("two consecutive vision-hinted clicks → 1 screenshot, 1 vision call; both act at L3", async () => {
    const { flowPath, outDir } = await writeFlow(TWO_HINT_FLOW);
    const d = new MockDriver();
    d.setSnapshot(iconsSnapshot());
    d.onResolveAll((intent) => candidateForIntent(intent));
    d.setSignature(`${ICONS_URL}|sig`);
    d.setScreenshot("BATCHSHOT"); // the one shared screenshot
    d.setBatchResult(makeSuccessBatch("role:button:Delete")); // each target's act succeeds

    // The ONE batch vision call answers both keys (the step ids `trash` + `edit`).
    const { fn, calls } = makeFakeGenerate([
      {
        output: {
          picks: [
            { key: "trash", decision: "pick", index: 0, confidence: 0.92 },
            { key: "edit", decision: "pick", index: 0, confidence: 0.9 },
          ],
        },
      },
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    expect(result.summary.verdict).toBe("passed");
    // ONE screenshot serves the whole batch (NOT one per target).
    expect(d.callsTo("screenshot")).toHaveLength(1);
    // Exactly ONE vision model call was made (the shared batch), and it was the batch purpose.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.modelRole).toBe("vision");
    const aiCalls = await readAiCalls(result.runDir);
    expect(batchCalls(aiCalls)).toHaveLength(1);
    expect(purposeOf(batchCalls(aiCalls)[0]!)).toBe("vision-batch:trash,edit");
    // Both steps resolved (at L3) and each acted (two driver.batch acts).
    expect(result.summary.steps.map((s) => s.tier)).toEqual(["L3", "L3"]);
    expect(result.summary.steps.every((s) => s.ok)).toBe(true);
    expect(d.callsTo("batch")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// A page-mutating step between two vision-hinted steps SPLITS the batch
// ---------------------------------------------------------------------------

describe("runFlow vision batching — a navigation step splits the group", () => {
  const SPLIT_FLOW = `
version = 1
kind = "flow"
id = "vbatch.split"
description = "vision targets split by a goto"

[[steps]]
id = "trash"
do = "click"
target = "trash icon"
tier_hint = "vision"

[[steps]]
id = "nav"
do = "goto"
url = "http://localhost:3000/next"

[[steps]]
id = "edit"
do = "click"
target = "edit icon"
tier_hint = "vision"
`;

  test("goto between two vision-hinted clicks → no batch call (each is a lone step)", async () => {
    const { flowPath, outDir } = await writeFlow(SPLIT_FLOW);
    const d = new MockDriver();
    d.setSnapshot(iconsSnapshot());
    // Above the 0.4 L1 floor so each lone step resolves at L1 (no AI needed) — the point is that the
    // two vision-hinted steps were NOT collapsed into one batch across the intervening navigation.
    d.onResolveAll((intent) => [
      makeRankedCandidate({
        ref: /edit/i.test(intent) ? "e2" : "e1",
        role: "button",
        name: /edit/i.test(intent) ? "Edit" : "Delete",
        score: 0.9,
      }),
    ]);
    d.setSignature(`${ICONS_URL}|sig`);
    d.setBatchResult(makeSuccessBatch("role:button:Delete"));

    const { fn, calls } = makeFakeGenerate([{ output: { picks: [] } }]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    expect(result.summary.verdict).toBe("passed");
    // NO shared batch vision call was ever made — the goto split the two targets across pages.
    const aiCalls = await readAiCalls(result.runDir);
    expect(batchCalls(aiCalls)).toHaveLength(0);
    expect(calls).toHaveLength(0); // both lone steps resolved deterministically at L1
    expect(result.summary.steps.map((s) => s.tier)).toEqual(["L1", undefined, "L1"]);
  });
});

// ---------------------------------------------------------------------------
// Malformed batch response → per-target fallback (each target its own vision call)
// ---------------------------------------------------------------------------

describe("runFlow vision batching — malformed batch falls back per-target", () => {
  const TWO_HINT_FLOW = `
version = 1
kind = "flow"
id = "vbatch.fallback"
description = "malformed batch falls back"

[[steps]]
id = "trash"
do = "click"
target = "trash icon"
tier_hint = "vision"

[[steps]]
id = "edit"
do = "click"
target = "edit icon"
tier_hint = "vision"
`;

  test("garbage batch output → each target resolves via its own single vision call, both act", async () => {
    const { flowPath, outDir } = await writeFlow(TWO_HINT_FLOW);
    const d = new MockDriver();
    d.setSnapshot(iconsSnapshot());
    d.onResolveAll((intent) => candidateForIntent(intent));
    d.setSignature(`${ICONS_URL}|sig`);
    d.setScreenshot("SHOT"); // shared batch shot + one per fallback target
    d.setBatchResult(makeSuccessBatch("role:button:Delete"));

    // 1st response: a malformed batch (fails BatchVisionSchema.strict → aiCall throws → fallback).
    // Following responses: valid single-target picks the per-target `resolveL3` fallbacks consume.
    const { fn, calls } = makeFakeGenerate([
      { output: { not_picks: "garbage" } }, // batch call → strict-parse failure
      { output: { decision: "pick", index: 0, confidence: 0.9 } }, // fallback resolveL3(trash)
      { output: { decision: "pick", index: 0, confidence: 0.9 } }, // fallback resolveL3(edit)
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    expect(result.summary.verdict).toBe("passed");
    // 3 vision model calls were ATTEMPTED: 1 (the batch, whose garbage output fails strict-parse) +
    // 2 (the per-target fallbacks). All on the vision model.
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.modelRole === "vision")).toBe(true);
    // A strict-parse failure on the batch emits no `ai_call` event, so ai.jsonl carries only the two
    // successful per-target fallback calls (`vision:trash` / `vision:edit`) — proving the batch was
    // attempted and each target then fell back to its own single vision call.
    const aiCalls = await readAiCalls(result.runDir);
    expect(batchCalls(aiCalls)).toHaveLength(0); // the failed batch parse logs nothing
    const singleVision = aiCalls.filter((c) => /^vision:/.test(purposeOf(c)));
    expect(singleVision.map(purposeOf).sort((a, b) => a.localeCompare(b))).toEqual([
      "vision:edit",
      "vision:trash",
    ]);
    // 3 screenshots: 1 shared (batch) + 1 per fallback target.
    expect(d.callsTo("screenshot")).toHaveLength(3);
    // Both steps still resolved (at L3) and acted.
    expect(result.summary.steps.map((s) => s.tier)).toEqual(["L3", "L3"]);
    expect(result.summary.steps.every((s) => s.ok)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A lone vision-hinted step degrades to the normal single path
// ---------------------------------------------------------------------------

describe("runFlow vision batching — a lone vision-hinted step uses the single path", () => {
  const ONE_HINT_FLOW = `
version = 1
kind = "flow"
id = "vbatch.one"
description = "single vision target"

[[steps]]
id = "trash"
do = "click"
target = "trash icon"
tier_hint = "vision"
`;

  test("single vision-hinted step → no batch call (normal per-step ladder)", async () => {
    const { flowPath, outDir } = await writeFlow(ONE_HINT_FLOW);
    const d = new MockDriver();
    d.setSnapshot(iconsSnapshot());
    // Above the L1 floor so the lone step resolves deterministically — the point is only that no
    // batch call was made (run length 1 never enters the batch path).
    d.onResolveAll(() => [
      makeRankedCandidate({ ref: "e1", role: "button", name: "Delete", score: 0.9 }),
    ]);
    d.setSignature(`${ICONS_URL}|sig`);
    d.setBatchResult(makeSuccessBatch("role:button:Delete"));

    const { fn, calls } = makeFakeGenerate([{ output: { picks: [] } }]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    expect(result.summary.verdict).toBe("passed");
    const aiCalls = await readAiCalls(result.runDir);
    expect(batchCalls(aiCalls)).toHaveLength(0); // never batched a run of length 1
    expect(calls).toHaveLength(0); // resolved at L1 via the normal single path
    expect(result.summary.steps[0]?.tier).toBe("L1");
    expect(result.summary.steps[0]?.ok).toBe(true);
  });
});
