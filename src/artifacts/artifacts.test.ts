// Artifacts tests: run-dir creation + resolved paths, JSONL round-trip, typed emit* shaping,
// summary.json, and deterministic runIds/timestamps via injected clock/id.
//
// All IO goes to a per-suite temp dir that is cleaned up in afterAll — nothing touches the
// real repo or `.flightplan-runs/`.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  ArtifactWriters,
  createRun,
  JsonlWriter,
  makeRunId,
  openArtifactWriters,
  type RunSummary,
  resolveRunDir,
  writeSummary,
} from "./index.ts";

const tmp = mkdtempSync(join(tmpdir(), "fp-artifacts-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A fixed clock + id source for deterministic runIds/timestamps. */
const FIXED_MS = Date.UTC(2026, 5, 29, 13, 45, 7, 123); // 2026-06-29T13:45:07.123Z
const fixedNow = () => FIXED_MS;
const fixedGenId = () => "abcd1234";

/** Read a JSONL file and parse each non-empty line. */
function readJsonl(path: string): Array<Record<string, unknown>> {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("makeRunId / runId determinism", () => {
  test("injected clock + id produce a stable, sortable runId", () => {
    const id = makeRunId(fixedNow, fixedGenId);
    expect(id).toBe("20260629T134507123-abcd1234");
  });

  test("two runIds in the same ms differ only by the id suffix", () => {
    let n = 0;
    const seq = () => `id${n++}`;
    const a = makeRunId(fixedNow, seq);
    const b = makeRunId(fixedNow, seq);
    expect(a).toBe("20260629T134507123-id0");
    expect(b).toBe("20260629T134507123-id1");
    expect(a < b).toBe(true); // chronological prefix + sortable suffix
  });
});

describe("resolveRunDir (pure, no IO)", () => {
  test("resolves all artifact paths under <base>/<runId> and they are absolute", () => {
    const rd = resolveRunDir({ baseDir: tmp, now: fixedNow, genId: fixedGenId });
    expect(rd.runId).toBe("20260629T134507123-abcd1234");
    expect(rd.dir).toBe(join(tmp, rd.runId));
    expect(rd.baseDir).toBe(tmp);
    expect(rd.runJsonl).toBe(join(rd.dir, "run.jsonl"));
    expect(rd.traceJsonl).toBe(join(rd.dir, "trace.jsonl"));
    expect(rd.aiJsonl).toBe(join(rd.dir, "ai.jsonl"));
    expect(rd.summaryJson).toBe(join(rd.dir, "summary.json"));
    expect(rd.screenshotsDir).toBe(join(rd.dir, "screenshots"));
    expect(rd.proposedPatchesDir).toBe(join(rd.dir, "proposed-patches"));
    for (const p of [rd.dir, rd.runJsonl, rd.screenshotsDir]) {
      expect(isAbsolute(p)).toBe(true);
    }
  });

  test("a relative baseDir resolves against the injected cwd", () => {
    const rd = resolveRunDir({
      baseDir: ".flightplan-runs",
      cwd: "/some/project",
      runId: "fixed",
    });
    expect(rd.dir).toBe(join("/some/project", ".flightplan-runs", "fixed"));
  });

  test("an explicit runId overrides generation", () => {
    const rd = resolveRunDir({ baseDir: tmp, runId: "my-run" });
    expect(rd.runId).toBe("my-run");
    expect(rd.dir).toBe(join(tmp, "my-run"));
  });
});

describe("createRun (directory structure)", () => {
  test("creates <base>/<runId>/ with screenshots/ and proposed-patches/ subdirs", async () => {
    const rd = await createRun({
      baseDir: join(tmp, "create"),
      now: fixedNow,
      genId: fixedGenId,
    });
    expect(existsSync(rd.dir)).toBe(true);
    expect(statSync(rd.dir).isDirectory()).toBe(true);
    expect(statSync(rd.screenshotsDir).isDirectory()).toBe(true);
    expect(statSync(rd.proposedPatchesDir).isDirectory()).toBe(true);
    // JSONL files + summary are NOT created eagerly (lazy on first write).
    expect(existsSync(rd.runJsonl)).toBe(false);
    expect(existsSync(rd.traceJsonl)).toBe(false);
    expect(existsSync(rd.aiJsonl)).toBe(false);
    expect(existsSync(rd.summaryJson)).toBe(false);
  });

  test("-o/--out style override: an absolute baseDir is used verbatim", async () => {
    const out = join(tmp, "custom-out");
    const rd = await createRun({ baseDir: out, runId: "r1" });
    expect(rd.baseDir).toBe(out);
    expect(rd.dir).toBe(join(out, "r1"));
    expect(existsSync(rd.dir)).toBe(true);
  });
});

describe("JsonlWriter (generic primitive)", () => {
  test("opens lazily and appends one parseable JSON object per line", async () => {
    const path = join(tmp, "raw.jsonl");
    const w = new JsonlWriter(path);
    expect(existsSync(path)).toBe(false); // not opened until first write
    await w.write({ a: 1 });
    await w.write({ b: "two", nested: { c: [1, 2, 3] } });
    await w.close();

    const events = readJsonl(path);
    expect(events).toEqual([{ a: 1 }, { b: "two", nested: { c: [1, 2, 3] } }]);
  });

  test("concurrent writes do not interleave bytes (each line parses)", async () => {
    const path = join(tmp, "concurrent.jsonl");
    const w = new JsonlWriter(path);
    const N = 50;
    await Promise.all(Array.from({ length: N }, (_, i) => w.write({ i, payload: "x".repeat(i) })));
    await w.close();

    const events = readJsonl(path);
    expect(events).toHaveLength(N);
    // Writes are serialized in submission order.
    expect(events.map((e) => e.i)).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  test("write after close rejects", async () => {
    const path = join(tmp, "afterclose.jsonl");
    const w = new JsonlWriter(path);
    await w.write({ ok: true });
    await w.close();
    expect(w.write({ ok: false })).rejects.toThrow(/write after close/);
  });

  test("close is idempotent", async () => {
    const path = join(tmp, "idempotent.jsonl");
    const w = new JsonlWriter(path);
    await w.write({ x: 1 });
    await w.close();
    await w.close(); // must not throw
    expect(readJsonl(path)).toEqual([{ x: 1 }]);
  });
});

describe("typed writers — emit* shaping + ts/type stamping", () => {
  test("RunWriter emit* methods produce correctly-shaped run events", async () => {
    const rd = await createRun({ baseDir: join(tmp, "runwriter"), runId: "rw" });
    const writers = new ArtifactWriters(rd, fixedNow);

    await writers.run.emitRunStart({
      runId: rd.runId,
      flowId: "flow-1",
      inputs: { email: "a@b.com" },
      configSummary: { provider: "browser-pilot", frozen: false },
      limits: { max_steps: 10 },
    });
    await writers.run.emitStepStart({ stepId: "s1", do: "click", intent: "log in" });
    await writers.run.emitStepEnd({
      stepId: "s1",
      ok: true,
      tier: "L1",
      healed: false,
      durationMs: 42,
    });
    await writers.run.emitAssertionResult({
      stepId: "s1",
      assertType: "visible",
      pass: true,
      message: "ok",
      durationMs: 5,
    });
    await writers.run.emitRunEnd({
      verdict: "passed",
      totals: {
        steps_run: 1,
        drift_count: 0,
        total_cost_usd: 0,
        model_usage: [],
      },
    });
    await writers.close();

    const events = readJsonl(rd.runJsonl);
    expect(events.map((e) => e.type)).toEqual([
      "run_start",
      "step_start",
      "step_end",
      "assertion_result",
      "run_end",
    ]);
    // Every event carries ts (from the injected clock) and type.
    for (const e of events) {
      expect(e.ts).toBe(FIXED_MS);
      expect(typeof e.type).toBe("string");
    }
    const stepEnd = events[2]!;
    expect(stepEnd).toMatchObject({
      type: "step_end",
      stepId: "s1",
      ok: true,
      tier: "L1",
      healed: false,
      durationMs: 42,
    });
  });

  test("TraceWriter emit* methods produce correctly-shaped trace events", async () => {
    const rd = await createRun({ baseDir: join(tmp, "tracewriter"), runId: "tw" });
    const writers = openArtifactWriters(rd, fixedNow);

    await writers.trace.emitBrowserAction({
      action: "click",
      selectorOrIntent: "log in button",
      selectorUsed: "role:button:name=Log in",
      strategy: "role_name",
      ok: true,
      durationMs: 12,
    });
    await writers.trace.emitResolutionAttempt({
      stepId: "s1",
      tier: "L1",
      strategy: "testid",
      candidates: ["testid:login", "role:button"],
      outcome: "resolved",
      durationMs: 3,
    });
    await writers.close();

    const events = readJsonl(rd.traceJsonl);
    expect(events.map((e) => e.type)).toEqual(["browser_action", "resolution_attempt"]);
    expect(events[0]).toMatchObject({
      type: "browser_action",
      action: "click",
      strategy: "role_name",
      ok: true,
      ts: FIXED_MS,
    });
    expect(events[1]).toMatchObject({
      type: "resolution_attempt",
      tier: "L1",
      outcome: "resolved",
      candidates: ["testid:login", "role:button"],
    });
  });

  test("AiWriter creates ai.jsonl lazily and shapes ai_call events", async () => {
    const rd = await createRun({ baseDir: join(tmp, "aiwriter"), runId: "aw" });
    const writers = openArtifactWriters(rd, fixedNow);

    // No ai.jsonl until the first emit (Phase 4 lazy creation).
    expect(existsSync(rd.aiJsonl)).toBe(false);

    await writers.ai.emitAiCall({
      role: "resolver",
      model: "deepseek/deepseek-v4-flash",
      purpose: "resolve",
      inputTokens: 120,
      outputTokens: 30,
      cost_usd: 0.000005,
      outcome: "ok",
      redactedPrompt: "[redacted]",
    });
    await writers.close();

    expect(existsSync(rd.aiJsonl)).toBe(true);
    const events = readJsonl(rd.aiJsonl);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "ai_call",
      role: "resolver",
      model: "deepseek/deepseek-v4-flash",
      cost_usd: 0.000005,
      ts: FIXED_MS,
    });
  });

  test("facade.close() closes a writer with no events without creating its file", async () => {
    const rd = await createRun({ baseDir: join(tmp, "emptyfacade"), runId: "ef" });
    const writers = openArtifactWriters(rd, fixedNow);
    await writers.run.emitStepStart({ stepId: "only", do: "goto" });
    await writers.close();
    expect(existsSync(rd.runJsonl)).toBe(true);
    // trace + ai never written → files never created.
    expect(existsSync(rd.traceJsonl)).toBe(false);
    expect(existsSync(rd.aiJsonl)).toBe(false);
  });
});

describe("writeSummary", () => {
  test("writes parseable JSON with the expected RunSummary fields", async () => {
    const rd = await createRun({ baseDir: join(tmp, "summary"), runId: "sum" });
    const summary: RunSummary = {
      verdict: "passed",
      flow_id: "flow-1",
      run_id: rd.runId,
      run_dir: rd.dir,
      failed_step: null,
      failed_assertions: [],
      advisory_verdict: null,
      healed_steps: ["s2"],
      drift_count: 1,
      screenshot_paths: [],
      video_path: null,
      trace_path: rd.traceJsonl,
      total_cost_usd: 0.0012,
      model_usage: [
        { role: "resolver", model: "deepseek/deepseek-v4-flash", calls: 1, cost_usd: 0.0012 },
      ],
      proposed_patch_path: null,
      replan_count: 0,
      repaired_steps: [],
      steps: [
        { stepId: "s1", do: "goto", ok: true, healed: false, durationMs: 100 },
        { stepId: "s2", do: "click", ok: true, tier: "L1", healed: true, durationMs: 50 },
      ],
    };
    await writeSummary(rd, summary);

    expect(existsSync(rd.summaryJson)).toBe(true);
    const parsed = JSON.parse(readFileSync(rd.summaryJson, "utf8")) as RunSummary;
    expect(parsed).toEqual(summary);
    expect(parsed.verdict).toBe("passed");
    expect(parsed.drift_count).toBe(parsed.healed_steps.length);
    expect(parsed.model_usage[0]?.role).toBe("resolver");
    expect(parsed.steps).toHaveLength(2);
  });
});
