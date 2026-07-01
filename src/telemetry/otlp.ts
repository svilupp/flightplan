// Flightplan — minimal OTLP/HTTP-JSON transport for Logfire (P5_DESIGN.md Risk T1).
//
// A tiny hand-rolled OTLP-JSON serializer + a `fetch`-based POST to Logfire's OTLP traces
// endpoint. No `@opentelemetry/*` dependency (zero-dep, swappable later). The sink NEVER throws
// into the run: `export` returns the fetch promise and the caller (LiveSpan) observes any
// rejection and degrades to a no-op. A non-2xx response rejects so the caller can degrade.

import type {
  AttributeValue,
  ExportedSpan,
  SpanAttributes,
  TelemetrySink,
} from "./types.ts";

/** Logfire's OTLP base endpoint (traces path appended). PROPOSAL §Logfire (610-626). */
export const DEFAULT_LOGFIRE_ENDPOINT = "https://logfire-api.pydantic.dev";
const OTLP_TRACES_PATH = "/v1/traces";
/** OTLP SPAN_KIND_INTERNAL. */
const SPAN_KIND_INTERNAL = 1;

/** Convert one attribute value to an OTLP `AnyValue`. */
function toAnyValue(value: AttributeValue): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    // OTLP int64 is JSON-encoded as a string; non-integers use doubleValue.
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  // readonly string[] | readonly number[]
  return { arrayValue: { values: value.map((v) => toAnyValue(v)) } };
}

/** Convert an attribute bag to an OTLP `KeyValue[]`, skipping `undefined` values. */
export function toKeyValues(
  attrs: Record<string, AttributeValue> | SpanAttributes,
): Array<{ key: string; value: Record<string, unknown> }> {
  const out: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    out.push({ key, value: toAnyValue(value) });
  }
  return out;
}

/** Build the OTLP `ExportTraceServiceRequest` JSON payload for a single span. */
export function toOtlpPayload(span: ExportedSpan, serviceName: string): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: toKeyValues({ "service.name": serviceName }) },
        scopeSpans: [
          {
            scope: { name: "flightplan" },
            spans: [
              {
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                kind: SPAN_KIND_INTERNAL,
                startTimeUnixNano: span.startTimeUnixNano,
                endTimeUnixNano: span.endTimeUnixNano,
                attributes: toKeyValues(span.attributes),
                events: span.events.map((e) => ({
                  name: e.name,
                  timeUnixNano: e.timeUnixNano,
                  attributes: toKeyValues(e.attributes),
                })),
              },
            ],
          },
        ],
      },
    ],
  };
}

export interface LogfireSinkOptions {
  /** The resolved Logfire token. When absent the sink no-ops (warns once) — no network call. */
  token?: string;
  serviceName?: string;
  /** Override the OTLP base endpoint (tests). */
  endpoint?: string;
  /** Inject a fetch implementation (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Observe a one-time "no token" warning (tests). Defaults to `console.warn`. */
  onWarn?: (message: string) => void;
}

/**
 * The default real sink: POSTs one OTLP span per `export` to Logfire. Construction is cheap and
 * NEVER makes a network call; the first POST happens on the first `export`. A non-2xx response
 * rejects the returned promise so the caller can degrade telemetry to a no-op.
 */
export class LogfireSink implements TelemetrySink {
  readonly #token: string | undefined;
  readonly #serviceName: string;
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #onWarn: (message: string) => void;
  #warnedNoToken = false;

  constructor(opts: LogfireSinkOptions = {}) {
    this.#token = opts.token?.trim() || undefined;
    this.#serviceName = opts.serviceName ?? "flightplan";
    const base = (opts.endpoint ?? DEFAULT_LOGFIRE_ENDPOINT).replace(/\/+$/, "");
    this.#url = base + OTLP_TRACES_PATH;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#onWarn = opts.onWarn ?? ((m) => console.warn(m));
  }

  export(span: ExportedSpan): Promise<void> {
    if (!this.#token) {
      if (!this.#warnedNoToken) {
        this.#warnedNoToken = true;
        this.#onWarn("flightplan telemetry: Logfire enabled but no token resolved — spans dropped.");
      }
      return Promise.resolve();
    }
    const payload = toOtlpPayload(span, this.#serviceName);
    return this.#fetch(this.#url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#token}`,
      },
      body: JSON.stringify(payload),
    }).then((res) => {
      if (!res.ok) throw new Error(`logfire OTLP export failed: HTTP ${res.status}`);
    });
  }
}
