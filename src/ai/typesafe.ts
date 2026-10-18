// SDK-shaped, worker-portable TypeSafe wire boundary. No browser actions belong here.
import { claimJevReservation, type JevRequestReservation } from "./budget.ts";
import { JEV_RESPONSE_ROUNDING_TOLERANCE } from "./jev-policy.ts";

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, unknown> }
  | { type: "noul"; instructions: string }
  | { type: "box"; instructions: string };
export interface JevImageAsset {
  type: "image";
  format: "png" | "jpg" | "jpeg";
  data_base64: string;
}
export interface JevRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
  assets?: Record<string, JevImageAsset>;
}
export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number | null;
  probabilities: Record<string, number>;
}
export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}
export interface JevBoxAnswer {
  type: "box";
  box: { top: number; bottom: number; left: number; right: number };
  confidence: number | null;
}
export interface JevResponse {
  model: string;
  answers: Record<string, JevChoiceAnswer | JevNoulAnswer | JevBoxAnswer>;
  usage: { input_tokens: number | null; output_tokens: number | null };
}
export class JevProtocolError extends Error {
  constructor() {
    super("jev_result_invalid");
    this.name = "JevProtocolError";
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function counter(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
function sameKeys(a: object, b: object): boolean {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => Object.hasOwn(b, k));
}
/** Application limits intentionally below upstream's 32 MiB and 16 MiB/image ceilings. */
export const JEV_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const JEV_MAX_IMAGE_ASSETS = 4;

function imageDimensions(asset: JevImageAsset): { width: number; height: number } {
  const invalid = (): never => {
    throw new JevProtocolError();
  };
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data_base64) ||
    !asset.data_base64 ||
    asset.data_base64.length > JEV_MAX_BODY_BYTES
  )
    return invalid();
  let data: string;
  try {
    data = atob(asset.data_base64);
  } catch {
    return invalid();
  }
  if (btoa(data) !== asset.data_base64) return invalid();
  const u16 = (i: number) => data.charCodeAt(i) * 256 + data.charCodeAt(i + 1);
  const u32 = (i: number) => u16(i) * 65536 + u16(i + 2);
  let width = 0,
    height = 0;
  if (asset.format === "png") {
    if (data.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || data.slice(12, 16) !== "IHDR" || u32(8) !== 13)
      return invalid();
    width = u32(16);
    height = u32(20);
    let imageData = false,
      ended = false;
    for (let i = 8; i < data.length; ) {
      if (i + 12 > data.length) return invalid();
      const size = u32(i),
        kind = data.slice(i + 4, i + 8);
      if (size > data.length - i - 12 || kind === "acTL") return invalid();
      if (kind === "IDAT") imageData = true;
      i += size + 12;
      if (kind === "IEND") {
        ended = size === 0 && i === data.length;
        break;
      }
    }
    if (!imageData || !ended) return invalid();
  } else {
    if (u16(0) !== 0xffd8 || u16(data.length - 2) !== 0xffd9) return invalid();
    for (let i = 2; i + 4 < data.length; ) {
      if (data.charCodeAt(i) !== 255) return invalid();
      const marker = data.charCodeAt(i + 1),
        size = u16(i + 2);
      if (size < 2 || i + size + 2 > data.length) return invalid();
      // Reject EXIF: orientation must be normalized by the capture/preprocessing adapter.
      if (marker === 0xe1) return invalid();
      if (marker === 0xc0) {
        if (size < 8 || data.charCodeAt(i + 4) !== 8) return invalid();
        height = u16(i + 5);
        width = u16(i + 7);
      }
      if (marker === 0xda) break;
      i += size + 2;
    }
  }
  if (
    ![width, height].every((n) => Number.isInteger(n) && n >= 280 && n <= 1568) ||
    width * height > 2458624
  )
    return invalid();
  return { width, height };
}

/** Validate supported SDK-shaped JSON and encoded image bounds before transmission. */
export function validateJevRequest(raw: unknown): JevRequest {
  const invalid = (): never => {
    throw new JevProtocolError();
  };
  if (
    !record(raw) ||
    !Object.keys(raw).every((k) => ["model", "state", "questions", "assets"].includes(k)) ||
    typeof raw.model !== "string" ||
    !raw.model ||
    !record(raw.state) ||
    !record(raw.questions) ||
    !Object.keys(raw.questions).length
  )
    return invalid();
  for (const question of Object.values(raw.questions)) {
    if (
      !record(question) ||
      typeof question.instructions !== "string" ||
      !question.instructions.trim()
    )
      return invalid();
    if (question.type === "choice") {
      if (
        !sameKeys(question, { type: 0, instructions: 0, criteria: 0 }) ||
        !record(question.criteria) ||
        Object.keys(question.criteria).length < 2 ||
        Object.keys(question.criteria).length > 255
      )
        return invalid();
    } else if (
      !["noul", "box"].includes(String(question.type)) ||
      !sameKeys(question, { type: 0, instructions: 0 })
    )
      return invalid();
  }
  const strings: string[] = [];
  const seen = new Set<object>();
  function json(value: unknown, depth = 0): void {
    if (depth > 64) invalid();
    if (typeof value === "string") {
      strings.push(value);
      return;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return;
    if (typeof value !== "object" || seen.has(value)) throw new JevProtocolError();
    seen.add(value);
    for (const child of Object.values(value)) json(child, depth + 1);
    seen.delete(value);
  }
  json(raw.state);
  json(raw.questions);
  const assets = raw.assets ?? {};
  if (!record(assets) || Object.keys(assets).length > JEV_MAX_IMAGE_ASSETS) return invalid();
  let expandedBytes = 0,
    referenceBytes = 0;
  const encoder = new TextEncoder();
  for (const [reference, asset] of Object.entries(assets)) {
    const refBytes = encoder.encode(reference).byteLength;
    referenceBytes += refBytes;
    if (
      !refBytes ||
      refBytes > 1024 ||
      referenceBytes > 65536 ||
      !record(asset) ||
      !sameKeys(asset, { type: 0, format: 0, data_base64: 0 }) ||
      asset.type !== "image" ||
      !["png", "jpg", "jpeg"].includes(String(asset.format)) ||
      typeof asset.data_base64 !== "string"
    )
      return invalid();
    imageDimensions(asset as unknown as JevImageAsset);
    const uses = strings.reduce((sum, text) => sum + text.split(reference).length - 1, 0);
    if (!uses) return invalid();
    // Bound expanded references conservatively at the encoded rather than decoded size.
    expandedBytes += uses * asset.data_base64.length;
    if (expandedBytes > JEV_MAX_BODY_BYTES) return invalid();
  }
  if (
    Object.values(raw.questions).some((q) => (q as JevQuestion).type === "box") &&
    (!Object.keys(assets).length || raw.model !== "jev-1.14.0")
  )
    return invalid();
  if (encoder.encode(JSON.stringify(raw)).byteLength > JEV_MAX_BODY_BYTES) return invalid();
  return raw as unknown as JevRequest;
}

/** Shared wire primitive. Legacy callers retain their own retry and response compatibility. */
export async function postJevRequest(
  fetchFn: typeof fetch,
  apiKey: string,
  request: JevRequest,
  signal: AbortSignal,
  onTransmit?: (bytes: number) => void,
): Promise<{ status: number; json: unknown }> {
  validateJevRequest(request);
  const body = JSON.stringify(request);
  onTransmit?.(new TextEncoder().encode(body).byteLength);
  const response = await fetchFn("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    signal,
    body,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(Object.keys(request.assets ?? {}).length
        ? { "TypeSafe-Danger-Zone-Images": "true" }
        : {}),
    },
  });
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

/** Strict requested-answer validation; semantic low confidence remains a valid answer. */
export function validateJevResponse(raw: unknown, request: JevRequest): JevResponse {
  const invalid = (): never => {
    throw new JevProtocolError();
  };
  if (
    !record(raw) ||
    typeof raw.model !== "string" ||
    !raw.model ||
    !record(raw.answers) ||
    !record(raw.usage)
  )
    return invalid();
  if (
    !counter(raw.usage.input_tokens) ||
    !counter(raw.usage.output_tokens) ||
    !sameKeys(raw.answers, request.questions)
  )
    return invalid();
  if (/^jev-\d+\.\d+\.\d+$/.test(request.model) && raw.model !== request.model) return invalid();
  for (const [key, question] of Object.entries(request.questions)) {
    const answer = raw.answers[key];
    if (!record(answer) || answer.type !== question.type) return invalid();
    if (question.type === "noul") {
      if (!probability(answer.noul)) return invalid();
      continue;
    }
    if (answer.confidence !== null && !probability(answer.confidence)) return invalid();
    if (question.type === "box") {
      const b = answer.box;
      if (
        !record(b) ||
        !probability(b.top) ||
        !probability(b.bottom) ||
        !probability(b.left) ||
        !probability(b.right) ||
        b.top >= b.bottom ||
        b.left >= b.right
      )
        return invalid();
      continue;
    }
    if (
      typeof answer.choice !== "string" ||
      !Object.hasOwn(question.criteria, answer.choice) ||
      !record(answer.probabilities) ||
      !sameKeys(answer.probabilities, question.criteria)
    )
      return invalid();
    const values = Object.values(answer.probabilities);
    if (!values.every(probability)) return invalid();
    if (Math.abs(values.reduce((sum, n) => sum + n, 0) - 1) > JEV_RESPONSE_ROUNDING_TOLERANCE)
      return invalid();
    const selected = answer.probabilities[answer.choice] as number;
    if (selected + JEV_RESPONSE_ROUNDING_TOLERANCE < Math.max(...values)) return invalid();
  }
  const checked = raw as unknown as JevResponse;
  // Provider bodies can echo submitted data in extra fields. Return only the validated contract.
  return {
    model: checked.model,
    usage: { input_tokens: checked.usage.input_tokens, output_tokens: checked.usage.output_tokens },
    answers: Object.fromEntries(
      Object.entries(checked.answers).map(([key, answer]) => {
        if (answer.type === "noul") return [key, { type: "noul", noul: answer.noul }];
        if (answer.type === "box")
          return [
            key,
            {
              type: "box",
              confidence: answer.confidence,
              box: {
                top: answer.box.top,
                bottom: answer.box.bottom,
                left: answer.box.left,
                right: answer.box.right,
              },
            },
          ];
        return [
          key,
          {
            type: "choice",
            choice: answer.choice,
            confidence: answer.confidence,
            probabilities: Object.fromEntries(Object.entries(answer.probabilities)),
          },
        ];
      }),
    ),
  };
}

/** Never traverse image-bearing state for diagnostics: arbitrary references can contain pixels. */
export function safeJevRequest(request: JevRequest): Record<string, unknown> {
  return {
    model: request.model,
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([key, q]) => [key, { type: q.type }]),
    ),
    assets: Object.values(request.assets ?? {}).map((a) => ({
      type: "image",
      format: a.format,
      bytes: Math.floor((a.data_base64.length * 3) / 4),
    })),
    state: "[evidence omitted]",
  };
}

export interface JevTransport {
  evaluate(
    request: JevRequest,
    context: { purpose: string; signal?: AbortSignal; reservation: JevRequestReservation },
  ): Promise<JevResponse>;
}
export class FetchJevTransport implements JevTransport {
  constructor(
    private readonly options: {
      apiKey: string;
      fetchFn?: typeof fetch;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ) {}
  async evaluate(
    request: JevRequest,
    context: { purpose: string; signal?: AbortSignal; reservation: JevRequestReservation },
  ): Promise<JevResponse> {
    const reservation = context.reservation;
    claimJevReservation(reservation);
    try {
      const signals = [
        reservation.signal,
        context.signal,
        this.options.signal,
        AbortSignal.timeout(this.options.timeoutMs ?? 3000),
      ].filter((s): s is AbortSignal => s !== undefined);
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      const res = await postJevRequest(
        this.options.fetchFn ?? globalThis.fetch,
        this.options.apiKey,
        request,
        signal,
        (bytes) => reservation.recordBytes?.(bytes),
      );
      if (res.status !== 200) throw new Error(`jev_http_${res.status}`);
      const response = validateJevResponse(res.json, request);
      reservation.settle(response.usage.input_tokens, response.model);
      return response;
    } catch (err) {
      reservation.fail();
      if (err instanceof JevProtocolError) throw err;
      if (context.signal?.aborted || this.options.signal?.aborted) throw new Error("jev_cancelled");
      if (reservation.signal.aborted) throw new Error("jev_timeout");
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
        throw new Error("jev_timeout");
      throw new Error("jev_request_failed");
    }
  }
}
