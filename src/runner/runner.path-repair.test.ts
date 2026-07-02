// Flightplan — runner L5 path-repair end-to-end tests (PLAN_v003 v003-6, OFFLINE + deterministic).
//
// Drive the FULL `runFlow` with the AI tiers wired via the `aiRuntimeFactory` seam + a scripted fake
// `GenerateFn` (NO network, NO API key, NO SDK; the page boundary is `MockDriver`). These exercise
// the runner-level cheap-first path-repair loop: after a navigating/mutating step succeeds, the
// runner compares the NEXT recorded step's lock `match.sig` to the current post-action page
// signature; a mismatch is a DIVERGENCE that runs the bounded cheap→escalate planner and splices the
// repair steps into the stream. This is the planner's FIRST real exercise.
//
// Coverage:
//   - divergence → CHEAP repair → continue (planner uses modelRole:"planner").
//   - escalation on LOW confidence (a 2nd generate arrives with modelRole:"planner_capable").
//   - repeated-replan give-up bound (planner keeps failing to clear the divergence → step fails).
//   - max_replans hard stop → inconclusive; the failing step's error names max_replans.
//   - prompt-cache marker present on the planner GenerateRequest + byte-stable across replans.
//   - give_up → the diverged/failed step is not repaired (run stays failed).
//   - NO-AI-runtime is byte-identical: no divergence capture, no planner calls, planner fully inert.

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
import { emptyLock, writeLockFile } from "../lock/index.ts";
import { runFlow } from "./runner.ts";
import type { AiRuntimeFactory, RunOptions } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers (mirror runner.ai.test.ts)
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fp-runner-repair-"));
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

/** Config with `[plan]` policy overrides folded in (the planner is enabled by default). */
function planConfig(plan: Partial<ResolvedConfig["plan"]> = {}): ResolvedConfig {
  return resolveConfigWithDefaults([{ plan: { ...plan } }]);
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
    runId: "repair-testrun-0001",
    env: {}, // hermetic: NO API key anywhere → only the injected factory wires AI
    ...extra,
  };
}

const PAGE_URL = "http://localhost:3000/app";

/**
 * A two-step click flow: `act` navigates/mutates the page, then `next` is the recorded step the run
 * diverges at. Both are plain `click` targeting steps so both are path-mutating + lock-lookupable.
 */
const TWO_STEP_FLOW = `
version = 1
kind = "flow"
id = "repair.two"
description = "Reach the confirmation page"

[[steps]]
id = "act"
do = "click"
target = "Start"

[[steps]]
id = "next"
do = "click"
target = "Finish"
`;

/** A snapshot carrying both the `Start` and `Finish` buttons (so L1 can resolve either). */
function appSnapshot() {
  return makeSnapshot({
    url: PAGE_URL,
    interactiveElements: [
      makeInteractiveElement({ ref: "e1", role: "button", name: "Start" }),
      makeInteractiveElement({ ref: "e2", role: "button", name: "Finish" }),
      makeInteractiveElement({ ref: "e3", role: "button", name: "Continue" }),
    ],
    accessibilityTree: [
      { ref: "a1", role: "button", name: "Start", children: [] },
      { ref: "a2", role: "button", name: "Finish", children: [] },
      { ref: "a3", role: "button", name: "Continue", children: [] },
    ] as never,
    text: "app page",
  });
}

/**
 * Pre-write a lock whose `next` target carries a `match.sig` that will NOT match the current page's
 * post-action signature — so the divergence detector fires. (`act` has no lock target, so it simply
 * resolves at L1.) The struct component is bogus; the runner's live struct default differs → mismatch.
 */
async function writeDivergingLock(lockPath: string): Promise<void> {
  const lock = emptyLock("repair.two", "sha256:x", "Reach the confirmation page");
  lock.targets.push({
    step: "next",
    target: "Finish",
    match: {
      url_glob: "http://localhost:3000/*", // matches PAGE_URL → the recipe is consulted
      sig: "text:http://localhost:3000/app|STALEHASH;struct:http://localhost:3000/app|structRECORDED",
    },
    selector: "role:button:Finish",
    strategy: "role_name",
    green_runs: 3,
  });
  await writeLockFile(lockPath, lock);
}

/** Native ranking that resolves whichever button the intent names (so L1 acts on `act`/`next`). */
function rankForIntent(intent: string) {
  if (/finish/i.test(intent)) {
    return [makeRankedCandidate({ ref: "e2", role: "button", name: "Finish" })];
  }
  if (/continue/i.test(intent)) {
    return [makeRankedCandidate({ ref: "e3", role: "button", name: "Continue" })];
  }
  return [makeRankedCandidate({ ref: "e1", role: "button", name: "Start" })];
}

/** A driver scripted so every `click`/`fill`/etc. batch action succeeds and L1 resolution works. */
function repairDriver(): MockDriver {
  const d = new MockDriver();
  d.setSnapshot(appSnapshot());
  d.onResolveAll((intent) => rankForIntent(intent));
  d.setSignature(`${PAGE_URL}|freshtext`);
  d.setStructureSignature(`${PAGE_URL}|structLIVE`); // differs from the recorded stale struct
  d.setBatchResult(makeSuccessBatch("role:button:Start")); // every batch act succeeds
  return d;
}

// ---------------------------------------------------------------------------
// Divergence → cheap repair → continue
// ---------------------------------------------------------------------------

describe("runFlow path-repair — divergence → cheap repair → continue", () => {
  test("a diverged next step triggers a CHEAP planner repair; the repair step executes + run continues", async () => {
    const { flowPath, outDir } = await writeFlow(TWO_STEP_FLOW);
    const lockPath = flowPath.replace(/\.toml$/i, ".lock.toml");
    await writeDivergingLock(lockPath);

    const d = repairDriver();
    // The planner proposes ONE click("Continue"); the cheap arm is confident so no escalation.
    const { fn, calls } = makeFakeGenerate([
      {
        output: {
          decision: "repair",
          confidence: 0.9,
          steps: [{ do: "click", target: "Continue" }],
        },
      },
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, planConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    // The run continues to a passing verdict (act + repair + next all resolve at L1).
    expect(result.summary.verdict).toBe("passed");
    // Exactly ONE planner call was made, on the CHEAP planner model role (cheap-first).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.modelRole).toBe("planner");
    // The repair was accounted for and the synthetic step was spliced in + executed.
    expect(result.summary.replan_count).toBe(1);
    expect(result.summary.repaired_steps).toEqual(["next:repair:1.0"]);
    const executed = result.summary.steps.map((s) => s.stepId);
    expect(executed).toContain("next:repair:1.0");
    // Order: act → repair(next) → next (the repair step is spliced right after `act`).
    expect(executed).toEqual(["act", "next:repair:1.0", "next"]);
    // The repair step actually RESOLVED + ACTED (it did not merely appear in the summary): it
    // resolved through the normal ladder (L1) with ok=true, and the "Continue" intent the planner
    // proposed was ranked via the driver's native resolveAll (proving the proposed target flowed in).
    const repairStep = result.summary.steps.find((s) => s.stepId === "next:repair:1.0")!;
    expect(repairStep.ok).toBe(true);
    expect(repairStep.tier).toBe("L1");
    expect(d.callsTo("resolveAll").some((c) => /continue/i.test(String(c.args[0])))).toBe(true);
    // The planner call is logged as role "planner" (both arms attribute to the one planner surface).
    const aiCalls = await readAiCalls(result.runDir);
    const plannerCalls = aiCalls.filter((c) => c.role === "planner");
    expect(plannerCalls).toHaveLength(1);
    expect(String(plannerCalls[0]!.purpose)).toContain("replan:next");
  });
});

// ---------------------------------------------------------------------------
// Escalation on low confidence → planner_capable
// ---------------------------------------------------------------------------

describe("runFlow path-repair — escalation on low confidence", () => {
  test("a low-confidence cheap plan escalates: a 2nd generate arrives with modelRole:'planner_capable'", async () => {
    const { flowPath, outDir } = await writeFlow(TWO_STEP_FLOW);
    const lockPath = flowPath.replace(/\.toml$/i, ".lock.toml");
    await writeDivergingLock(lockPath);

    const d = repairDriver();
    // 1st (cheap) response: confidence BELOW the escalate threshold → re-issue on the capable arm.
    // 2nd (capable) response: a confident repair the runner acts on.
    const { fn, calls } = makeFakeGenerate([
      {
        output: {
          decision: "repair",
          confidence: 0.3,
          steps: [{ do: "click", target: "Continue" }],
        },
      },
      {
        output: {
          decision: "repair",
          confidence: 0.95,
          steps: [{ do: "click", target: "Continue" }],
        },
      },
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, planConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    expect(result.summary.verdict).toBe("passed");
    // TWO planner calls: cheap first, then the escalation-only capable arm — proving cheap-first.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.modelRole).toBe("planner");
    expect(calls[1]!.modelRole).toBe("planner_capable");
    // The escalated repair still resolved + spliced (one replan for this divergence).
    expect(result.summary.replan_count).toBe(1);
    // Both arms attribute to the one "planner" call role in ai.jsonl.
    const aiCalls = await readAiCalls(result.runDir);
    expect(aiCalls.filter((c) => c.role === "planner")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Repeated-replan give-up bound: the planner never clears the divergence → step fails
// ---------------------------------------------------------------------------

describe("runFlow path-repair — repeated-replan give-up bound", () => {
  test("a planner that never yields a usable step exhausts PLANNER_MAX_ATTEMPTS_PER_DIVERGENCE (=3)", async () => {
    const { flowPath, outDir } = await writeFlow(TWO_STEP_FLOW);
    const lockPath = flowPath.replace(/\.toml$/i, ".lock.toml");
    await writeDivergingLock(lockPath);

    const d = repairDriver();
    // The planner always returns `repair` (confident) but its ONLY proposed step is UNUSABLE — a
    // `goto` with no `url` is dropped by StepSchema validation → 0 usable steps → the loop retries,
    // bounded by PLANNER_MAX_ATTEMPTS_PER_DIVERGENCE (=3). No repair is ever spliced.
    const { fn, calls } = makeFakeGenerate([
      { output: { decision: "repair", confidence: 0.9, steps: [{ do: "goto" }] } },
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, planConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    // The divergence was NOT repaired (no usable step across all attempts): replan_count stays 0.
    expect(result.summary.replan_count).toBe(0);
    expect(result.summary.repaired_steps).toEqual([]);
    // No synthetic repair step ran — the un-repaired `next` still resolves deterministically (L0
    // portfolio-revalidation rescues its recipe on a signature miss).
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["act", "next"]);
    // The loop ran exactly PLANNER_MAX_ATTEMPTS_PER_DIVERGENCE (3) attempts. Confidence is above the
    // low-confidence bar, so escalation is driven ONLY by the repeated-replan signal: attempt 1 is
    // cheap-only; attempts 2 and 3 (≥ PLANNER_ESCALATE_ATTEMPTS) each add a capable re-issue.
    // ⇒ cheap×3 + capable×2 = 5 generate calls.
    expect(calls.map((c) => c.modelRole)).toEqual([
      "planner",
      "planner",
      "planner_capable",
      "planner",
      "planner_capable",
    ]);
  });
});

// ---------------------------------------------------------------------------
// max_replans hard stop → inconclusive
// ---------------------------------------------------------------------------

describe("runFlow path-repair — max_replans hard stop", () => {
  test("max_replans:0 → inconclusive before any planner call; the diverged step's error names max_replans", async () => {
    const { flowPath, outDir } = await writeFlow(TWO_STEP_FLOW);
    const lockPath = flowPath.replace(/\.toml$/i, ".lock.toml");
    await writeDivergingLock(lockPath);

    const d = repairDriver();
    // Even a valid repair plan is irrelevant — max_replans:0 fail-fasts BEFORE the first planner call.
    const { fn, calls } = makeFakeGenerate([
      {
        output: {
          decision: "repair",
          confidence: 0.9,
          steps: [{ do: "click", target: "Continue" }],
        },
      },
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, planConfig({ max_replans: 0 }), {
        aiRuntimeFactory: aiFactory(fn),
      }),
    );

    expect(result.summary.verdict).toBe("inconclusive");
    expect(result.exitCode).toBe(3);
    // The run fail-fasts on the max_replans ceiling — no planner generate call was ever made.
    expect(calls).toHaveLength(0);
    // The step that was mid-flight when the budget tripped records the max_replans error.
    const budgetStep = result.summary.steps.find((s) => String(s.error).includes("max_replans"));
    expect(budgetStep).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Prompt-cache marker present + byte-stable across replans in one run
// ---------------------------------------------------------------------------

describe("runFlow path-repair — prompt-cache marker", () => {
  test("the planner GenerateRequest carries a cache marker; the cached prefix is byte-stable across replans", async () => {
    // A THREE-step flow so the planner can be invoked for TWO distinct divergences in ONE run — the
    // two planner calls must share a byte-identical cached prefix (keyed on the flow goal).
    const THREE_STEP_FLOW = `
version = 1
kind = "flow"
id = "repair.three"
description = "Reach the confirmation page"

[[steps]]
id = "act"
do = "click"
target = "Start"

[[steps]]
id = "mid"
do = "click"
target = "Finish"

[[steps]]
id = "last"
do = "click"
target = "Continue"
`;
    const { flowPath, outDir } = await writeFlow(THREE_STEP_FLOW);
    const lockPath = flowPath.replace(/\.toml$/i, ".lock.toml");
    // Two diverging targets (`mid` and `last`) → two separate divergences → two replans.
    const lock = emptyLock("repair.three", "sha256:x", "Reach the confirmation page");
    for (const [step, target, sel] of [
      ["mid", "Finish", "role:button:Finish"],
      ["last", "Continue", "role:button:Continue"],
    ] as const) {
      lock.targets.push({
        step,
        target,
        match: {
          url_glob: "http://localhost:3000/*",
          sig: `text:http://localhost:3000/app|STALE_${step};struct:http://localhost:3000/app|structRECORDED`,
        },
        selector: sel,
        strategy: "role_name",
        green_runs: 3,
      });
    }
    await writeLockFile(lockPath, lock);

    const d = repairDriver();
    // Each divergence gets a confident cheap repair (a no-op-ish click that resolves at L1).
    const { fn, calls } = makeFakeGenerate([
      {
        output: { decision: "repair", confidence: 0.9, steps: [{ do: "click", target: "Start" }] },
      },
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, planConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    expect(result.summary.verdict).toBe("passed");
    // Two divergences were repaired in one run.
    expect(result.summary.replan_count).toBe(2);
    const plannerReqs = calls.filter((c) => c.modelRole === "planner");
    expect(plannerReqs.length).toBe(2);
    // Every planner request carries the prompt-cache marker (MANDATORY — PLAN_v003 v003-6).
    for (const req of plannerReqs) {
      expect(req.cache).toBeDefined();
      expect(typeof req.cache!.prefix).toBe("string");
      expect(req.cache!.prefix.length).toBeGreaterThan(0);
      // The cache KEY is the durable flow goal (the flow description here).
      expect(req.cache!.key).toBe("Reach the confirmation page");
    }
    // The cached PREFIX is byte-identical across the two replans (reused across the run).
    expect(plannerReqs[0]!.cache!.prefix).toBe(plannerReqs[1]!.cache!.prefix);
  });
});

// ---------------------------------------------------------------------------
// give_up → the step is not repaired (run continues per the un-repaired path)
// ---------------------------------------------------------------------------

describe("runFlow path-repair — give_up leaves the path un-repaired", () => {
  test("a confident give_up splices no steps and short-circuits the loop after ONE cheap call", async () => {
    const { flowPath, outDir } = await writeFlow(TWO_STEP_FLOW);
    const lockPath = flowPath.replace(/\.toml$/i, ".lock.toml");
    await writeDivergingLock(lockPath);

    const d = repairDriver();
    // A HIGH-confidence give_up: no low-confidence escalation, and give_up ends the loop at once →
    // exactly ONE (cheap) planner call, no repair steps spliced.
    const { fn, calls } = makeFakeGenerate([
      { output: { decision: "give_up", confidence: 0.95, reason: "cannot repair" } },
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, planConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    expect(result.summary.replan_count).toBe(0);
    expect(result.summary.repaired_steps).toEqual([]);
    // No synthetic repair step is present in the executed step list.
    expect(result.summary.steps.some((s) => /:repair:/.test(s.stepId))).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.modelRole).toBe("planner");
  });

  test("a LOW-confidence give_up still escalates once (cheap → capable) then stops", async () => {
    const { flowPath, outDir } = await writeFlow(TWO_STEP_FLOW);
    const lockPath = flowPath.replace(/\.toml$/i, ".lock.toml");
    await writeDivergingLock(lockPath);

    const d = repairDriver();
    // A low-confidence give_up: shouldEscalate fires on the low-confidence signal, so the cheap arm's
    // give_up is re-issued on the capable arm (still give_up) — proving escalation is confidence-, not
    // decision-, gated. Both are ONE divergence (one runPathRepair), so no replan is recorded.
    const { fn, calls } = makeFakeGenerate([
      { output: { decision: "give_up", confidence: 0.2, reason: "cannot repair" } },
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, d, planConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    expect(result.summary.replan_count).toBe(0);
    expect(result.summary.repaired_steps).toEqual([]);
    expect(calls.map((c) => c.modelRole)).toEqual(["planner", "planner_capable"]);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL — no-AI-runtime is byte-identical: planner fully inert
// ---------------------------------------------------------------------------

describe("runFlow path-repair — no AI runtime is fully inert (byte-identical)", () => {
  test("no ai runtime → NO planner generate calls, NO divergence capture, behavior == non-planner path", async () => {
    const { flowPath, outDir } = await writeFlow(TWO_STEP_FLOW);
    const lockPath = flowPath.replace(/\.toml$/i, ".lock.toml");
    // Even with a DIVERGING lock present, a run with NO AI runtime must never replan.
    await writeDivergingLock(lockPath);

    const d = repairDriver();
    // Count signature captures with a runtime vs without — the no-runtime run must NOT make the
    // EXTRA divergence-detection signature capture. (Baseline captured below.)
    const result = await runFlow(
      // NO aiRuntimeFactory + hermetic env → no runtime is built → the planner is inert.
      optsFor(flowPath, outDir, d, planConfig()),
    );

    // The run completes on the deterministic path; the planner never fired.
    expect(result.summary.replan_count).toBe(0);
    expect(result.summary.repaired_steps).toEqual([]);
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["act", "next"]);
    // No planner (or any AI) calls were logged at all.
    const aiCalls = await readAiCalls(result.runDir);
    expect(aiCalls).toHaveLength(0);
    // The verdict + per-step tiers match the plain deterministic path: `act` (no lock target) L1,
    // `next` L0 (its recipe is rescued by portfolio revalidation on the stale-signature miss — the
    // SAME deterministic outcome the planner run produces, minus the divergence probe + repair).
    expect(result.summary.verdict).toBe("passed");
    expect(result.summary.steps.map((s) => s.tier)).toEqual(["L1", "L0"]);
  });

  test("the no-runtime run makes FEWER signature captures than the planner run (no divergence probe)", async () => {
    const { flowPath, outDir } = await writeFlow(TWO_STEP_FLOW);
    const lockPath = flowPath.replace(/\.toml$/i, ".lock.toml");
    await writeDivergingLock(lockPath);

    // --- With a runtime: the divergence detector takes an EXTRA structure-signature capture. ---
    const withAi = repairDriver();
    const { fn } = makeFakeGenerate([
      {
        output: {
          decision: "repair",
          confidence: 0.9,
          steps: [{ do: "click", target: "Continue" }],
        },
      },
    ]);
    await runFlow(
      optsFor(flowPath, outDir, withAi, planConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );
    const withAiStructCaptures = withAi
      .callsTo("captureStateSignature")
      .filter((c) => (c.args[0] as { mode?: string } | undefined)?.mode === "structure").length;

    // --- Without a runtime: NO divergence probe → strictly fewer structure captures. ---
    const noAi = repairDriver();
    await runFlow(optsFor(flowPath, outDir, noAi, planConfig(), { runId: "repair-testrun-0002" }));
    const noAiStructCaptures = noAi
      .callsTo("captureStateSignature")
      .filter((c) => (c.args[0] as { mode?: string } | undefined)?.mode === "structure").length;

    expect(noAiStructCaptures).toBeLessThan(withAiStructCaptures);
  });
});
