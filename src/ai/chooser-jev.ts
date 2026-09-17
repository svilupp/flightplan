// Flightplan — `JevChooser`: the TypeSafe "JEV" System One Choice classifier as a
// `CandidateChooser`. Plain injected `fetch` — no AI SDK, no `node:` imports, so
// this file stays worker-portable by construction (fitness: `src/fitness/worker-portability.test.ts`).
//
// One JEV call == one `budget.noteModelCall()` unit == one `ai_call` event (`role: "classifier"`)
// == one `CostAccumulator.add("resolver", ...)` row (JEV spend is attributed to the `resolver`
// model role, same convention as a `judge` call routing to its underlying model role).

import type { BudgetTracker } from "./budget.ts";
import { isBudgetExceeded } from "./budget.ts";
import type { CandidateChooser, ChooseContext, ChooseResult } from "./chooser.ts";
import type { CostAccumulator } from "./cost.ts";
import type { CandidatePacketEntry } from "./resolve-common.ts";
import type { AiCallSink } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants (all in one reviewable block)
// ---------------------------------------------------------------------------

export const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_NONE_KEY = "none_of_the_above";
/** Act only at/above this confidence (experiments: correct picks 0.95–1.0; forced guess 0.35). */
export const JEV_MIN_CONFIDENCE = 0.6;
/** Abstain when the top-two probability gap is below this (near-tied duplicates → ambiguous UI). */
export const JEV_MIN_PROB_GAP = 0.2;
/** Fetch timeout — steady state is 200–500 ms; cold start ~600 ms. */
export const JEV_TIMEOUT_MS = 3_000;
/** One retry on network error / 5xx only; never on 4xx. */
export const JEV_MAX_RETRIES = 1;
export const JEV_RETRY_DELAY_MS = 250;
/** 255 options is a hard server cap; reserve one for `none_of_the_above` and keep headroom. */
export const JEV_MAX_CANDIDATES = 200;
/** The candidate-option encoding sent to JEV. `"structured"` is the phase-1 default (§4/§7.6). */
export type JevOptionEncoding = "structured" | "flat";
export const JEV_OPTION_ENCODING: JevOptionEncoding = "structured";
/**
 * The `pick` question's `instructions` (§4/§7.6, B1 live comparison). Live data (structured
 * encoding, 20-candidate login set, 7 intents × 3 reps): the ORIGINAL bare instructions scored
 * 20/21 with one flaky near-threshold abstain on an action-describing intent ("submit the form"
 * → c10/c10/none_of_the_above, confidence 0.50/0.48/0.55 — straddling `JEV_MIN_CONFIDENCE`); the
 * FLAT encoding scored WORSE on the same case (18/21, 0/3 on "submit the form"). Telling the
 * model the intent may describe PURPOSE rather than a literal label — and naming "submit the
 * form" as the running example — made that exact case robust (3/3, confidence 0.93–0.95, top-two
 * probability gap ~0.9) with the SAME structured encoding: 21/21 across all 7 intents × 3 reps.
 * `JEV_OPTION_ENCODING` therefore stays `"structured"`; only the instructions text changed.
 */
export const JEV_PICK_INSTRUCTIONS =
  "Which UI element does the user intent in state.intent refer to? The intent may describe the " +
  'element\'s purpose or action rather than its literal label (e.g. "submit the form" means the ' +
  'primary submit/confirm button for the current form, usually a "Sign in"/"Continue"/"Submit" ' +
  "button, not a generic link). Consider state.action.";

// ---------------------------------------------------------------------------
// Request/response types (SDK-free — no `zod` needed, this is our own wire contract)
// ---------------------------------------------------------------------------

export interface JevCriterionValue {
  role: string;
  name: string;
  context?: string;
}

export interface SystemOneChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, JevCriterionValue | string>;
}

export interface SystemOneRequest {
  model: string;
  state: { intent: string; action: string; note?: string };
  questions: { pick: SystemOneChoiceQuestion };
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface SystemOneResponse {
  model: string;
  answers: { pick: ChoiceAnswer };
  usage: { input_tokens: number; output_tokens: number };
}

// ---------------------------------------------------------------------------
// Request encoding
// ---------------------------------------------------------------------------

function optionKey(index: number): string {
  return `c${index}`;
}

function parseOptionKey(key: string): number | undefined {
  const m = /^c(\d+)$/.exec(key);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** The (role,name,context) identity key two candidates are indistinguishable to JEV under. */
function dedupeKey(c: CandidatePacketEntry): string {
  return `${c.role}\u0000${c.name}\u0000${c.context ?? ""}`;
}

/**
 * Group candidates by identical `(role,name,context)` and keep only the FIRST (highest-scored,
 * since the packet arrives best-first) representative per group (B3). Two entries JEV cannot
 * distinguish (identical role/name/context — the only signals it ever sees) split probability
 * mass across duplicate options instead of concentrating it on one, which can push a genuinely
 * confident pick under `JEV_MIN_CONFIDENCE`/`JEV_MIN_PROB_GAP` and cause a false abstain. This is
 * a defense-in-depth on top of `buildCandidatePacket`'s `ref`-based dedup (`resolve-common.ts`) —
 * it also catches `ref`-less duplicates (synthetic candidates, direct `resolveL2` callers/tests)
 * that dedup never sees. The representative's `index` is one of the ORIGINAL candidate indices,
 * so `ranked[index]` (the `actOnPick` lookup contract) resolves exactly as before.
 */
export function dedupeCandidatesForJev(candidates: CandidatePacketEntry[]): CandidatePacketEntry[] {
  const seen = new Set<string>();
  const deduped: CandidatePacketEntry[] = [];
  for (const c of candidates) {
    const key = dedupeKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return deduped;
}

function criterionValue(c: CandidatePacketEntry): JevCriterionValue | string {
  if (JEV_OPTION_ENCODING === "flat") {
    return c.context ? `${c.role} '${c.name}' (${c.context})` : `${c.role} '${c.name}'`;
  }
  return c.context
    ? { role: c.role, name: c.name, context: c.context }
    : { role: c.role, name: c.name };
}

/** Build the exact `SystemOneRequest` body for one L2 choice question (§4). */
export function buildSystemOneRequest(
  intent: string,
  action: string,
  candidates: CandidatePacketEntry[],
  note: string | undefined,
): SystemOneRequest {
  // Defensive truncation to the top JEV_MAX_CANDIDATES by score (the packet is already ≤8 in
  // phase 1, so this only matters for a future wide-gather mode — kept here per §4 "Limits").
  const truncated =
    candidates.length > JEV_MAX_CANDIDATES
      ? [...candidates].sort((a, b) => b.score - a.score).slice(0, JEV_MAX_CANDIDATES)
      : candidates;

  const criteria: Record<string, JevCriterionValue | string> = {};
  for (const c of truncated) {
    criteria[optionKey(c.index)] = criterionValue(c);
  }
  criteria[JEV_NONE_KEY] = "No listed element matches the intent";

  return {
    model: JEV_MODEL,
    state: { intent, action, ...(note ? { note } : {}) },
    questions: {
      pick: {
        type: "choice",
        instructions: JEV_PICK_INSTRUCTIONS,
        criteria,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The fetch call (budget + event + cost accounting), mirroring `aiCall`'s step order
// ---------------------------------------------------------------------------

export interface JevCallRuntime {
  budget: BudgetTracker;
  cost: CostAccumulator;
  aiWriter: AiCallSink;
  onAiCall?: (event: {
    role: "classifier";
    model: string;
    purpose: string;
    inputTokens: number;
    outputTokens: number;
    cost_usd: number;
    outcome: string;
    redactedPrompt?: string;
    redactedResponse?: string;
  }) => void;
  redactor?: { enabled: boolean; redactText(s: string): string };
  /** Injected fetch (test seam) — defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
  /** The env var holding the TypeSafe API key value (never logged). */
  apiKey: string;
  /** Runtime-level abort signal (D5) — combined per attempt with that attempt's fetch timeout. */
  signal?: AbortSignal;
}

export interface JevCallResult {
  response: SystemOneResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Type-guard the shape `JevChooser`/`jevCall` depend on (§4 decision rule). */
function isValidChoiceAnswer(a: unknown): a is ChoiceAnswer {
  if (!a || typeof a !== "object") return false;
  const r = a as Record<string, unknown>;
  return (
    typeof r.choice === "string" &&
    typeof r.confidence === "number" &&
    Number.isFinite(r.confidence) &&
    !!r.probabilities &&
    typeof r.probabilities === "object" &&
    !Array.isArray(r.probabilities)
  );
}

/**
 * Validate a parsed 200 response body against the `SystemOneResponse` shape (§4). A non-object
 * body (e.g. a non-JSON response, or valid JSON that isn't an object — `null`, a string, an
 * array), a missing `model`, a missing `answers.pick`, or a `pick` answer missing/mistyped
 * `choice`/`confidence`/`probabilities` are all rejected here so a malformed 200 can NEVER throw
 * an uncaught TypeError deeper in `JevChooser.choose` (D2: a malformed response must degrade to
 * `{ kind: "error" }`, never crash the whole run).
 */
function isValidSystemOneResponse(json: unknown): json is SystemOneResponse {
  if (!json || typeof json !== "object") return false;
  const r = json as Record<string, unknown>;
  if (typeof r.model !== "string") return false;
  const answers = r.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;
  return isValidChoiceAnswer((answers as Record<string, unknown>).pick);
}

async function doFetch(
  fetchFn: typeof fetch,
  apiKey: string,
  body: SystemOneRequest,
  signal: AbortSignal,
): Promise<{ status: number; json: unknown }> {
  const res = await fetchFn(JEV_API_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

/**
 * One JEV `POST /v1/systemone` call: budget pre-check → fetch (with one retry on network error /
 * 5xx, never on 4xx) → event emit → cost add. Throws only `BudgetExceededError` (propagates,
 * matching `aiCall`'s contract) or a plain error on total request failure — the CALLER
 * (`JevChooser.choose`) is responsible for turning any thrown/failure state into `{ kind: "error" }`
 * so a JEV outage can never fail a step on its own.
 */
export async function jevCall(
  rt: JevCallRuntime,
  purpose: string,
  body: SystemOneRequest,
  signal?: AbortSignal,
): Promise<JevCallResult> {
  // (1) Pre-check + count the model call — one JEV call == one budget unit.
  rt.budget.noteModelCall();

  const fetchFn = rt.fetchFn ?? globalThis.fetch;
  // D5: the runtime-level abort signal is combined with the per-call `signal` (both external to
  // any one fetch attempt) so either can cancel every attempt, not just the first.
  const externalSignal: AbortSignal | undefined =
    rt.signal && signal ? AbortSignal.any([rt.signal, signal]) : (rt.signal ?? signal);

  let attempt = 0;
  let lastErr: unknown;
  let statusJson: { status: number; json: unknown } | undefined;
  while (attempt <= JEV_MAX_RETRIES) {
    // D4: a FRESH per-attempt fetch timeout — a slow/timed-out first attempt must not also start
    // its retry already expired (a single shared `AbortSignal.timeout` covering every attempt).
    const timeoutSignal = AbortSignal.timeout(JEV_TIMEOUT_MS);
    const attemptSignal = externalSignal
      ? AbortSignal.any([timeoutSignal, externalSignal])
      : timeoutSignal;
    try {
      statusJson = await doFetch(fetchFn, rt.apiKey, body, attemptSignal);
      // Retry only on 5xx; never on 4xx; never when the EXTERNAL signal (not the per-attempt
      // timeout) already fired — a caller cancellation must not spend another attempt (D4).
      if (statusJson.status >= 500 && attempt < JEV_MAX_RETRIES && !externalSignal?.aborted) {
        attempt += 1;
        await sleep(JEV_RETRY_DELAY_MS);
        continue;
      }
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < JEV_MAX_RETRIES && !externalSignal?.aborted) {
        attempt += 1;
        await sleep(JEV_RETRY_DELAY_MS);
        continue;
      }
      break;
    }
  }

  if (!statusJson) {
    const outcome = "error";
    const payload = {
      role: "classifier" as const,
      model: JEV_MODEL,
      purpose,
      inputTokens: 0,
      outputTokens: 0,
      cost_usd: 0,
      outcome,
    };
    await rt.aiWriter.emitAiCall(payload);
    notifyJevCall(rt, payload);
    throw lastErr instanceof Error ? lastErr : new Error("jev: network error");
  }

  if (statusJson.status !== 200) {
    const outcome = "error";
    const detail =
      statusJson.json && typeof statusJson.json === "object" && "detail" in statusJson.json
        ? String((statusJson.json as { detail?: unknown }).detail)
        : `HTTP ${statusJson.status}`;
    const payload = {
      role: "classifier" as const,
      model: JEV_MODEL,
      purpose,
      inputTokens: 0,
      outputTokens: 0,
      cost_usd: 0,
      outcome,
    };
    await rt.aiWriter.emitAiCall(payload);
    notifyJevCall(rt, payload);
    throw new Error(`jev: ${detail}`);
  }

  // A 200 with an unparseable/malformed body (non-JSON response, JSON that isn't an object, a
  // missing/mistyped `answers.pick`) must degrade to an error result, NEVER throw an uncaught
  // TypeError deeper in `JevChooser.choose` (D2). The event is still emitted — the call happened.
  if (!isValidSystemOneResponse(statusJson.json)) {
    const outcome = "error";
    const payload = {
      role: "classifier" as const,
      model: JEV_MODEL,
      purpose,
      inputTokens: 0,
      outputTokens: 0,
      cost_usd: 0,
      outcome,
    };
    await rt.aiWriter.emitAiCall(payload);
    notifyJevCall(rt, payload);
    throw new Error("jev: malformed response body");
  }

  const response = statusJson.json;
  const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 };
  // cost_usd: 0 — JEV pricing is unpublished (§8 open question); tokens are still recorded.
  rt.cost.add("resolver", response.model, {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cost_usd: 0,
  });

  const outcome = classifyOutcome(response.answers.pick);
  const payload = {
    role: "classifier" as const,
    model: response.model,
    purpose,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cost_usd: 0,
    outcome,
    ...redactedFields(rt.redactor, body, response),
  };
  await rt.aiWriter.emitAiCall(payload);
  notifyJevCall(rt, payload);

  return { response };
}

function classifyOutcome(answer: ChoiceAnswer | undefined): string {
  if (!answer) return "error";
  if (answer.choice === JEV_NONE_KEY) return "abstain";
  return "ok";
}

function notifyJevCall(
  rt: JevCallRuntime,
  payload: Parameters<NonNullable<JevCallRuntime["onAiCall"]>>[0],
): void {
  if (!rt.onAiCall) return;
  try {
    rt.onAiCall(payload);
  } catch {
    /* an observer error must never propagate into the run */
  }
}

function redactedFields(
  redactor: JevCallRuntime["redactor"],
  request: SystemOneRequest,
  response: SystemOneResponse,
): { redactedPrompt?: string; redactedResponse?: string } {
  if (!redactor?.enabled) return {};
  return {
    redactedPrompt: redactor.redactText(JSON.stringify(request)),
    // The full probability distribution is logged for threshold calibration + flaky-selector debugging.
    redactedResponse: redactor.redactText(JSON.stringify(response.answers.pick)),
  };
}

// ---------------------------------------------------------------------------
// The chooser
// ---------------------------------------------------------------------------

export class JevChooser implements CandidateChooser {
  readonly kind = "jev" as const;

  constructor(private readonly rt: JevCallRuntime) {}

  async choose(
    intent: string,
    candidates: CandidatePacketEntry[],
    ctx: ChooseContext,
  ): Promise<ChooseResult> {
    // D6: an empty packet abstains LOCALLY — no candidate could ever be chosen, so there's
    // nothing for JEV to reason about. Never spend a JEV call (budget/network/event) on it.
    if (candidates.length === 0) {
      return { kind: "abstain", reason: "jev: no candidates" };
    }

    // B3: collapse indistinguishable duplicate options BEFORE building the request — send JEV
    // one option per distinct (role,name,context) group instead of splitting its probability
    // mass across identical-looking decoys.
    const deduped = dedupeCandidatesForJev(candidates);
    const body = buildSystemOneRequest(intent, ctx.action, deduped, ctx.note);
    let result: JevCallResult;
    try {
      result = await jevCall(this.rt, `resolve:${ctx.step.id}`, body, ctx.signal);
    } catch (err) {
      if (isBudgetExceeded(err)) throw err;
      return { kind: "error", reason: `jev: ${err instanceof Error ? err.message : String(err)}` };
    }

    const answer = result.response.answers.pick;

    if (answer.choice === JEV_NONE_KEY) {
      return { kind: "abstain", reason: "jev: none_of_the_above" };
    }

    if (answer.confidence < JEV_MIN_CONFIDENCE) {
      return { kind: "abstain", reason: `jev: confidence ${answer.confidence} below threshold` };
    }

    const sorted = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
    const top = sorted[0];
    const second = sorted[1];
    if (top && second && top[1] - second[1] < JEV_MIN_PROB_GAP) {
      return {
        kind: "abstain",
        reason: `jev: near-tied top-two probabilities (${top[0]}=${top[1]}, ${second[0]}=${second[1]})`,
      };
    }

    const index = parseOptionKey(answer.choice);
    if (index === undefined || !candidates.some((c) => c.index === index)) {
      return { kind: "error", reason: `jev: unknown/out-of-range choice key "${answer.choice}"` };
    }

    return {
      kind: "pick",
      index,
      confidence: answer.confidence,
      reason: "jev: choice",
      probabilities: answer.probabilities,
    };
  }
}
