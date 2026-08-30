// Flightplan — redaction (PLAN.md §5 Phase 5; PROPOSAL_v1.md "Secrets and redaction").
//
// A pure, SDK-free, side-effect-free redaction API. It masks two classes of sensitive text BEFORE
// anything is logged to `ai.jsonl`/`trace.jsonl` or handed to a model:
//
//   1. SECRETS — exact values from `secret:true` fills (+ the inputs that back them). These are
//      masked UNCONDITIONALLY whenever present, even if `mask_text` is somehow false: a value
//      marked secret must NEVER appear in any artifact. This is the fail-closed core.
//   2. PII — conservative, low-false-positive patterns (emails, bearer/`sk-` tokens,
//      `Authorization:` headers, long digit runs). PII scrubbing is gated on `mask_text`.
//
// A redactor with neither secrets nor `mask_text` is the IDENTITY function (zero overhead) so
// AI-less / no-secret runs are byte-identical to before redaction existed.
//
// This module is a leaf: it imports only the `Step` flow type. Nothing here imports `ai/`,
// `runner/`, the driver, or the SDK — so it is trivially unit-testable and free of cycles.

import type { Step } from "../flow/types.ts";

/** The replacement token substituted for every redacted span. */
export const REDACTED = "«redacted»";

/**
 * Conservative PII patterns — deliberately low-false-positive so we never blind `ai_judge`
 * reasoning or wreck `explain` readability (PLAN §8 risk R3). Applied ONLY when `mask_text` is on.
 * Order matters: header/email patterns run before the broad digit-run pattern.
 *
 * Each is global-flagged; they are used only via `String.prototype.replace`, which manages
 * `lastIndex` internally, so sharing these module-level objects across calls is safe.
 */
export const DEFAULT_PII_PATTERNS: readonly RegExp[] = [
  // Emails.
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // Authorization headers (whole value to end-of-line).
  /Authorization:\s*[^\n]+/gi,
  // Bearer tokens.
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  // OpenAI / OpenRouter-style API keys (`sk-...`, `sk-or-...`).
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // Long digit runs (OTP / card-ish).
  /\b\d{6,}\b/g,
];

/** Options for {@link createRedactor}. */
export interface RedactorOptions {
  /** Gate for PII-pattern scrubbing (the `[redaction] mask_text` value; default fail-closed `true`). */
  maskText: boolean;
  /** Exact secret values to mask wholesale, everywhere, unconditionally. */
  secrets?: Iterable<string>;
  /** Override the PII patterns (defaults to {@link DEFAULT_PII_PATTERNS}). */
  piiPatterns?: readonly RegExp[];
}

/** A pure redaction policy. When `enabled` is false every method is the identity function. */
export interface Redactor {
  /** True iff this redactor will alter any input (has secrets OR `mask_text` is on). */
  readonly enabled: boolean;
  /** Number of distinct secret values this redactor masks. */
  readonly secretCount: number;
  /** Mask secret substrings (always) + PII patterns (when `mask_text`) in arbitrary text. */
  redactText(s: string): string;
  /** A known-secret value → {@link REDACTED} wholesale; otherwise {@link redactText}. */
  redactValue(v: string): string;
  /** Map a `{ key: value }` input bag through {@link redactValue} (the `run_start.inputs` path). */
  redactInputs(inputs: Record<string, string>): Record<string, string>;
  /** Deep-walk an object/array, redacting every string leaf (the `ai.jsonl` response path). */
  redactJson<T>(value: T): T;
}

/**
 * Build a {@link Redactor} from options. Fail-closed: secret values are masked whenever present,
 * regardless of `maskText`; only PII-pattern scrubbing is gated on `maskText`. With no secrets and
 * `maskText:false` the redactor is the identity function.
 */
export function createRedactor(opts: RedactorOptions): Redactor {
  const maskText = opts.maskText;

  // Dedupe + drop empties, then sort longest-first so overlapping secrets mask the longest match.
  const secretList = [...new Set(opts.secrets ?? [])].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  secretList.sort((a, b) => b.length - a.length);
  const secretSet = new Set(secretList);

  const piiPatterns = maskText ? (opts.piiPatterns ?? DEFAULT_PII_PATTERNS) : [];
  const enabled = maskText || secretList.length > 0;

  function redactText(s: string): string {
    if (!enabled || typeof s !== "string" || s.length === 0) return s;
    let out = s;
    // (1) Secrets first — literal substring replacement (no regex escaping concerns).
    for (const secret of secretList) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    // (2) PII patterns (gated on maskText — empty list otherwise).
    for (const pat of piiPatterns) {
      out = out.replace(pat, REDACTED);
    }
    return out;
  }

  function redactValue(v: string): string {
    if (!enabled || typeof v !== "string") return v;
    if (secretSet.has(v)) return REDACTED;
    return redactText(v);
  }

  function redactInputs(inputs: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(inputs)) {
      out[k] = redactValue(v);
    }
    return out;
  }

  function walk(value: unknown): unknown {
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  }

  function redactJson<T>(value: T): T {
    if (!enabled) return value;
    return walk(value) as T;
  }

  return {
    enabled,
    secretCount: secretList.length,
    redactText,
    redactValue,
    redactInputs,
    redactJson,
  };
}

/**
 * Collect every secret value to mask for a run: for EACH `secret:true` step, its (post-templating)
 * templated payload — the `value` a `fill`/`select` types, or the `url` a `goto` navigates — PLUS
 * any input value that BACKS such a secret (i.e. appears inside a secret payload), so
 * `${inputs.TOKEN}` is masked even where the bare literal appears elsewhere. Generalizes the
 * runner's prior `redactSecretInputs`.
 *
 * Previously this scanned ONLY `fill` steps, so a `secret:true` value used in a `select` or embedded
 * in a `goto` URL leaked into artifacts (run.jsonl / ai.jsonl / trace) in cleartext (B7). It now
 * honors `secret:true` on any step verb carrying a templated `value`/`url`.
 *
 * Call this AFTER templating so `step.value` / `step.url` is the resolved literal.
 */
/** Collect every non-empty string leaf of `value` (recursing into objects/arrays) into `out`. */
function collectStringLeaves(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (value.length > 0) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStringLeaves(v, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectStringLeaves(v, out);
  }
}

export function gatherSecretValues(
  steps: readonly Step[],
  inputs: Record<string, string> = {},
): Set<string> {
  const secrets = new Set<string>();
  for (const step of steps) {
    // `secret` is declared on the fill step in the schema, but honor it on ANY verb that carries a
    // templated payload (fill/select `value`, goto `url`, emit `payload`) so a secret used outside
    // `fill` is masked.
    if ((step as { secret?: unknown }).secret !== true) continue;
    if (step.do === "emit") {
      // emit's `payload` is a string OR an inline table; gather every string leaf of a table
      // payload too, so a secret nested inside a JSON-serializable table is masked wholesale.
      collectStringLeaves(step.payload, secrets);
      continue;
    }
    if (step.do === "eval") {
      // eval's `args` carries the structured per-run values (never string-interpolated into
      // `script`); gather every string leaf so a secret passed through `args` is masked wholesale
      // wherever it might surface (script echoes, the eval result, trace/browser-action text).
      collectStringLeaves(step.args, secrets);
      continue;
    }
    if (step.do === "evaluate") {
      // evaluate has no `args` — the (post-templating) `expression` string itself carries the
      // secret value, so gather it wholesale (mirrors the eval branch above).
      collectStringLeaves(step.expression, secrets);
      continue;
    }
    if (step.do === "webmcp_call") {
      // WebMCP input may contain credentials or personal data at arbitrary nesting depth.
      collectStringLeaves(step.input, secrets);
      continue;
    }
    const payload =
      "value" in step && typeof step.value === "string"
        ? step.value
        : "url" in step && typeof step.url === "string"
          ? step.url
          : undefined;
    if (typeof payload === "string" && payload.length > 0) secrets.add(payload);
  }
  if (secrets.size > 0) {
    // Snapshot the fill-derived secrets before mutating the set during the scan.
    const fillSecrets = [...secrets];
    for (const v of Object.values(inputs)) {
      if (typeof v !== "string" || v.length === 0) continue;
      if (fillSecrets.some((s) => s.includes(v))) secrets.add(v);
    }
  }
  return secrets;
}
