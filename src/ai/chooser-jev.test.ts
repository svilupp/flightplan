// Flightplan — `JevChooser` / `jevCall` unit tests (PLAN_JEV.md §7.1). Fake-fetch, no network.

import { describe, expect, test } from "bun:test";
import { BudgetExceededError, BudgetTracker } from "./budget.ts";
import type { ChooseContext } from "./chooser.ts";
import {
  buildSystemOneRequest,
  JEV_MAX_CANDIDATES,
  JEV_MODEL,
  JEV_NONE_KEY,
  JevChooser,
} from "./chooser-jev.ts";
import { CostAccumulator } from "./cost.ts";
import type { CandidatePacketEntry } from "./resolve-common.ts";

function candidates(n: number): CandidatePacketEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    role: "button",
    name: `Button ${i}`,
    score: 1 - i * 0.001,
    ...(i === 0 ? { context: "Draft D1236 > form" } : {}),
  }));
}

const ctx: ChooseContext = { step: { id: "s1", do: "click" } as never, action: "click" };

class RecordingSink {
  events: Array<Record<string, unknown>> = [];
  emitAiCall(payload: Record<string, unknown>): void {
    this.events.push(payload);
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetchSequence(responses: Array<Response | (() => Response)>): typeof fetch {
  let i = 0;
  return (async (_url: string, _init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return typeof r === "function" ? r() : r;
  }) as unknown as typeof fetch;
}

function makeRt(
  fetchFn: typeof fetch,
  opts: { limits?: ConstructorParameters<typeof BudgetTracker>[0] } = {},
) {
  const budget = new BudgetTracker(opts.limits ?? {});
  const cost = new CostAccumulator();
  const sink = new RecordingSink();
  return {
    budget,
    cost,
    aiWriter: sink,
    fetchFn,
    apiKey: "fixture-key-not-a-real-secret",
    sink,
  };
}

describe("buildSystemOneRequest", () => {
  test("request shape: c<index> keys, {role,name,context} values, mandatory none option, model", () => {
    const req = buildSystemOneRequest("the mark as paid button", "click", candidates(3), undefined);
    expect(req.model).toBe(JEV_MODEL);
    expect(req.questions.pick.criteria.c0).toEqual({
      role: "button",
      name: "Button 0",
      context: "Draft D1236 > form",
    });
    expect(req.questions.pick.criteria.c1).toEqual({ role: "button", name: "Button 1" });
    expect(req.questions.pick.criteria[JEV_NONE_KEY]).toBeDefined();
    expect(req.state.intent).toBe("the mark as paid button");
    expect(req.state.action).toBe("click");
  });

  test("serialized request body contains no selector/ref: strings (redaction invariant)", () => {
    const req = buildSystemOneRequest("click it", "click", candidates(5), "a note");
    const body = JSON.stringify(req);
    expect(body).not.toMatch(/selector/i);
    expect(body).not.toMatch(/ref:/);
  });

  test("truncates an oversized packet to the top JEV_MAX_CANDIDATES by score", () => {
    const req = buildSystemOneRequest(
      "click it",
      "click",
      candidates(JEV_MAX_CANDIDATES + 50),
      undefined,
    );
    const keys = Object.keys(req.questions.pick.criteria).filter((k) => k !== JEV_NONE_KEY);
    expect(keys).toHaveLength(JEV_MAX_CANDIDATES);
  });
});

describe("JevChooser decision rule", () => {
  test("pick: maps the returned choice key to the candidate index", async () => {
    const fetchFn = fakeFetchSequence([
      jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "c1",
            confidence: 0.97,
            probabilities: { c0: 0.02, c1: 0.97, c2: 0.01, [JEV_NONE_KEY]: 0 },
          },
        },
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    ]);
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    const result = await chooser.choose("click it", candidates(3), ctx);
    expect(result).toMatchObject({ kind: "pick", index: 1, confidence: 0.97 });
    if (result.kind === "pick") expect(result.probabilities).toBeDefined();
  });

  test("none_of_the_above abstains", async () => {
    const fetchFn = fakeFetchSequence([
      jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: JEV_NONE_KEY,
            confidence: 1.0,
            probabilities: { c0: 0, [JEV_NONE_KEY]: 1 },
          },
        },
        usage: { input_tokens: 50, output_tokens: 5 },
      }),
    ]);
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    const result = await chooser.choose("click it", candidates(1), ctx);
    expect(result.kind).toBe("abstain");
  });

  test("low confidence (0.35) abstains even on a non-none choice", async () => {
    const fetchFn = fakeFetchSequence([
      jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "c0",
            confidence: 0.35,
            probabilities: { c0: 0.43, c1: 0.25, [JEV_NONE_KEY]: 0.32 },
          },
        },
        usage: { input_tokens: 50, output_tokens: 5 },
      }),
    ]);
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    const result = await chooser.choose("click it", candidates(2), ctx);
    expect(result.kind).toBe("abstain");
  });

  test("near-tied top-two probabilities (gap < 0.2) abstain", async () => {
    const fetchFn = fakeFetchSequence([
      jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "c0",
            confidence: 0.65,
            probabilities: { c0: 0.5, c1: 0.45, [JEV_NONE_KEY]: 0.05 },
          },
        },
        usage: { input_tokens: 50, output_tokens: 5 },
      }),
    ]);
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    const result = await chooser.choose("click it", candidates(2), ctx);
    expect(result.kind).toBe("abstain");
  });

  test("unknown/malformed choice key returns error", async () => {
    const fetchFn = fakeFetchSequence([
      jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "bogus-key",
            confidence: 0.9,
            probabilities: { "bogus-key": 0.9, [JEV_NONE_KEY]: 0.1 },
          },
        },
        usage: { input_tokens: 50, output_tokens: 5 },
      }),
    ]);
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    const result = await chooser.choose("click it", candidates(2), ctx);
    expect(result.kind).toBe("error");
  });
});

describe("JevChooser failure paths", () => {
  test('400 "Too many choices" errors with no retry', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse(400, { detail: "Too many choices. Must have at most 255 choices." });
    }) as unknown as typeof fetch;
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    const result = await chooser.choose("click it", candidates(2), ctx);
    expect(result.kind).toBe("error");
    expect(calls).toBe(1); // never retried on a 4xx
  });

  test("500 then 200 is retried and succeeds", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(500, { detail: "internal error" });
      return jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "c0",
            confidence: 0.9,
            probabilities: { c0: 0.9, [JEV_NONE_KEY]: 0.1 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }) as unknown as typeof fetch;
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    const result = await chooser.choose("click it", candidates(1), ctx);
    expect(result.kind).toBe("pick");
    expect(calls).toBe(2);
  });

  test("network reject twice → error", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    const result = await chooser.choose("click it", candidates(1), ctx);
    expect(result.kind).toBe("error");
    expect(calls).toBe(2); // one retry
  });
});

describe("JevChooser accounting", () => {
  test("budget.noteModelCall() called once per attempt-set; BudgetExceededError propagates", async () => {
    const fetchFn = fakeFetchSequence([
      jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "c0",
            confidence: 0.9,
            probabilities: { c0: 0.9, [JEV_NONE_KEY]: 0.1 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]);
    const rt = makeRt(fetchFn, { limits: { max_model_calls: 0 } });
    const chooser = new JevChooser(rt);
    await expect(chooser.choose("click it", candidates(1), ctx)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  test("one ai_call event with role classifier, outcome, token counts, cost_usd 0", async () => {
    const fetchFn = fakeFetchSequence([
      jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "c0",
            confidence: 0.9,
            probabilities: { c0: 0.9, [JEV_NONE_KEY]: 0.1 },
          },
        },
        usage: { input_tokens: 42, output_tokens: 8 },
      }),
    ]);
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    await chooser.choose("click it", candidates(1), ctx);
    expect(rt.sink.events).toHaveLength(1);
    const evt = rt.sink.events[0]!;
    expect(evt.role).toBe("classifier");
    expect(evt.model).toBe("jev-1.13.0");
    expect(evt.inputTokens).toBe(42);
    expect(evt.outputTokens).toBe(8);
    expect(evt.cost_usd).toBe(0);
    expect(evt.outcome).toBe("ok");
  });

  test("CostAccumulator gains a { role: resolver, model: jev-1.13.0 } row", async () => {
    const fetchFn = fakeFetchSequence([
      jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "c0",
            confidence: 0.9,
            probabilities: { c0: 0.9, [JEV_NONE_KEY]: 0.1 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]);
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    await chooser.choose("click it", candidates(1), ctx);
    const usage = rt.cost.modelUsage();
    expect(usage).toContainEqual({ role: "resolver", model: "jev-1.13.0", calls: 1, cost_usd: 0 });
  });

  test("probabilities are logged in redactedResponse when a redactor is active", async () => {
    const fetchFn = fakeFetchSequence([
      jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "c0",
            confidence: 0.9,
            probabilities: { c0: 0.9, [JEV_NONE_KEY]: 0.1 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]);
    const rt = {
      ...makeRt(fetchFn),
      redactor: { enabled: true, redactText: (s: string) => s.replace(/secret/g, "[REDACTED]") },
    };
    const chooser = new JevChooser(rt);
    await chooser.choose("click it", candidates(1), ctx);
    const evt = rt.sink.events[0]!;
    expect(evt.redactedResponse).toContain("0.9");
    expect(evt.redactedResponse).toContain(JEV_NONE_KEY);
  });
});
