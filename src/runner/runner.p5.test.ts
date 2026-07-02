// Flightplan — runner Phase-5 integration tests (OFFLINE + deterministic).
//
// Drive the FULL `runFlow` with an injected MockDriver + FakeClock (and, where needed, a fake
// `GenerateFn` and a telemetry `FakeSink`) to verify the Phase-5 runner wiring END TO END:
//   - Redaction   — a `secret:true` fill never leaks the raw value into run.jsonl / trace.jsonl /
//                   ai.jsonl; PII masked when `mask_text` on; identity when off.
//   - Telemetry   — a `FakeSink` captures the run/step span tree + browser_action /
//                   resolution_attempt / assertion_result / ai_call events; disabled → nothing.
//   - Video       — `[browser] record` drives startRecording/stopRecording + fills the summary
//                   media paths; off → unchanged; `redact_media` skips a secret-adjacent frame.
//   - Imports/hooks— a setup hook L0-hits + heals back to the MODULE's own lock (provenance), with
//                   setup → steps → teardown ordering; a composed import recipe L0-hits via the root.
//
// NO real browser, NO network, NO API key, NO real sleeping, NO telemetry token.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateFn, GenerateRequest } from "../ai/index.ts";
import { createAiRuntime } from "../ai/index.ts";
import { FakeClock } from "../assert/clock.ts";
import type { Config, ConnectConfig, ResolvedConfig } from "../config/index.ts";
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
import { REDACTED } from "../redaction/index.ts";
import { FakeSink } from "../telemetry/index.ts";
import { runFlow } from "./runner.ts";
import type { AiRuntimeFactory, RunOptions } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fp-runner-p5-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Write a single flow .toml into a fresh temp dir. */
async function writeFlow(toml: string): Promise<{ flowPath: string; outDir: string }> {
  const dir = await makeTmpDir();
  const flowPath = join(dir, "flow.toml");
  await Bun.write(flowPath, toml);
  return { flowPath, outDir: join(dir, "runs") };
}

/** Write several named files into one fresh temp dir (for imports/hooks scenarios). */
async function writeFiles(
  files: Record<string, string>,
): Promise<{ dir: string; outDir: string; pathOf: (name: string) => string }> {
  const dir = await makeTmpDir();
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(join(dir, name), content);
  }
  return { dir, outDir: join(dir, "runs"), pathOf: (name: string) => join(dir, name) };
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

/** The text of every artifact file in a run dir (for "raw secret never appears" scans). */
async function readAllRunFiles(runDir: string): Promise<string> {
  const names = ["run.jsonl", "trace.jsonl", "ai.jsonl", "summary.json"];
  const parts: string[] = [];
  for (const name of names) {
    try {
      parts.push(await readFile(join(runDir, name), "utf8"));
    } catch {
      /* file may not exist (e.g. ai.jsonl on an AI-less run) */
    }
  }
  return parts.join("\n");
}

function defaultConfig(overrides: Partial<ResolvedConfig["run"]> = {}): ResolvedConfig {
  return resolveConfigWithDefaults([{ run: { ...overrides } }]);
}

/** A resolved config from a single arbitrary layer (telemetry / browser / redaction overrides). */
function configWith(layer: Config): ResolvedConfig {
  return resolveConfigWithDefaults([layer]);
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
    runId: "p5-testrun-0001",
    env: {}, // hermetic: NO API key, NO LOGFIRE_TOKEN
    ...extra,
  };
}

/** A scripted fake GenerateFn (mirrors runner.ai.test.ts): returns `responses` in order. */
function makeFakeGenerate(
  responses: Array<{ output: unknown; usage?: { inputTokens: number; outputTokens: number } }>,
): { fn: GenerateFn; calls: GenerateRequest[] } {
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

// ===========================================================================
// 1. Redaction
// ===========================================================================

describe("runFlow P5 — redaction", () => {
  const SECRET = "hunter2-SECRET-TOKEN-XYZ";
  const SECRET_FLOW = `
version = 1
kind = "flow"
id = "p5.secret"
description = "secret redaction"

[inputs]
password = "${SECRET}"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/login"

[[steps]]
id = "enter_pw"
do = "fill"
target = ["text:Password", "type the password"]
value = "\${inputs.password}"
secret = true
`;

  function loginSnapshot() {
    return makeSnapshot({
      url: "http://localhost:3000/login",
      text: "Password",
      interactiveElements: [
        makeInteractiveElement({ ref: "e1", role: "textbox", name: "Password" }),
      ],
    });
  }

  test("a secret:true fill value never leaks into run.jsonl / trace.jsonl / summary.json", async () => {
    const { flowPath, outDir } = await writeFlow(SECRET_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(loginSnapshot());
    driver.setBatchResult(makeSuccessBatch("role:textbox:Password", "fill"));

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));
    expect(result.summary.verdict).toBe("passed");

    // run_start.inputs masks the secret-backing input wholesale.
    const runEvents = await readJsonl(join(result.runDir, "run.jsonl"));
    const runStart = runEvents.find((e) => e.type === "run_start") as Record<string, any>;
    expect(runStart.inputs.password).toBe(REDACTED);

    // The raw secret appears in NO artifact file.
    const all = await readAllRunFiles(result.runDir);
    expect(all).not.toContain(SECRET);
  });

  test("a secret:true SELECT value never leaks into artifacts (B7 — not only fills)", async () => {
    // Before the B7 fix `gatherSecretValues` scanned only `fill` steps, so a secret value used in a
    // `select` reached run.jsonl / trace.jsonl / summary.json in cleartext. This asserts the leak
    // is closed for a select exactly as it is for a fill.
    const SELECT_SECRET = "SECRET-PLAN-TOKEN-9Z";
    const SELECT_FLOW = `
version = 1
kind = "flow"
id = "p5.selectsecret"
description = "secret select redaction"

[inputs]
plan = "${SELECT_SECRET}"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/plan"

[[steps]]
id = "choose_plan"
do = "select"
target = ["text:Plan", "the plan dropdown"]
value = "\${inputs.plan}"
secret = true
`;
    const { flowPath, outDir } = await writeFlow(SELECT_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(
      makeSnapshot({
        url: "http://localhost:3000/plan",
        text: "Plan",
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "combobox", name: "Plan" }),
        ],
      }),
    );
    driver.setBatchResult(makeSuccessBatch("role:combobox:Plan", "select"));

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));
    expect(result.summary.verdict).toBe("passed");

    // run_start.inputs masks the secret-backing input wholesale.
    const runEvents = await readJsonl(join(result.runDir, "run.jsonl"));
    const runStart = runEvents.find((e) => e.type === "run_start") as Record<string, any>;
    expect(runStart.inputs.plan).toBe(REDACTED);

    // The raw secret appears in NO artifact file (this failed before the fix).
    const all = await readAllRunFiles(result.runDir);
    expect(all).not.toContain(SELECT_SECRET);
  });

  test("an assertion's observed/expected value never leaks a secret into run.jsonl / summary.json / telemetry", async () => {
    // The deterministic evaluators echo the configured `expected` AND the live observed DOM value
    // into the assertion message — the leak vector this test guards. A `value` assertion that
    // OBSERVES the secret (passing → run.jsonl + telemetry sinks) plus a `text` assertion whose
    // EXPECTED is the secret (failing → summary.json `failed_assertions`) exercise all three sinks.
    const ASSERT_SECRET_FLOW = `
version = 1
kind = "flow"
id = "p5.assertsecret"
description = "assertion message secret redaction"

[inputs]
password = "${SECRET}"

[[steps]]
id = "enter_pw"
do = "fill"
target = ["text:Password", "type the password"]
value = "\${inputs.password}"
secret = true

[[steps]]
id = "verify"
do = "goto"
url = "http://localhost:3000/verify"

[[steps.assert]]
type = "value"
selector = "role:textbox:Password"
value = "\${inputs.password}"

[[steps.assert]]
type = "text"
text = "\${inputs.password}"
`;
    const { flowPath, outDir } = await writeFlow(ASSERT_SECRET_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(
      makeSnapshot({
        url: "http://localhost:3000/login",
        text: "Welcome back", // does NOT contain the secret → the `text` assertion fails
        interactiveElements: [
          // The input echoes the filled secret as its live `value` → the `value` assertion observes it.
          makeInteractiveElement({ ref: "e1", role: "textbox", name: "Password", value: SECRET }),
        ],
      }),
    );
    driver.setBatchResult(makeSuccessBatch("role:textbox:Password", "fill"));
    const sink = new FakeSink();

    // Small assert timeout keeps the failing assertion's poll loop short; telemetry on to scan the
    // FakeSink's assertion_result events too.
    const cfg = configWith({
      run: { assert_timeout_ms: 50 },
      telemetry: { logfire: { enabled: true } },
    });
    const result = await runFlow(optsFor(flowPath, outDir, driver, cfg, { telemetrySink: sink }));

    // The failing `text` assertion fails the run (eager + fail_on_assertion default true).
    expect(result.summary.verdict).toBe("failed");

    // SINK 1 — run.jsonl: BOTH the passing (value) and failing (text) assertion_result messages
    // are redacted (the passing one would otherwise leak the observed secret in cleartext).
    const runEvents = await readJsonl(join(result.runDir, "run.jsonl"));
    const assertEvents = runEvents.filter((e) => e.type === "assertion_result") as Array<
      Record<string, any>
    >;
    expect(assertEvents.length).toBe(2);
    expect(assertEvents.some((e) => e.pass === true)).toBe(true); // value passed
    expect(assertEvents.some((e) => e.pass === false)).toBe(true); // text failed
    for (const e of assertEvents) {
      expect(String(e.message)).not.toContain(SECRET);
      expect(String(e.message)).toContain(REDACTED);
    }

    // SINK 2 — summary.json: the failing assertion's `detail` (→ failed_assertions) is redacted.
    expect(result.summary.failed_assertions.length).toBeGreaterThanOrEqual(1);
    for (const fa of result.summary.failed_assertions) {
      expect(fa.detail).not.toContain(SECRET);
      expect(fa.detail).toContain(REDACTED);
    }

    // SINK 3 — telemetry: the assertion_result events carry the redacted message too.
    const telAsserts = sink.eventsByName("assertion_result");
    expect(telAsserts.length).toBe(2);
    for (const ev of telAsserts) {
      expect(String(ev.attributes.message)).not.toContain(SECRET);
      expect(String(ev.attributes.message)).toContain(REDACTED);
    }

    // Belt-and-braces: the raw secret appears in NO artifact file at all.
    const all = await readAllRunFiles(result.runDir);
    expect(all).not.toContain(SECRET);
  });

  test("ai.jsonl is redacted: a secret echoed in the model response never reaches the log", async () => {
    const TOKEN = "SECRET-API-TOKEN-7777";
    const FLOW = `
version = 1
kind = "flow"
id = "p5.aisecret"
description = "ai secret redaction"

[inputs]
token = "${TOKEN}"

[[steps]]
id = "fill_token"
do = "fill"
target = ["text:Token", "the token field"]
value = "\${inputs.token}"
secret = true

[[steps]]
id = "act"
do = "click"
target = ["text:Create order", "create the order"]
`;
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(
      makeSnapshot({
        url: "http://localhost:3000/order",
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "textbox", name: "Token" }),
          makeInteractiveElement({ ref: "e2", role: "button", name: "Create order" }),
        ],
      }),
    );
    driver.enqueueBatchResult(makeSuccessBatch("role:textbox:Token", "fill")); // fill_token L1
    driver.enqueueBatchResult(makeFailureBatch("hidden")); // act L1 → escalate
    driver.enqueueBatchResult(makeSuccessBatch("role:button:Create order")); // act L2 acts

    // The resolver echoes the secret in `reason` — the redactor must mask it before ai.jsonl.
    const { fn } = makeFakeGenerate([
      { output: { decision: "pick", index: 0, confidence: 0.9, reason: `used ${TOKEN} here` } },
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, defaultConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );

    const aiCalls = await readAiCalls(result.runDir);
    const resolver = aiCalls.find((e) => e.role === "resolver");
    expect(resolver).toBeDefined();
    // The redactor is wired into the runtime → the event carries redacted prompt/response…
    expect(typeof resolver!.redactedResponse).toBe("string");
    expect(resolver!.redactedResponse as string).toContain(REDACTED);
    // …and the raw secret appears NOWHERE in any artifact.
    const all = await readAllRunFiles(result.runDir);
    expect(all).not.toContain(TOKEN);
  });

  test("an AI-emitted note echoing a secret is REDACTED before it reaches the lock + ai.jsonl (DESIGN §4)", async () => {
    const TOKEN = "SECRET-NOTE-TOKEN-4242";
    const FLOW = `
version = 1
kind = "flow"
id = "p5.notesecret"
description = "note secret redaction"

[inputs]
token = "${TOKEN}"

[[steps]]
id = "fill_token"
do = "fill"
target = ["text:Token", "the token field"]
value = "\${inputs.token}"
secret = true

[[steps]]
id = "act"
do = "click"
target = ["text:Create order", "create the order"]
`;
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(
      makeSnapshot({
        url: "http://localhost:3000/order",
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "textbox", name: "Token" }),
          makeInteractiveElement({ ref: "e2", role: "button", name: "Create order" }),
        ],
      }),
    );
    // L2 ranks via the driver's native resolveAll — give it the "Create order" candidate to pick.
    driver.setResolveAll([
      makeRankedCandidate({ ref: "e2", role: "button", name: "Create order" }),
    ]);
    driver.enqueueBatchResult(makeSuccessBatch("role:textbox:Token", "fill")); // fill_token L1
    driver.enqueueBatchResult(makeFailureBatch("hidden")); // act L1 → escalate
    driver.enqueueBatchResult(makeSuccessBatch("role:button:Create order")); // act L2 acts

    // The resolver EMITS a note echoing the secret — it must be masked before it reaches the lock.
    const { fn } = makeFakeGenerate([
      {
        output: {
          decision: "pick",
          index: 0,
          confidence: 0.9,
          note: `field was pre-filled with ${TOKEN}`,
        },
      },
    ]);

    const result = await runFlow(
      optsFor(flowPath, outDir, driver, defaultConfig(), { aiRuntimeFactory: aiFactory(fn) }),
    );
    expect(result.summary.verdict).toBe("passed");

    // The persisted lock file carries a REDACTED note on the `act` target (secret masked, note kept).
    const lockPath = flowPath.replace(/\.toml$/, ".lock.toml");
    const lockText = await readFile(lockPath, "utf8");
    expect(lockText).not.toContain(TOKEN);
    expect(lockText).toContain("«redacted»");
    expect(lockText).toContain("[targets.memory]");
    // Load with a clock near the FakeClock era (which stamped `note_updated`) so decay doesn't drop
    // the just-written note; then assert the structured note is present + redacted.
    const lock = await loadLockFile(lockPath, undefined, () => 0);
    const act = lock.targets.find((t) => t.step === "act");
    expect(act?.memory?.note).toBeDefined();
    expect(act?.memory?.note).not.toContain(TOKEN);
    expect(act?.memory?.note).toContain(REDACTED);

    // ai.jsonl's redacted response also masks the note-echoed secret; the raw secret is nowhere.
    const all = await readAllRunFiles(result.runDir);
    expect(all).not.toContain(TOKEN);
  });

  test("PII (email) in inputs is masked when mask_text on and passes through when off", async () => {
    const EMAIL = "alice@example.com";
    const FLOW = `
version = 1
kind = "flow"
id = "p5.pii"
description = "pii"

[inputs]
contact = "${EMAIL}"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/x"
`;
    // mask_text ON (default) → email masked.
    {
      const { flowPath, outDir } = await writeFlow(FLOW);
      const driver = new MockDriver();
      driver.setSnapshot(makeSnapshot());
      const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));
      const runStart = (await readJsonl(join(result.runDir, "run.jsonl"))).find(
        (e) => e.type === "run_start",
      ) as Record<string, any>;
      expect(runStart.inputs.contact).toBe(REDACTED);
    }
    // mask_text OFF + no secrets → identity (email passes through).
    {
      const { flowPath, outDir } = await writeFlow(FLOW);
      const driver = new MockDriver();
      driver.setSnapshot(makeSnapshot());
      const cfg = configWith({ redaction: { mask_text: false } });
      const result = await runFlow(optsFor(flowPath, outDir, driver, cfg));
      const runStart = (await readJsonl(join(result.runDir, "run.jsonl"))).find(
        (e) => e.type === "run_start",
      ) as Record<string, any>;
      expect(runStart.inputs.contact).toBe(EMAIL);
    }
  });
});

// ===========================================================================
// 2. Telemetry
// ===========================================================================

describe("runFlow P5 — telemetry", () => {
  const TEL_FLOW = `
version = 1
kind = "flow"
id = "p5.tel"
description = "telemetry"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/wizard"

[[steps.assert]]
type = "visible"
text = "Full name"

[[steps]]
id = "enter"
do = "fill"
target = ["text:Full name", "type the name"]
value = "Jane"

[[steps]]
id = "check"
do = "goto"
url = "http://localhost:3000/done"

[[steps.assert]]
type = "ai_judge"
prompt = "An order confirmation is shown."
inputs = ["text"]
`;

  function telSnapshot() {
    return makeSnapshot({
      url: "http://localhost:3000/wizard",
      text: "Full name Order confirmed",
      interactiveElements: [
        makeInteractiveElement({ ref: "e1", role: "textbox", name: "Full name" }),
      ],
    });
  }

  test("a FakeSink captures the run/step span tree + browser_action/resolution_attempt/assertion_result/ai_call", async () => {
    const { flowPath, outDir } = await writeFlow(TEL_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(telSnapshot());
    driver.setBatchResult(makeSuccessBatch("role:textbox:Full name", "fill"));
    const sink = new FakeSink();
    const { fn } = makeFakeGenerate([{ output: { pass: true, reason: "confirmation visible" } }]);

    const cfg = configWith({ telemetry: { logfire: { enabled: true } } });
    const result = await runFlow(
      optsFor(flowPath, outDir, driver, cfg, {
        telemetrySink: sink,
        aiRuntimeFactory: aiFactory(fn),
      }),
    );
    expect(result.summary.verdict).toBe("passed");

    // Root run span carries flow_id/run_id + end attrs verdict/drift_count.
    const run = sink.runSpan();
    expect(run).toBeDefined();
    expect(run!.attributes.flow_id).toBe("p5.tel");
    expect(run!.attributes.run_id).toBe("p5-testrun-0001");
    expect(run!.attributes.verdict).toBe("passed");
    expect(run!.attributes.drift_count).toBe(0);

    // One step span per step, each a child of the run span with step_id/do/ok attrs.
    const steps = sink.stepSpans();
    expect(steps.map((s) => s.attributes.step_id)).toEqual(["open", "enter", "check"]);
    for (const s of steps) {
      expect(s.parentSpanId).toBe(run!.spanId);
      expect(typeof s.attributes.ok).toBe("boolean");
      expect(typeof s.attributes.healed).toBe("boolean");
    }

    // Events landed on the step spans.
    expect(sink.eventsByName("browser_action").length).toBeGreaterThanOrEqual(1);
    expect(sink.eventsByName("resolution_attempt").length).toBeGreaterThanOrEqual(1);
    expect(sink.eventsByName("assertion_result").length).toBe(2); // visible + ai_judge
    const aiCallEvents = sink.eventsByName("ai_call");
    expect(aiCallEvents.length).toBe(1);
    expect(aiCallEvents[0]!.attributes.role).toBe("judge");
  });

  test("disabled telemetry (no token / not enabled) emits nothing and the run is unaffected", async () => {
    const { flowPath, outDir } = await writeFlow(TEL_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(telSnapshot());
    driver.setBatchResult(makeSuccessBatch("role:textbox:Full name", "fill"));
    const sink = new FakeSink();
    const { fn } = makeFakeGenerate([{ output: { pass: true } }]);

    // Default config (logfire enabled="auto") + env without a token → gating OFF → NOOP telemetry.
    const result = await runFlow(
      optsFor(flowPath, outDir, driver, defaultConfig(), {
        telemetrySink: sink,
        aiRuntimeFactory: aiFactory(fn),
      }),
    );

    expect(result.summary.verdict).toBe("passed");
    expect(sink.spans.length).toBe(0); // nothing exported when disabled
  });
});

// ===========================================================================
// 3. Video recording
// ===========================================================================

describe("runFlow P5 — video recording", () => {
  const REC_FLOW = `
version = 1
kind = "flow"
id = "p5.video"
description = "video"

[[steps]]
id = "open"
do = "goto"
url = "http://localhost:3000/app"

[[steps]]
id = "act"
do = "click"
target = ["text:Primary", "click primary"]
`;

  function appSnapshot() {
    return makeSnapshot({
      url: "http://localhost:3000/app",
      interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Primary" })],
    });
  }

  test("record on → start/stop recording called, summary carries video + screenshot paths + artifact telemetry", async () => {
    const { flowPath, outDir } = await writeFlow(REC_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(appSnapshot());
    driver.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));
    driver.setVideoPath("/fake/video.webm");
    const sink = new FakeSink();

    const cfg = configWith({
      browser: { record: true },
      telemetry: { logfire: { enabled: true } },
    });
    const result = await runFlow(optsFor(flowPath, outDir, driver, cfg, { telemetrySink: sink }));

    expect(result.summary.verdict).toBe("passed");
    expect(driver.callsTo("startRecording").length).toBe(1);
    expect(driver.lastRecordingDir).toBe(join(result.runDir, "screenshots"));
    expect(driver.callsTo("stopRecording").length).toBe(1);

    expect(result.summary.video_path).toBe("/fake/video.webm");
    // One persisted frame per step (goto + click).
    expect(result.summary.screenshot_paths.length).toBe(2);

    // artifact_created telemetry for the 2 screenshots + the video.
    const artifacts = sink.eventsByName("artifact_created");
    expect(artifacts.length).toBe(3);
    expect(artifacts.some((e) => e.attributes.kind === "video")).toBe(true);
    expect(artifacts.filter((e) => e.attributes.kind === "screenshot").length).toBe(2);
  });

  test("record off (default) → no capture, summary media stays empty/null (unchanged behavior)", async () => {
    const { flowPath, outDir } = await writeFlow(REC_FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(appSnapshot());
    driver.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));

    const result = await runFlow(optsFor(flowPath, outDir, driver, defaultConfig()));

    expect(result.summary.verdict).toBe("passed");
    expect(driver.callsTo("startRecording").length).toBe(0);
    expect(driver.callsTo("stopRecording").length).toBe(0);
    expect(result.summary.video_path).toBeNull();
    expect(result.summary.screenshot_paths).toEqual([]);
  });

  test("redact_media: a secret-adjacent step's screenshot is skipped (fail-closed)", async () => {
    const FLOW = `
version = 1
kind = "flow"
id = "p5.redactmedia"
description = "redact media"

[inputs]
pw = "MEDIA-SECRET-9"

[[steps]]
id = "fill_pw"
do = "fill"
target = ["text:Password", "the password field"]
value = "\${inputs.pw}"
secret = true

[[steps]]
id = "go"
do = "goto"
url = "http://localhost:3000/next"
`;
    const { flowPath, outDir } = await writeFlow(FLOW);
    const driver = new MockDriver();
    driver.setSnapshot(
      makeSnapshot({
        url: "http://localhost:3000/login",
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "textbox", name: "Password" }),
        ],
      }),
    );
    driver.setBatchResult(makeSuccessBatch("role:textbox:Password", "fill"));
    driver.setVideoPath("/fake/v.webm");

    // record on + redact_media on (default) → the secret fill's frame is NOT persisted.
    const cfg = configWith({ browser: { record: true } });
    const result = await runFlow(optsFor(flowPath, outDir, driver, cfg));

    expect(result.summary.verdict).toBe("passed");
    const savedPaths = driver.callsTo("saveScreenshot").map((c) => String(c.args[0]));
    // The secret step's frame was skipped; the non-secret step's was persisted.
    expect(savedPaths.some((p) => p.includes("fill_pw"))).toBe(false);
    expect(savedPaths.some((p) => p.includes("go"))).toBe(true);
    expect(result.summary.screenshot_paths.length).toBe(1);
  });
});

// ===========================================================================
// 4. Imports & hooks (lock composition end-to-end)
// ===========================================================================

describe("runFlow P5 — imports & hooks", () => {
  const LOGIN_MODULE = `
version = 1
kind = "flow"
id = "auth.login"
description = "login setup"

[[steps]]
id = "do_login"
do = "click"
target = ["text:Login", "click login"]
`;
  const LOGOUT_MODULE = `
version = 1
kind = "flow"
id = "auth.logout"
description = "logout teardown"

[[steps]]
id = "logout_step"
do = "goto"
url = "http://localhost:3000/logout"
`;
  const ROOT_WITH_HOOKS = `
version = 1
kind = "flow"
id = "p5.hooks"
description = "hooks"
setup = "./login.toml"
teardown = "./logout.toml"

[[steps]]
id = "act"
do = "click"
target = ["text:Primary", "click primary"]
`;

  function hooksSnapshot() {
    return makeSnapshot({
      url: "http://localhost:3000/app",
      interactiveElements: [
        makeInteractiveElement({ ref: "e1", role: "button", name: "Login" }),
        makeInteractiveElement({ ref: "e2", role: "button", name: "Primary" }),
      ],
    });
  }

  /** A stale module lock for `do_login` that L0-misses on signature (forces an L1 heal). */
  async function writeStaleLoginLock(lockPath: string): Promise<void> {
    const lock = emptyLock("auth.login", "sha256:x", "login setup");
    lock.targets.push({
      step: "do_login",
      target: "the login button",
      match: { url_glob: "http://localhost:3000/*", sig: "text:STALE|aaa;struct:/x|bbb" },
      selector: "role:button:OldLogin",
      strategy: "role_name",
      green_runs: 5,
    });
    await writeLockFile(lockPath, lock);
  }

  function hooksDriver(): MockDriver {
    const d = new MockDriver();
    d.setSnapshot(hooksSnapshot());
    d.setSignature("http://localhost:3000/app|fresh");
    d.enqueueBatchResult(makeSuccessBatch("role:button:Login", "click")); // setup do_login (L1 heal)
    d.enqueueBatchResult(makeSuccessBatch("role:button:Primary", "click")); // main act (L1 learn)
    return d;
  }

  test("setup → steps → teardown order; setup heal routes to the MODULE's own lock (provenance)", async () => {
    const { outDir, pathOf } = await writeFiles({
      "flow.toml": ROOT_WITH_HOOKS,
      "login.toml": LOGIN_MODULE,
      "logout.toml": LOGOUT_MODULE,
    });
    const loginLock = pathOf("login.toml").replace(/\.toml$/, ".lock.toml");
    const rootLock = pathOf("flow.toml").replace(/\.toml$/, ".lock.toml");
    await writeStaleLoginLock(loginLock);

    const result = await runFlow(
      optsFor(pathOf("flow.toml"), outDir, hooksDriver(), defaultConfig()),
    );

    expect(result.summary.verdict).toBe("passed");
    // Ordering: setup step runs before the main step (both recorded in the main summary).
    expect(result.summary.steps.map((s) => s.stepId)).toEqual(["do_login", "act"]);
    // run.jsonl proves setup → main → teardown ordering.
    const starts = (await readJsonl(join(result.runDir, "run.jsonl")))
      .filter((e) => e.type === "step_start")
      .map((e) => e.stepId);
    expect(starts).toEqual(["do_login", "act", "logout_step"]);

    // The setup step healed and that heal was written back to the MODULE's lock, not the root's.
    expect(result.summary.healed_steps).toEqual(["do_login"]);
    expect(result.summary.drift_count).toBe(1);
    const healedLogin = await loadLockFile(loginLock);
    expect(healedLogin.targets[0]?.strategies?.[0]?.selector).toBe("role:button:Login");
    expect(
      healedLogin.targets[0]?.strategies?.some((s) => s.selector === "role:button:OldLogin"),
    ).toBe(true);
    // The root lock learned the main step only (no `do_login` leaked into it).
    const root = await loadLockFile(rootLock);
    expect(root.targets.map((t) => t.step)).toEqual(["act"]);
  });

  test("--frozen: a setup-hook drift is reported AND fails the run, but the module lock is NOT persisted", async () => {
    const { outDir, pathOf } = await writeFiles({
      "flow.toml": ROOT_WITH_HOOKS,
      "login.toml": LOGIN_MODULE,
      "logout.toml": LOGOUT_MODULE,
    });
    const loginLock = pathOf("login.toml").replace(/\.toml$/, ".lock.toml");
    await writeStaleLoginLock(loginLock);
    const before = await loadLockFile(loginLock);

    const result = await runFlow(
      optsFor(pathOf("flow.toml"), outDir, hooksDriver(), defaultConfig(), { frozen: true }),
    );

    expect(result.summary.verdict).toBe("failed");
    expect(result.summary.drift_count).toBe(1);
    expect(result.summary.healed_steps).toEqual(["do_login"]);
    // The module lock is unchanged (frozen never writes).
    expect(await loadLockFile(loginLock)).toEqual(before);
  });

  test("an imported module's committed recipe is L0-hit by a root step (composed read view)", async () => {
    const MODULE = `
version = 1
kind = "flow"
id = "mod.sub"
description = "shared module"

[[steps]]
id = "shared"
do = "click"
target = ["text:Primary", "click primary"]
`;
    const ROOT = `
version = 1
kind = "flow"
id = "p5.import"
description = "imports composition"
imports = "./mod.toml"

[[steps]]
id = "shared"
do = "click"
target = ["text:Primary", "click primary"]
`;
    const { outDir, pathOf } = await writeFiles({ "flow.toml": ROOT, "mod.toml": MODULE });

    function primaryDriver(): MockDriver {
      const d = new MockDriver();
      d.setSnapshot(
        makeSnapshot({
          url: "http://localhost:3000/app",
          accessibilityTree: [
            { role: "main", ref: "n1", children: [{ role: "button", ref: "n2" }] },
          ],
          interactiveElements: [
            makeInteractiveElement({ ref: "e1", role: "button", name: "Primary" }),
          ],
        }),
      );
      d.setSignature("http://localhost:3000/app|stable");
      d.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));
      return d;
    }

    // (1) Run the module STANDALONE so it learns its own `mod.lock.toml` with a valid match.
    const learn = await runFlow(
      optsFor(pathOf("mod.toml"), outDir, primaryDriver(), defaultConfig(), {
        runId: "p5-learn-0001",
      }),
    );
    expect(learn.summary.verdict).toBe("passed");
    expect(learn.summary.steps[0]?.tier).toBe("L1"); // first-learn
    const modLock = await loadLockFile(pathOf("mod.toml").replace(/\.toml$/, ".lock.toml"));
    expect(modLock.targets[0]?.step).toBe("shared");

    // (2) Run the ROOT (which imports the module) against an IDENTICAL page → the root `shared` step
    //     misses its own (absent) lock but L0-hits the composed module recipe via the namespace.
    const run = await runFlow(
      optsFor(pathOf("flow.toml"), outDir, primaryDriver(), defaultConfig(), {
        runId: "p5-import-0002",
      }),
    );
    expect(run.summary.verdict).toBe("passed");
    expect(run.summary.steps[0]?.tier).toBe("L0"); // composed import recipe replayed at L0
    expect(run.summary.drift_count).toBe(0);
  });

  test("two imports defining the SAME step id emit a collision warning (H6)", async () => {
    // Both modules define step id `submit`. buildStepNamespaceMap silently binds a root `submit`
    // reference to the graph-iteration-first module; the H6 fix makes that ambiguity observable via
    // a run-time warning (binding behavior is unchanged — this is diagnostics only).
    const MOD_A = `
version = 1
kind = "flow"
id = "mod.a"
description = "module A"

[[steps]]
id = "submit"
do = "click"
target = ["text:Submit", "submit A"]
`;
    const MOD_B = `
version = 1
kind = "flow"
id = "mod.b"
description = "module B"

[[steps]]
id = "submit"
do = "click"
target = ["text:Submit", "submit B"]
`;
    const ROOT = `
version = 1
kind = "flow"
id = "p5.collision"
description = "import step-id collision"
imports = ["./a.toml", "./b.toml"]

[[steps]]
id = "act"
do = "click"
target = ["text:Primary", "click primary"]
`;
    const { outDir, pathOf } = await writeFiles({
      "flow.toml": ROOT,
      "a.toml": MOD_A,
      "b.toml": MOD_B,
    });

    const driver = new MockDriver();
    driver.setSnapshot(
      makeSnapshot({
        url: "http://localhost:3000/app",
        interactiveElements: [
          makeInteractiveElement({ ref: "e1", role: "button", name: "Primary" }),
        ],
      }),
    );
    driver.setBatchResult(makeSuccessBatch("role:button:Primary", "click"));

    const warnings: string[] = [];
    const result = await runFlow(
      optsFor(pathOf("flow.toml"), outDir, driver, defaultConfig(), {
        onWarn: (m) => warnings.push(m),
      }),
    );

    // The run itself is unaffected (binding behavior unchanged).
    expect(result.summary.verdict).toBe("passed");

    // A collision warning names the step id AND both competing modules.
    const collisionWarn = warnings.find((w) => w.includes("import step-id collision"));
    expect(collisionWarn).toBeDefined();
    expect(collisionWarn).toContain('"submit"');
    expect(collisionWarn).toContain("mod.a");
    expect(collisionWarn).toContain("mod.b");
  });
});
