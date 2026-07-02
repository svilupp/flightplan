// Flightplan — telemetry module (PLAN.md §5 Phase 5; P5_DESIGN.md §4 "TELEMETRY", Unit B).
//
// Optional Logfire spans/events behind a sink seam. Gated on a resolvable Logfire token; a
// `NoopTelemetry` (zero overhead) is used when disabled. Telemetry NEVER breaks a run: every
// sink interaction is guarded, errors are swallowed/observed, and a transport failure degrades
// the run's telemetry to a no-op mid-run.
//
// =============================================================================================
// UNIT-E WIRING CONTRACT (what the runner must call — runner.ts is owned by Unit E, NOT here)
// =============================================================================================
// In `runFlow` (mirrors the existing `writers.*` artifact emit points):
//   const tel = createTelemetry({ config: opts.config, env: process.env,
//                                 sink: opts.telemetrySink /* test seam */ });
//   const runSpan = tel.startRun(runSpanAttrs({ flowId, runId }));   // runner.ts ~:775
//     ...
//   runSpan.end(runEndAttrs({ verdict, driftCount }));               // runner.ts ~:895-909
//
// Per step (in `executeSteps`, runner.ts ~:516-615):
//   const stepSpan = runSpan.child(TELEMETRY_SPAN_NAMES.step,
//                                  stepSpanAttrs({ stepId, do, intent }));   // step_start
//   ... stepSpan.event(TELEMETRY_EVENTS.browserAction, browserActionEventAttrs(ev))   // emitLadderTrace ~:268-300
//   ... stepSpan.event(TELEMETRY_EVENTS.resolutionAttempt, resolutionAttemptEventAttrs(ev))
//   ... stepSpan.event(TELEMETRY_EVENTS.assertionResult, assertionResultEventAttrs(ev)) // runAndRecordAssertions ~:325-331
//   ... stepSpan.event(TELEMETRY_EVENTS.aiCall, aiCallEventAttrs(ev))     // via AiRuntimeDeps.onAiCall observer (R5)
//   ... stepSpan.event(TELEMETRY_EVENTS.artifactCreated, artifactCreatedAttrs({ kind, path }))
//   ... stepSpan.event(TELEMETRY_EVENTS.lockWrite, lockEventAttrs({ source, step, healed }))  // lock flush ~:851-857
//   stepSpan.end(stepEndAttrs({ ok, tier, healed, repaired, durationMs }));      // step_end ~:583-589
//
// Test seam: add `telemetrySink?: TelemetrySink` (or `telemetry?: Telemetry`) to `RunOptions`
// (runner/types.ts, Unit E) and pass a `FakeSink` so tests assert spans without env/network.
// =============================================================================================

import type { Config } from "../config/types.ts";
import { LogfireSink } from "./otlp.ts";
import type {
  AttributeValue,
  ExportedSpan,
  ExportedSpanEvent,
  IdGenerator,
  SpanAttributes,
  SpanHandle,
  Telemetry,
  TelemetrySink,
} from "./types.ts";
import { TELEMETRY_SPAN_NAMES } from "./types.ts";

export * from "./attrs.ts";
export { DEFAULT_LOGFIRE_ENDPOINT, LogfireSink, toKeyValues, toOtlpPayload } from "./otlp.ts";
export * from "./types.ts";

// ---------------------------------------------------------------------------
// Clock + id helpers
// ---------------------------------------------------------------------------

/** Convert a millisecond epoch to a stringified nanosecond epoch (OTLP `timeUnixNano`). */
function msToNano(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let s = "";
  for (const b of arr) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Crypto-random OTLP ids (16-byte trace, 8-byte span). */
export const defaultIdGenerator: IdGenerator = {
  traceId: () => randomHex(16),
  spanId: () => randomHex(8),
};

/** Drop `undefined`-valued attributes so a recorded span/event never carries them. */
function cleanAttrs(attrs: SpanAttributes | undefined): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  if (!attrs) return out;
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live span (real telemetry path)
// ---------------------------------------------------------------------------

/** Per-run shared runtime threaded through every span in one trace. */
interface SpanRuntime {
  sink: TelemetrySink;
  now: () => number;
  ids: IdGenerator;
  traceId: string;
  onError: (err: unknown) => void;
  /** Flips to true on the first transport failure → subsequent spans skip export (degrade). */
  degraded: { value: boolean };
}

class LiveSpan implements SpanHandle {
  readonly #rt: SpanRuntime;
  readonly #spanId: string;
  readonly #parentSpanId: string | undefined;
  readonly #name: string;
  readonly #startNano: string;
  readonly #attributes: Record<string, AttributeValue> = {};
  readonly #events: ExportedSpanEvent[] = [];
  #ended = false;

  constructor(
    rt: SpanRuntime,
    name: string,
    parentSpanId: string | undefined,
    attrs?: SpanAttributes,
  ) {
    this.#rt = rt;
    this.#name = name;
    this.#parentSpanId = parentSpanId;
    this.#spanId = this.#safe(() => rt.ids.spanId(), "0000000000000000");
    this.#startNano = msToNano(this.#nowMs());
    Object.assign(this.#attributes, cleanAttrs(attrs));
  }

  setAttribute(key: string, value: AttributeValue): void {
    try {
      if (value !== undefined) this.#attributes[key] = value;
    } catch (err) {
      this.#rt.onError(err);
    }
  }

  setAttributes(attrs: SpanAttributes): void {
    try {
      Object.assign(this.#attributes, cleanAttrs(attrs));
    } catch (err) {
      this.#rt.onError(err);
    }
  }

  event(name: string, attrs?: SpanAttributes): void {
    try {
      this.#events.push({
        name,
        timeUnixNano: msToNano(this.#nowMs()),
        attributes: cleanAttrs(attrs),
      });
    } catch (err) {
      this.#rt.onError(err);
    }
  }

  child(name: string, attrs?: SpanAttributes): SpanHandle {
    try {
      return new LiveSpan(this.#rt, name, this.#spanId, attrs);
    } catch (err) {
      this.#rt.onError(err);
      return NOOP_SPAN;
    }
  }

  end(attrs?: SpanAttributes): void {
    try {
      if (this.#ended) return;
      this.#ended = true;
      Object.assign(this.#attributes, cleanAttrs(attrs));
      const span: ExportedSpan = {
        traceId: this.#rt.traceId,
        spanId: this.#spanId,
        ...(this.#parentSpanId ? { parentSpanId: this.#parentSpanId } : {}),
        name: this.#name,
        startTimeUnixNano: this.#startNano,
        endTimeUnixNano: msToNano(this.#nowMs()),
        attributes: { ...this.#attributes },
        events: this.#events.slice(),
      };
      this.#emit(span);
    } catch (err) {
      this.#rt.onError(err);
    }
  }

  #emit(span: ExportedSpan): void {
    if (this.#rt.degraded.value) return;
    let result: void | Promise<void>;
    try {
      result = this.#rt.sink.export(span);
    } catch (err) {
      this.#degrade(err);
      return;
    }
    if (result && typeof result.then === "function") {
      result.then(undefined, (err) => this.#degrade(err));
    }
  }

  #degrade(err: unknown): void {
    this.#rt.degraded.value = true;
    this.#rt.onError(err);
  }

  #nowMs(): number {
    return this.#safe(() => this.#rt.now(), Date.now());
  }

  #safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      this.#rt.onError(err);
      return fallback;
    }
  }
}

// ---------------------------------------------------------------------------
// No-op telemetry (disabled path — zero allocation per call)
// ---------------------------------------------------------------------------

/** A shared do-nothing span. `child()` returns itself, so the disabled path never allocates. */
export const NOOP_SPAN: SpanHandle = Object.freeze({
  setAttribute() {},
  setAttributes() {},
  event() {},
  child() {
    return NOOP_SPAN;
  },
  end() {},
});

class NoopTelemetry implements Telemetry {
  readonly enabled = false;
  startRun(): SpanHandle {
    return NOOP_SPAN;
  }
}

/** The shared disabled-telemetry singleton (used everywhere telemetry is off). */
export const NOOP_TELEMETRY: Telemetry = new NoopTelemetry();

/** A sink that discards every span (used when a real transport is unavailable). */
export class NoopSink implements TelemetrySink {
  export(): void {
    /* discard */
  }
}

// ---------------------------------------------------------------------------
// Sink-backed telemetry (real path; works with any TelemetrySink)
// ---------------------------------------------------------------------------

interface SinkTelemetryDeps {
  sink: TelemetrySink;
  now: () => number;
  ids: IdGenerator;
  onError: (err: unknown) => void;
}

class SinkTelemetry implements Telemetry {
  readonly enabled = true;
  readonly #deps: SinkTelemetryDeps;

  constructor(deps: SinkTelemetryDeps) {
    this.#deps = deps;
  }

  startRun(attrs?: SpanAttributes): SpanHandle {
    try {
      const traceId = this.#deps.ids.traceId();
      const rt: SpanRuntime = {
        sink: this.#deps.sink,
        now: this.#deps.now,
        ids: this.#deps.ids,
        traceId,
        onError: this.#deps.onError,
        degraded: { value: false },
      };
      return new LiveSpan(rt, TELEMETRY_SPAN_NAMES.run, undefined, attrs);
    } catch (err) {
      this.#deps.onError(err);
      return NOOP_SPAN;
    }
  }
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

export interface TelemetryGating {
  enabled: boolean;
  /** The resolved token (may be undefined when `enabled` is forced true with no token). */
  token: string | undefined;
  serviceName: string;
  /** The env var name the token was looked up under. */
  tokenEnv: string;
}

/**
 * Resolve telemetry gating (P5_DESIGN.md §4 "Gating"):
 *   - `enabled === false`        → off.
 *   - `enabled === true`         → on (token may be absent → warn; spans dropped).
 *   - `auto` / unset             → on iff a token is present in env.
 * Token env name = `[telemetry.logfire].token_env` (default `LOGFIRE_TOKEN`).
 */
export function resolveTelemetryGating(
  config: Config,
  env: Record<string, string | undefined>,
): TelemetryGating {
  const lf = config.telemetry?.logfire;
  const tokenEnv = lf?.token_env ?? "LOGFIRE_TOKEN";
  const token = env[tokenEnv]?.trim() || undefined;
  const serviceName = lf?.service_name ?? "flightplan";
  const enabledCfg = lf?.enabled; // "auto" | boolean | undefined

  let enabled: boolean;
  if (enabledCfg === false) enabled = false;
  else if (enabledCfg === true) enabled = true;
  else enabled = token !== undefined; // "auto" | undefined

  return { enabled, token, serviceName, tokenEnv };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateTelemetryOptions {
  config: Config;
  /** The process env (token lookup). Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Inject a sink (tests use `FakeSink`); defaults to a `LogfireSink` when a token resolves. */
  sink?: TelemetrySink;
  /** Injectable clock (ms epoch) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable id generator for deterministic tests. */
  ids?: IdGenerator;
  /** Observe internal/transport errors (tests assert telemetry never throws). Default: swallow. */
  onError?: (err: unknown) => void;
  /** Observe the "enabled but no token" warning. Default: `console.warn`. */
  onWarn?: (message: string) => void;
}

/**
 * Build the telemetry facade. Returns a `NoopTelemetry` (zero overhead) when disabled, otherwise
 * a `SinkTelemetry` over the injected sink (or a `LogfireSink` when a token resolves). NEVER
 * throws and NEVER makes a network call here (the first POST is on the first span `end`).
 */
export function createTelemetry(opts: CreateTelemetryOptions): Telemetry {
  const env = opts.env ?? process.env;
  const onError = opts.onError ?? (() => {});
  let gating: TelemetryGating;
  try {
    gating = resolveTelemetryGating(opts.config, env);
  } catch (err) {
    onError(err);
    return NOOP_TELEMETRY;
  }

  if (!gating.enabled) return NOOP_TELEMETRY;

  const sink =
    opts.sink ??
    new LogfireSink({
      token: gating.token,
      serviceName: gating.serviceName,
      ...(opts.onWarn ? { onWarn: opts.onWarn } : {}),
    });

  if (!opts.sink && !gating.token) {
    (opts.onWarn ?? ((m: string) => console.warn(m)))(
      `flightplan telemetry: Logfire forced on but no token in $${gating.tokenEnv} — spans will be dropped.`,
    );
  }

  return new SinkTelemetry({
    sink,
    now: opts.now ?? Date.now,
    ids: opts.ids ?? defaultIdGenerator,
    onError,
  });
}

// ---------------------------------------------------------------------------
// FakeSink (in-memory, for tests)
// ---------------------------------------------------------------------------

/**
 * Records every exported span in memory for assertions. Synchronous, so a span is captured the
 * moment it `end()`s (no awaiting). Helpers select spans/events by name.
 */
export class FakeSink implements TelemetrySink {
  readonly spans: ExportedSpan[] = [];

  export(span: ExportedSpan): void {
    this.spans.push(span);
  }

  /** All spans with the given name. */
  byName(name: string): ExportedSpan[] {
    return this.spans.filter((s) => s.name === name);
  }

  /** The (first) root run span. */
  runSpan(): ExportedSpan | undefined {
    return this.spans.find((s) => s.name === TELEMETRY_SPAN_NAMES.run);
  }

  /** All step spans. */
  stepSpans(): ExportedSpan[] {
    return this.byName(TELEMETRY_SPAN_NAMES.step);
  }

  /** Every event across every captured span. */
  events(): ExportedSpanEvent[] {
    return this.spans.flatMap((s) => s.events);
  }

  /** Every event of a given name across every captured span. */
  eventsByName(name: string): ExportedSpanEvent[] {
    return this.events().filter((e) => e.name === name);
  }

  clear(): void {
    this.spans.length = 0;
  }
}
