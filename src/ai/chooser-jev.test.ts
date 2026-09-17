// Flightplan — `JevChooser` / `jevCall` unit tests. Fake-fetch, no network.

import { describe, expect, test } from "bun:test";
import { BudgetExceededError, BudgetTracker } from "./budget.ts";
import type { ChooseContext } from "./chooser.ts";
import {
  buildSystemOneRequest,
  dedupeCandidatesForJev,
  JEV_MAX_CANDIDATES,
  JEV_MODEL,
  JEV_NONE_KEY,
  JevChooser,
  jevCall,
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

  test("500 then 200 is retried and succeeds, charging noteModelCall exactly once", async () => {
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
    // One LOGICAL JEV call (retries are internal), so exactly one budget unit is charged.
    expect(rt.budget.modelCalls).toBe(1);
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

  // D2: a malformed/non-JSON 200 must degrade to { kind: "error" }, never throw out of the
  // chooser (an uncaught error here would be a whole-run harness error, not a step failure).
  test("a non-JSON 200 body degrades to an error result (never throws)", async () => {
    const fetchFn = (async () =>
      new Response("not json at all {{{", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    const result = await chooser.choose("click it", candidates(1), ctx);
    expect(result.kind).toBe("error");
  });

  test.each([
    ["null body", null],
    ["string body", "just a string"],
    ["missing answers.pick", { model: "jev-1.13.0", answers: {}, usage: {} }],
    [
      "pick missing probabilities",
      {
        model: "jev-1.13.0",
        answers: { pick: { type: "choice", choice: "c0", confidence: 0.9 } },
        usage: {},
      },
    ],
    [
      "pick missing confidence",
      {
        model: "jev-1.13.0",
        answers: { pick: { type: "choice", choice: "c0", probabilities: { c0: 1 } } },
        usage: {},
      },
    ],
    [
      "pick with non-string choice",
      {
        model: "jev-1.13.0",
        answers: { pick: { type: "choice", choice: 0, confidence: 0.9, probabilities: { c0: 1 } } },
        usage: {},
      },
    ],
  ])(
    "a malformed 200 body (%s) degrades to an error result, event still emitted",
    async (_label, body) => {
      const fetchFn = fakeFetchSequence([jsonResponse(200, body)]);
      const rt = makeRt(fetchFn);
      const chooser = new JevChooser(rt);
      const result = await chooser.choose("click it", candidates(1), ctx);
      expect(result.kind).toBe("error");
      // The ai_call event is still emitted on a malformed body (the call happened).
      expect(rt.sink.events).toHaveLength(1);
      expect(rt.sink.events[0]!.role).toBe("classifier");
      expect(rt.sink.events[0]!.outcome).toBe("error");
    },
  );

  test("a malformed 200 body with a redactor active does not throw (redactedFields is guarded)", async () => {
    const fetchFn = fakeFetchSequence([jsonResponse(200, { not: "a system-one response" })]);
    const rt = {
      ...makeRt(fetchFn),
      redactor: { enabled: true, redactText: (s: string) => s },
    };
    const chooser = new JevChooser(rt);
    const result = await chooser.choose("click it", candidates(1), ctx);
    expect(result.kind).toBe("error");
  });
});

describe("JevChooser — empty candidate packet (D6)", () => {
  test("an empty packet abstains locally, no JEV call is made", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      throw new Error("must not be called for an empty packet");
    }) as unknown as typeof fetch;
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    const result = await chooser.choose("click it", [], ctx);
    expect(result.kind).toBe("abstain");
    expect(calls).toBe(0);
    expect(rt.budget.modelCalls).toBe(0);
    expect(rt.sink.events).toHaveLength(0);
  });
});

describe("dedupeCandidatesForJev (B3)", () => {
  test("collapses candidates sharing (role,name,context) to the first (highest-scored) representative", () => {
    const gauntlet: CandidatePacketEntry[] = [
      { index: 0, role: "button", name: "Save", score: 0.9, context: "Billing address" },
      { index: 3, role: "button", name: "Save", score: 0.7, context: "Search filters" },
      { index: 6, role: "button", name: "Save", score: 0.65, context: "Draft message" },
      { index: 1, role: "button", name: "Save", score: 0.86, context: "Billing address" },
      { index: 4, role: "button", name: "Save", score: 0.6, context: "Search filters" },
      { index: 7, role: "button", name: "Save", score: 0.55, context: "Draft message" },
      { index: 2, role: "button", name: "Save", score: 0.8, context: "Billing address" },
    ];
    const deduped = dedupeCandidatesForJev(gauntlet);
    expect(deduped).toHaveLength(3);
    expect(deduped.map((c) => c.index)).toEqual([0, 3, 6]); // first occurrence per group wins
    expect(deduped.map((c) => c.context)).toEqual([
      "Billing address",
      "Search filters",
      "Draft message",
    ]);
  });

  test("distinct candidates (different role/name/context) all survive, order preserved", () => {
    const distinct = candidates(3);
    expect(dedupeCandidatesForJev(distinct)).toEqual(distinct);
  });
});

describe("JevChooser — duplicate-candidate collapse (B3, fake fetch)", () => {
  // The exact gauntlet shape: 8-entry packet, 3 distinct physical "Save" buttons repeated via
  // multiple native-ranking strategy matches (role_name/label/scoped_text), each producing an
  // identical (role,name,context) triple. Indices mirror the live /gauntlet packet order.
  const GAUNTLET_PACKET: CandidatePacketEntry[] = [
    { index: 0, role: "button", name: "Save", score: 0.44, context: "Search filters" },
    { index: 1, role: "button", name: "Save", score: 0.44, context: "Billing address" },
    { index: 2, role: "button", name: "Save", score: 0.44, context: "Draft message" },
    { index: 3, role: "button", name: "Save", score: 0.4, context: "Search filters" },
    { index: 4, role: "button", name: "Save", score: 0.4, context: "Billing address" },
    { index: 5, role: "button", name: "Save", score: 0.4, context: "Draft message" },
    { index: 6, role: "button", name: "Save", score: 0.34, context: "Search filters" },
    { index: 7, role: "button", name: "Save", score: 0.34, context: "Billing address" },
  ];

  test("the outgoing request carries ONE option per distinct group, not 8", async () => {
    let capturedBody: string | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "c1",
            confidence: 0.95,
            probabilities: { c0: 0.02, c1: 0.95, c2: 0.02, [JEV_NONE_KEY]: 0.01 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }) as unknown as typeof fetch;
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    const result = await chooser.choose(
      "store the postal address I get invoices at",
      GAUNTLET_PACKET,
      ctx,
    );

    expect(result).toMatchObject({ kind: "pick", index: 1, confidence: 0.95 });
    const sent = JSON.parse(capturedBody!);
    const optionKeys = Object.keys(sent.questions.pick.criteria).filter((k) => k !== JEV_NONE_KEY);
    expect(optionKeys).toHaveLength(3); // 3 distinct groups, not 8 raw entries
    expect(optionKeys).toEqual(["c0", "c1", "c2"]); // representative = first occurrence per group
  });

  test("a pick maps back to the representative's ORIGINAL index (not renumbered)", async () => {
    // Representative for "Draft message" is index 2 (third distinct group); JEV picks it as "c2".
    const fetchFn = fakeFetchSequence([
      jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "c2",
            confidence: 0.9,
            probabilities: { c0: 0.03, c1: 0.03, c2: 0.9, [JEV_NONE_KEY]: 0.04 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]);
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    const result = await chooser.choose("save this as a draft", GAUNTLET_PACKET, ctx);
    expect(result).toMatchObject({ kind: "pick", index: 2 });
  });

  test("the top-two probability gap is computed over the 3 DISTINCT options, not 8 raw ones", async () => {
    // Split evenly across the surviving 3 groups' representative + a wide gap to "none" — this
    // must NOT read as near-tied (the historical bug: splitting the SAME group across 3 raw
    // entries made the top-two gap look artificially narrow, e.g. 0.83 vs 0.11 vs 0.06 rawـ
    // entries of the SAME physical button competing against each other).
    const fetchFn = fakeFetchSequence([
      jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          pick: {
            type: "choice",
            choice: "c1",
            confidence: 0.7,
            probabilities: { c0: 0.05, c1: 0.7, c2: 0.05, [JEV_NONE_KEY]: 0.2 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]);
    const rt = makeRt(fetchFn);
    const chooser = new JevChooser(rt);
    const result = await chooser.choose(
      "store the postal address I get invoices at",
      GAUNTLET_PACKET,
      ctx,
    );
    // gap = 0.7 - 0.2 = 0.5 >= JEV_MIN_PROB_GAP (0.2) → a confident pick, not a false abstain.
    expect(result.kind).toBe("pick");
  });
});

describe("JevChooser — auth header (D5/bearer)", () => {
  test("the request carries an Authorization: Bearer <key> header", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
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
    await chooser.choose("click it", candidates(1), ctx);
    const headers = capturedInit?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe(`Bearer ${rt.apiKey}`);
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

describe("jevCall — per-attempt timeout/abort signal (D4/D5)", () => {
  const okBody = {
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
  };

  test("a fresh AbortSignal is used on each attempt (not one shared signal across retries)", async () => {
    const capturedSignals: (AbortSignal | undefined | null)[] = [];
    let calls = 0;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      capturedSignals.push(init?.signal);
      if (calls === 1) return jsonResponse(500, { detail: "internal error" });
      return jsonResponse(200, okBody);
    }) as unknown as typeof fetch;
    const rt = makeRt(fetchFn);
    const result = await jevCall(
      rt,
      "resolve:s1",
      buildSystemOneRequest("x", "click", candidates(1), undefined),
    );
    expect(result.response.answers.pick.choice).toBe("c0");
    expect(capturedSignals).toHaveLength(2);
    expect(capturedSignals[0]).not.toBe(capturedSignals[1]);
  });

  test("an already-aborted runtime/call signal skips the retry after a 5xx (fail fast on cancellation)", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse(500, { detail: "internal error" });
    }) as unknown as typeof fetch;
    const rt = { ...makeRt(fetchFn), signal: AbortSignal.abort(new Error("cancelled")) };
    await expect(
      jevCall(rt, "resolve:s1", buildSystemOneRequest("x", "click", candidates(1), undefined)),
    ).rejects.toBeDefined();
    expect(calls).toBe(1); // the external cancellation must not spend a retry
  });

  test("the runtime-level signal (D5) is combined with a per-call signal", async () => {
    let calls = 0;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      // Both the runtime signal and the call signal are already aborted; the combined signal
      // passed to fetch must reflect that (aborted), proving both were threaded in.
      expect(init?.signal?.aborted).toBe(true);
      return jsonResponse(500, { detail: "internal error" });
    }) as unknown as typeof fetch;
    const rt = { ...makeRt(fetchFn), signal: AbortSignal.abort(new Error("runtime cancelled")) };
    const callSignal = AbortSignal.abort(new Error("call cancelled"));
    await expect(
      jevCall(
        rt,
        "resolve:s1",
        buildSystemOneRequest("x", "click", candidates(1), undefined),
        callSignal,
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });
});
