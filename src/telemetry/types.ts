// Flightplan — telemetry contracts (PLAN.md §5 Phase 5; P5_DESIGN.md §4 "TELEMETRY").
//
// Optional Logfire spans/events, gated on a resolvable Logfire token. The transport is isolated
// behind `TelemetrySink` (the same seam pattern as the AI `GenerateFn`) so the whole module is
// offline-testable with a `FakeSink` — no network, no token, no SDK dependency.
//
// Span / event model (PROPOSAL 614-624):
//   - Run span (root): attrs flow_id, run_id, verdict (at end), drift_count (at end).
//   - Step spans (child of run): per step; attrs step_id, do, tier, ok, healed, repaired (opt).
//   - Events (on the active step span): browser_action, resolution_attempt, assertion_result,
//     ai_call, artifact_created, lock_read / lock_write / lock_proposed_update.

/** A primitive OTLP attribute value. */
export type AttributeScalar = string | number | boolean;

/**
 * A span/event attribute value. Scalars plus homogeneous string/number arrays (e.g. a
 * resolution attempt's `candidates`). Maps directly onto OTLP `AnyValue` / `ArrayValue`.
 */
export type AttributeValue = AttributeScalar | readonly string[] | readonly number[];

/**
 * A bag of attributes. `undefined` values are tolerated (callers build attrs with optional
 * fields) and are STRIPPED before a span/event is recorded, so an `ExportedSpan` never carries
 * an `undefined` attribute.
 */
export type SpanAttributes = Record<string, AttributeValue | undefined>;

/** A finalized event attached to a span (OTLP span event). */
export interface ExportedSpanEvent {
  name: string;
  /** Stringified nanosecond epoch (OTLP `timeUnixNano`). */
  timeUnixNano: string;
  attributes: Record<string, AttributeValue>;
}

/**
 * A finalized span handed to the sink on `end()`. One `ExportedSpan` == one OTLP span; parent
 * linkage is by `parentSpanId` within a shared `traceId` (the OTLP model — each span exports
 * individually, no nesting in the payload).
 */
export interface ExportedSpan {
  /** 32 lowercase hex chars (16 bytes). */
  traceId: string;
  /** 16 lowercase hex chars (8 bytes). */
  spanId: string;
  /** Absent for the root run span. */
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, AttributeValue>;
  events: ExportedSpanEvent[];
}

/**
 * The transport boundary. The default real sink (`LogfireSink`) POSTs OTLP/HTTP-JSON to Logfire;
 * `FakeSink` records in memory; `NoopSink` discards. `export` MAY return a promise (the runner
 * never awaits it); a thrown error or a rejected promise is observed by the caller and degrades
 * telemetry to a no-op mid-run — it NEVER propagates into the run.
 */
export interface TelemetrySink {
  export(span: ExportedSpan): void | Promise<void>;
}

/**
 * A live, mutable span handle. All methods are best-effort and NEVER throw: a failure is
 * swallowed (and surfaced to the telemetry `onError` observer), never propagated into the run.
 */
export interface SpanHandle {
  /** Set a single attribute (last write wins). */
  setAttribute(key: string, value: AttributeValue): void;
  /** Merge a bag of attributes; `undefined` values are ignored. */
  setAttributes(attrs: SpanAttributes): void;
  /** Record an event on this span at the current clock time. */
  event(name: string, attrs?: SpanAttributes): void;
  /** Open a child span (e.g. a per-step span under the run span). */
  child(name: string, attrs?: SpanAttributes): SpanHandle;
  /** Finalize the span (merging optional end attrs) and hand it to the sink exactly once. */
  end(attrs?: SpanAttributes): void;
}

/** The telemetry facade the runner consumes. `enabled` is false for the no-op telemetry. */
export interface Telemetry {
  readonly enabled: boolean;
  /** Open the root run span. When disabled this returns a zero-overhead no-op span. */
  startRun(attrs?: SpanAttributes): SpanHandle;
}

/** Span names used for the run/step spans (kept stable for downstream querying). */
export const TELEMETRY_SPAN_NAMES = {
  run: "flightplan.run",
  step: "flightplan.step",
} as const;

/**
 * Canonical event names emitted on a span. The runner (Unit E) passes these to `span.event(...)`.
 * Mirrors the artifact streams + the PROPOSAL telemetry event list.
 */
export const TELEMETRY_EVENTS = {
  browserAction: "browser_action",
  resolutionAttempt: "resolution_attempt",
  assertionResult: "assertion_result",
  aiCall: "ai_call",
  artifactCreated: "artifact_created",
  lockRead: "lock_read",
  lockWrite: "lock_write",
  lockProposedUpdate: "lock_proposed_update",
} as const;

/** Generates OTLP-shaped ids. Injectable so tests are deterministic. */
export interface IdGenerator {
  /** 32 lowercase hex chars. */
  traceId(): string;
  /** 16 lowercase hex chars. */
  spanId(): string;
}
