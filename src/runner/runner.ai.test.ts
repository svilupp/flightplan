// Flightplan — runner AI-tier end-to-end tests (Phase 4, OFFLINE + deterministic).
//
// Drive the FULL `runFlow` with the AI tiers wired via the `aiRuntimeFactory` seam:
//   opts.aiRuntimeFactory = (deps) => createAiRuntime({ ...deps, generate: fakeGenerate })
// so EVERY model call goes through a scripted fake `GenerateFn` — NO network, NO API key (env:{}),
// NO AI SDK. The page boundary is `MockDriver`. These exercise the real orchestrator + lock +
// assert + artifacts integration, not the AI module in isolation (that lives in `ai/ai.test.ts`).
//
// Coverage:
//   - L1→L2 resolve + lock heal (resolver picks index → L2 acts → tier L2, lock healed)
//   - L2→L3 vision (resolver asks for a screenshot → vision picks → tier L3, screenshot taken)
//   - ai_judge assertion: text-only pass/fail + screenshot route (pass propagates like deterministic)
//   - ai_pick pin then replay (first run pins kind:'ai_pick' + label; replay hits L0 with zero AI)
//   - budget overflow → inconclusive (max_model_calls / max_screenshots / max_cost_usd / max_steps)
//   - L4 advisor verdicts (heal/bug/flake/intent_changed surfaced; run stays failed; patch artifact)
//   - cost totals (run_end + summary = fake tokens × registry pricing)

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
  makeFailureBatch,
  makeInteractiveElement,
  makeRankedCandidate,
  makeSnapshot,
  makeSuccessBatch,
} from "../driver/index.ts";
import { emptyLock, loadLockFile, writeLockFile } from "../lock/index.ts";
import type { AdvisoryVerdict } from "../types.ts";
import { runFlow } from "./runner.ts";
import type { AiRuntimeFactory, RunOptions } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers (mirror runner.test.ts) + the fake GenerateFn (mirrors ai/ai.test.ts)
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fp-runner-ai-"));
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

/** ai_call events live in `ai.jsonl` (created lazily on first emit). Missing file → `[]`. */
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

/** The AiRuntime factory the tests inject: the real runtime around a fake `GenerateFn`. */
function aiFactory(fn: GenerateFn): AiRuntimeFactory {
  return (deps) => createAiRuntime({ ...deps, generate: fn });
}

/** Build RunOptions with a scripted MockDriver + FakeClock + the AI runtime factory. */
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
    runId: "ai-testrun-0001",
    env: {}, // hermetic: NO API key anywhere → only the injected factory wires AI
    ...extra,
  };
}

/** A single-target click flow (id `act`) reused by several scenarios. */
function clickFlow(id: string, target: string, intent?: string): string {
  const targetToml = intent
    ? `target = [${JSON.stringify(target)}, ${JSON.stringify(intent)}]`
    : `target = ${JSON.stringify(target)}`;
  return `
version = 1
kind = "flow"
id = "${id}"
description = "${id}"

[[steps]]
id = "act"
do = "click"
${targetToml}
`;
}

const ORDER_URL = "http://localhost:3000/order";

/** A snapshot with a single "Create order" button (matches the click target above 0.4). */
function orderSnapshot() {
  return makeSnapshot({
    url: ORDER_URL,
    interactiveElements: [
      makeInteractiveElement({ ref: "e1", role: "button", name: "Create order" }),
    ],
  });
}

// ---------------------------------------------------------------------------
// L1 → L2 resolve + lock heal
// ---------------------------------------------------------------------------

describe("runFlow AI — L1→L2 resolve + lock heal", () => {
  /** Pre-write a stale lock whose recipe drifts and whose signature won't match (forces L0 miss). */
  async function writeStaleLock(lockPath: string): Promise<void> {
    const lock = emptyLock("ai.l2heal", "sha256:x", "ai l2 heal");
    lock.targets.push({
      step: "act",
      target: "Create order",
      // url_glob matches the page (so L0 reaches the sig gate) but the sig is stale → L0 miss.
      match: { url_glob: "http://localhost:3000/*", sig: "text:STALE|aaa;struct:/x|bbb" },
      selector: "role:button:OldOrder", // the drifted (now-wrong) winner
      strategy: "role_name",
      green_runs: 3,
    });
    await writeLockFile(lockPath, lock);
  }

  test("L1 acts+fails (drift) → resolver picks index 0 → L2 acts; lock heals; ai_call{resolver} logged", async () => {
    const { flowPath, outDir } = await writeFlow(clickFlow("ai.l2heal", "Create order"));
    const lockPath = flowPath.replace(/\.toml$/i, ".lock.toml");
    await writeStaleLock(lockPath);

    const d = new MockDriver();
    d.setSnapshot(orderSnapshot());
    // Native ranking resolves the "Create order" button so L1 acts (and fails on the drifted page).
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Create order" })]);
    d.setSignature(`${ORDER_URL}|freshsig`);
    d.enqueueBatchResult(makeFailureBatch("hidden")); // L1 acts on the drifted page → fails → escalate
    d.enqueueBatchResult(makeSuccessBatch("role:button:Create order")); // L2 acts on the resolver pick

    const { fn, calls } = makeFakeGenerate([
      { output: { decision: "pick", index: 0, confidence: 0.9 } },
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    expect(result.summary.verdict).toBe("passed"); // a heal does not fail the default (auto) run
    expect(result.exitCode).toBe(0);
    expect(result.summary.steps[0]?.tier).toBe("L2");
    // The drift self-healed.
    expect(result.summary.healed_steps).toEqual(["act"]);
    expect(result.summary.drift_count).toBe(1);

    // Exactly one resolver model call was made for this step.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.modelRole).toBe("resolver");

    // trace.jsonl carries the L2 resolution_attempt (the "resolution"); ai.jsonl carries the call.
    const trace = await readJsonl(join(result.runDir, "trace.jsonl"));
    const attempts = trace.filter((e) => e.type === "resolution_attempt");
    expect(attempts.some((a) => a.tier === "L2")).toBe(true);
    const aiCalls = await readAiCalls(result.runDir);
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]!.role).toBe("resolver");
    expect(aiCalls[0]!.purpose).toBe("resolve:act");
    expect(aiCalls[0]!.outcome).toBe("ok");

    // The lock was rewritten: new winner promoted to the top of the portfolio, the stale one demoted.
    const healed = await loadLockFile(lockPath);
    expect(healed.targets[0]?.strategies?.[0]?.selector).toBe("role:button:Create order");
    expect(healed.targets[0]?.strategies?.some((s) => s.selector === "role:button:OldOrder")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// L2 → L3 vision
// ---------------------------------------------------------------------------

describe("runFlow AI — L2→L3 vision", () => {
  test("resolver requests a screenshot → vision picks → tier L3 + one screenshot taken", async () => {
    const { flowPath, outDir } = await writeFlow(clickFlow("ai.l3vision", "trash icon"));

    const d = new MockDriver();
    // "Delete" scores below L1's 0.4 floor for intent "trash icon" → L1 escalates WITHOUT acting.
    // The native ranking still surfaces it (below-floor) so L3 vision has a candidate to pick.
    d.setSnapshot(
      makeSnapshot({
        url: "http://localhost:3000/icons",
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "button", name: "Delete" }),
        ],
      }),
    );
    d.setResolveAll([
      makeRankedCandidate({ ref: "e1", role: "button", name: "Delete", score: 0.3 }),
    ]);
    d.setSignature("http://localhost:3000/icons|sig");
    d.enqueueScreenshot("BASE64JPEGDATA"); // L3 screenshot
    d.enqueueBatchResult(makeSuccessBatch("role:button:Delete")); // L3 acts on the vision pick

    const { fn, calls } = makeFakeGenerate([
      { output: { decision: "screenshot_needed", reason: "icons unlabeled" } }, // resolver (L2)
      { output: { decision: "pick", index: 0, confidence: 0.92 } }, // vision (L3)
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps[0]?.tier).toBe("L3");
    expect(d.callsTo("screenshot")).toHaveLength(1); // exactly one screenshot (L3)

    expect(calls.map((c) => c.modelRole)).toEqual(["resolver", "vision"]);
    const aiCalls = await readAiCalls(result.runDir);
    expect(aiCalls.map((e) => e.role)).toEqual(["resolver", "vision"]);
  });
});

// ---------------------------------------------------------------------------
// ai_judge assertion — both routes
// ---------------------------------------------------------------------------

describe("runFlow AI — ai_judge assertion", () => {
  function judgeFlow(inputs: string[]): string {
    const inputsToml = inputs.map((i) => `"${i}"`).join(", ");
    return `
version = 1
kind = "flow"
id = "ai.judge"
description = "ai_judge"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/done"

[[steps.assert]]
type = "ai_judge"
prompt = "An order confirmation is shown."
inputs = [${inputsToml}]
`;
  }

  test("text-only judge passes → verdict passed; no screenshot; text model role", async () => {
    const { flowPath, outDir } = await writeFlow(judgeFlow(["text"]));
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ url: "http://localhost:3000/done", text: "Order confirmed" }));

    const { fn, calls } = makeFakeGenerate([
      { output: { pass: true, reason: "confirmation visible" } },
    ]);
    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.failed_assertions).toEqual([]);
    expect(d.callsTo("screenshot")).toHaveLength(0);
    expect(calls[0]!.modelRole).toBe("resolver"); // text judge runs on the cheap text model
    const aiCalls = await readAiCalls(result.runDir);
    expect(aiCalls[0]!.role).toBe("judge");
    expect(aiCalls[0]!.purpose).toBe("judge:open");
  });

  test("text-only judge fails → verdict failed (propagates like a deterministic assertion)", async () => {
    const { flowPath, outDir } = await writeFlow(judgeFlow(["text"]));
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ url: "http://localhost:3000/done", text: "No banner here" }));

    const { fn } = makeFakeGenerate([{ output: { pass: false, reason: "no confirmation" } }]);
    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    expect(result.summary.verdict).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.summary.failed_assertions).toHaveLength(1);
    expect(result.summary.failed_assertions[0]?.type).toBe("ai_judge");
    expect(d.callsTo("screenshot")).toHaveLength(0);
  });

  test("screenshot-route judge: pass propagates AND a screenshot is taken (vision model)", async () => {
    const { flowPath, outDir } = await writeFlow(judgeFlow(["screenshot"]));
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot({ url: "http://localhost:3000/done", text: "Order confirmed" }));
    d.setScreenshot("BASE64SHOT");

    const { fn, calls } = makeFakeGenerate([
      { output: { pass: true, reason: "confirmation visible" } },
    ]);
    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    expect(result.summary.verdict).toBe("passed");
    expect(d.callsTo("screenshot")).toHaveLength(1); // screenshot taken ONLY on the screenshot route
    expect(calls[0]!.modelRole).toBe("vision");
    const aiCalls = await readAiCalls(result.runDir);
    expect(aiCalls[0]!.role).toBe("judge");
  });
});

// ---------------------------------------------------------------------------
// ai_pick — pin then replay
// ---------------------------------------------------------------------------

describe("runFlow AI — ai_pick pin then replay", () => {
  const PICK_URL = "http://localhost:3000/pick";
  const AIPICK_FLOW = `
version = 1
kind = "flow"
id = "ai.pick"
description = "ai_pick pin"

[[steps]]
id = "act"
do = "ai_pick"
target = "Primary action"
`;

  function pickSnapshot() {
    return makeSnapshot({
      url: PICK_URL,
      interactiveElements: [
        makeInteractiveElement({ ref: "e1", role: "button", name: "Primary action" }),
      ],
    });
  }

  test("run 1 resolves (L2) + pins kind:'ai_pick' with label; run 2 replays at L0 with ZERO ai_calls", async () => {
    const { flowPath, outDir } = await writeFlow(AIPICK_FLOW);
    const lockPath = flowPath.replace(/\.toml$/i, ".lock.toml");

    // --- Run 1: no lock → L1 fails → L2 resolves + pins the choice. ---
    const d1 = new MockDriver();
    d1.setSnapshot(pickSnapshot());
    // Native ranking resolves the target so L1 acts (then fails, forcing the L2 escalation).
    d1.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Primary action" })]);
    d1.setSignature(`${PICK_URL}|sig1`);
    d1.enqueueBatchResult(makeFailureBatch("hidden")); // L1 fails → escalate
    d1.enqueueBatchResult(makeSuccessBatch("role:button:Primary action")); // L2 acts
    const { fn: fn1 } = makeFakeGenerate([
      { output: { decision: "pick", index: 0, confidence: 0.9 } },
    ]);

    const run1 = await runFlow(
      optsFor(flowPath, outDir, d1, defaultConfig(), { aiRuntimeFactory: aiFactory(fn1) }),
    );
    expect(run1.summary.verdict).toBe("passed");
    expect(run1.summary.steps[0]?.tier).toBe("L2");

    // The lock pinned the AI choice WITH its human-readable label (Gap 3).
    const pinned = await loadLockFile(lockPath);
    expect(pinned.targets[0]?.kind).toBe("ai_pick");
    expect(pinned.targets[0]?.pinned_choice?.selector).toBe("role:button:Primary action");
    expect(pinned.targets[0]?.pinned_choice?.label).toBe("Primary action");

    // --- Run 2: identical page → L0 validates + replays the pin (no AI used at all). ---
    const d2 = new MockDriver();
    d2.setSnapshot(pickSnapshot());
    d2.setSignature(`${PICK_URL}|sig1`);
    d2.setBatchResult(makeSuccessBatch("role:button:Primary action")); // L0 replay
    const { fn: fn2, calls: calls2 } = makeFakeGenerate([
      { output: { decision: "pick", index: 0 } },
    ]);

    const run2 = await runFlow(
      optsFor(flowPath, outDir, d2, defaultConfig(), {
        aiRuntimeFactory: aiFactory(fn2),
        runId: "ai-testrun-0002",
      }),
    );
    expect(run2.summary.verdict).toBe("passed");
    expect(run2.summary.steps[0]?.tier).toBe("L0"); // replayed the pin deterministically
    expect(calls2).toHaveLength(0); // the fake GenerateFn was NEVER invoked
    expect(await readAiCalls(run2.runDir)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Budget overflow → inconclusive (each ceiling)
// ---------------------------------------------------------------------------

describe("runFlow AI — budget overflow → inconclusive (exit 3)", () => {
  test("max_model_calls:0 → inconclusive with a partial step recorded", async () => {
    const { flowPath, outDir } = await writeFlow(clickFlow("ai.budget.calls", "Create order"));
    const d = new MockDriver();
    d.setSnapshot(orderSnapshot());
    d.setSignature(`${ORDER_URL}|s`);
    d.enqueueBatchResult(makeFailureBatch("hidden")); // L1 fails → escalate to L2 (which throws)
    const { fn } = makeFakeGenerate([{ output: { decision: "pick", index: 0, confidence: 0.9 } }]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig({ max_model_calls: 0 }), {
        aiRuntimeFactory: aiFactory(fn),
      }),
    );

    expect(result.summary.verdict).toBe("inconclusive");
    expect(result.exitCode).toBe(3);
    expect(result.summary.steps).toHaveLength(1); // partial evidence recorded
    expect(result.summary.steps[0]?.error).toContain("max_model_calls");
  });

  test("max_screenshots:0 → inconclusive before any screenshot is taken", async () => {
    const { flowPath, outDir } = await writeFlow(clickFlow("ai.budget.shots", "trash icon"));
    const d = new MockDriver();
    d.setSnapshot(
      makeSnapshot({
        url: "http://localhost:3000/icons",
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "button", name: "Delete" }),
        ],
      }),
    );
    d.setSignature("http://localhost:3000/icons|s");
    const { fn } = makeFakeGenerate([
      { output: { decision: "screenshot_needed", reason: "x" } }, // resolver → escalate to L3
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig({ max_screenshots: 0 }), {
        aiRuntimeFactory: aiFactory(fn),
      }),
    );

    expect(result.summary.verdict).toBe("inconclusive");
    expect(result.exitCode).toBe(3);
    expect(result.summary.steps[0]?.error).toContain("max_screenshots");
    expect(d.callsTo("screenshot")).toHaveLength(0); // the ceiling tripped BEFORE the screenshot
  });

  test("tiny max_cost_usd → inconclusive after the call accrues cost", async () => {
    const { flowPath, outDir } = await writeFlow(clickFlow("ai.budget.cost", "Create order"));
    const d = new MockDriver();
    d.setSnapshot(orderSnapshot());
    d.setSignature(`${ORDER_URL}|s`);
    d.enqueueBatchResult(makeFailureBatch("hidden")); // L1 fails → escalate to L2
    // resolver cost for 10/5 tokens = 0.0000018 > the 0.0000001 ceiling.
    const { fn } = makeFakeGenerate([{ output: { decision: "pick", index: 0, confidence: 0.9 } }]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig({ max_cost_usd: 0.0000001 }), {
        aiRuntimeFactory: aiFactory(fn),
      }),
    );

    expect(result.summary.verdict).toBe("inconclusive");
    expect(result.exitCode).toBe(3);
    expect(result.summary.steps[0]?.error).toContain("max_cost_usd");
    // The call WAS logged before the ceiling tripped.
    expect(await readAiCalls(result.runDir)).toHaveLength(1);
  });

  test("max_steps:1 → inconclusive; the 2nd step never starts", async () => {
    const FLOW = `
version = 1
kind = "flow"
id = "ai.budget.steps"
description = "max_steps"

[[steps]]
id = "one"
do = "goto"
url = "http://localhost:3000/a"

[[steps]]
id = "two"
do = "goto"
url = "http://localhost:3000/b"
`;
    const { flowPath, outDir } = await writeFlow(FLOW);
    const d = new MockDriver();
    d.setSnapshot(makeSnapshot());
    const { fn } = makeFakeGenerate([{ output: {} }]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig({ max_steps: 1 }), {
        aiRuntimeFactory: aiFactory(fn),
      }),
    );

    expect(result.summary.verdict).toBe("inconclusive");
    expect(result.exitCode).toBe(3);
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["one"]); // "two" never ran
  });
});

// ---------------------------------------------------------------------------
// L4 advisor verdicts — surfaced, never override the verdict; intent_changed patch artifact
// ---------------------------------------------------------------------------

describe("runFlow AI — L4 advisor verdicts", () => {
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
      summary: "wizard replaced by a single page",
      proposed_patch_path: "proposed-patches/act.patch",
    },
  ];

  for (const verdict of verdicts) {
    test(`kind=${verdict.kind}: surfaced in run.jsonl + summary; run stays failed`, async () => {
      const { flowPath, outDir } = await writeFlow(clickFlow("ai.advisor", "trash icon"));
      const d = new MockDriver();
      d.setSnapshot(
        makeSnapshot({
          url: "http://localhost:3000/icons",
          interactiveElements: [
            makeInteractiveElement({ ref: "e1", role: "button", name: "Delete" }),
          ],
        }),
      );
      d.setSignature("http://localhost:3000/icons|s");
      d.enqueueScreenshot("B64"); // L3 takes a screenshot before giving up
      const { fn } = makeFakeGenerate([
        { output: { decision: "give_up", reason: "no match" } }, // resolver (L2)
        { output: { decision: "give_up", reason: "no match" } }, // vision (L3)
        { output: verdict }, // advisor (L4)
      ]);

      const result = await runFlow(
        optsFor(flowPath, outDir, d, defaultConfig(), { aiRuntimeFactory: aiFactory(fn) }),
      );

      // The step failed (the advisor never acts) and the advisory NEVER overrides the verdict.
      expect(result.summary.verdict).toBe("failed");
      expect(result.exitCode).toBe(1);
      expect(result.summary.steps[0]?.ok).toBe(false);
      expect(result.summary.advisory_verdict).toBe(verdict.kind);

      // run.jsonl step_end surfaces the verdict (the "advisor: …" diagnosis as the step error).
      const runEvents = await readJsonl(join(result.runDir, "run.jsonl"));
      const stepEnd = runEvents.find((e) => e.type === "step_end" && e.stepId === "act");
      expect(String(stepEnd?.error)).toContain("advisor:");

      // ai.jsonl records the advisor call with the typed verdict kind.
      const aiCalls = await readAiCalls(result.runDir);
      const advisorCall = aiCalls.find((e) => e.role === "advisor");
      expect(advisorCall?.advisoryVerdict).toBe(verdict.kind);
      expect(advisorCall?.outcome).toBe(verdict.kind);

      // intent_changed materializes BOTH proposed-patch artifacts; summary points at the .patch.
      if (verdict.kind === "intent_changed") {
        expect(result.summary.proposed_patch_path).not.toBeNull();
        expect(result.summary.proposed_patch_path!.endsWith(".patch")).toBe(true);
        const patch = await readFile(join(result.runDir, "proposed-patches", "act.patch"), "utf8");
        expect(patch).toContain("wizard replaced by a single page");
        expect(patch).toContain("intent_changed");
        // structured sidecar exists too.
        const sidecar = JSON.parse(
          await readFile(join(result.runDir, "proposed-patches", "act.json"), "utf8"),
        );
        expect(sidecar.kind).toBe("intent_changed");
      } else {
        // bug / flake / heal (no validated basis) → no proposed patch written.
        expect(result.summary.proposed_patch_path).toBeNull();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Cost totals — run_end + summary equal fake tokens × registry pricing
// ---------------------------------------------------------------------------

describe("runFlow AI — cost totals", () => {
  test("run_end totals + summary equal the fake token counts × registry pricing", async () => {
    const { flowPath, outDir } = await writeFlow(clickFlow("ai.cost", "Create order"));
    const d = new MockDriver();
    d.setSnapshot(orderSnapshot());
    // Native ranking resolves the "Create order" button so L1 acts (then fails, escalating to L2).
    d.setResolveAll([makeRankedCandidate({ ref: "e1", role: "button", name: "Create order" })]);
    d.setSignature(`${ORDER_URL}|s`);
    d.enqueueBatchResult(makeFailureBatch("hidden")); // L1 fails → escalate to L2
    d.enqueueBatchResult(makeSuccessBatch("role:button:Create order")); // L2 acts
    const { fn } = makeFakeGenerate([
      {
        output: { decision: "pick", index: 0, confidence: 0.9 },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, defaultConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    // resolver pricing {in:0.09, out:0.18} per 1M × 10/5 tokens.
    const resolverCost = (10 / 1e6) * 0.09 + (5 / 1e6) * 0.18; // 0.0000018
    expect(result.summary.total_cost_usd).toBeCloseTo(resolverCost, 12);
    expect(result.summary.model_usage).toEqual([
      { role: "resolver", model: "deepseek/deepseek-v4-flash", calls: 1, cost_usd: resolverCost },
    ]);

    // The same totals were emitted on run_end.
    const runEvents = await readJsonl(join(result.runDir, "run.jsonl"));
    const runEnd = runEvents.find((e) => e.type === "run_end") as Record<string, any>;
    expect(runEnd.totals.total_cost_usd).toBeCloseTo(resolverCost, 12);
    expect(runEnd.totals.model_usage).toEqual([
      { role: "resolver", model: "deepseek/deepseek-v4-flash", calls: 1, cost_usd: resolverCost },
    ]);
  });
});
