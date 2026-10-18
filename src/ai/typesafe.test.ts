import { describe, expect, test } from "bun:test";
import { BudgetTracker, JevRequestBudget } from "./budget.ts";
import { jevUsageCost } from "./cost.ts";
import { gateJevChoice, gateJevPresence } from "./jev-policy.ts";
import {
  FetchJevTransport,
  type JevRequest,
  safeJevRequest,
  validateJevRequest,
  validateJevResponse,
} from "./typesafe.ts";

const request: JevRequest = {
  model: "jev-1.14.0",
  state: { screenshot: "<screen>" },
  assets: {
    "<screen>": {
      type: "image",
      format: "png",
      data_base64:
        "iVBORw0KGgoAAAANSUhEUgAAARgAAAEYCAIAAAAI7H7bAAADH0lEQVR4nO3TQQkAMAzAwPo3vYloYDDuFOSTOcDavA6AHxgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCgJEgYCQIGAkCRoKAkSBgJAgYCQJGgoCRIGAkCBgJAkaCwAVHyV7eA9YY1wAAAABJRU5ErkJggg==",
    },
  },
  questions: {
    pick: {
      type: "choice",
      instructions: "Choose",
      criteria: { c0: "A", none_of_the_above: "None" },
    },
    present: { type: "noul", instructions: "Present?" },
    box: { type: "box", instructions: "Locate" },
  },
};
const valid = () => ({
  model: "jev-1.14.0",
  answers: {
    pick: {
      type: "choice",
      choice: "c0",
      confidence: 0.9,
      probabilities: { c0: 0.9, none_of_the_above: 0.1 },
    },
    present: { type: "noul", noul: 0.99 },
    box: { type: "box", box: { top: 0.1, bottom: 0.4, left: 0.2, right: 0.5 }, confidence: null },
  },
  usage: { input_tokens: 100, output_tokens: null as number | null },
});
describe("typed TypeSafe boundary", () => {
  test("validates all primitives and preserves nullable SDK fields", () => {
    expect<unknown>(validateJevResponse(valid(), request)).toEqual(valid());
  });
  test("rejects malformed distributions, discriminants, boxes and counters", () => {
    const mutations = [
      (r: ReturnType<typeof valid> & { answers: Record<string, unknown> }) => {
        r.answers.pick.type = "noul";
      },
      (r: ReturnType<typeof valid> & { answers: Record<string, unknown> }) => {
        r.answers.pick.probabilities.c0 = NaN;
      },
      (r: ReturnType<typeof valid> & { answers: Record<string, unknown> }) => {
        r.answers.pick.probabilities.c0 = 0.5;
      },
      (r: ReturnType<typeof valid> & { answers: Record<string, unknown> }) => {
        Object.assign(r.answers.pick.probabilities, { extra: 0 });
      },
      (r: ReturnType<typeof valid> & { answers: Record<string, unknown> }) => {
        r.answers.pick.choice = "missing";
      },
      (r: ReturnType<typeof valid> & { answers: Record<string, unknown> }) => {
        r.answers.pick.choice = "none_of_the_above";
      },
      (r: ReturnType<typeof valid> & { answers: Record<string, unknown> }) => {
        r.answers.extra = r.answers.pick;
      },
      (r: ReturnType<typeof valid> & { answers: Record<string, unknown> }) => {
        Reflect.deleteProperty(r.answers, "present");
      },
      (r: ReturnType<typeof valid> & { answers: Record<string, unknown> }) => {
        r.answers.present.noul = 1.1;
      },
      (r: ReturnType<typeof valid> & { answers: Record<string, unknown> }) => {
        r.answers.box.box.right = 0.1;
      },
      (r: ReturnType<typeof valid> & { answers: Record<string, unknown> }) => {
        r.usage.input_tokens = -1;
      },
      (r: ReturnType<typeof valid> & { answers: Record<string, unknown> }) => {
        r.usage.output_tokens = 0.5;
      },
    ];
    for (const mutate of mutations) {
      const r = valid();
      mutate(r);
      expect(() => validateJevResponse(r, request)).toThrow("jev_result_invalid");
    }
  });
  test("keeps semantic abstention separate from protocol validity", () => {
    const r = valid();
    r.answers.pick.confidence = 0.3;
    validateJevResponse(r, request);
    expect(gateJevChoice({ ...r.answers.pick, type: "choice" })).toBe(false);
    expect(gateJevPresence({ type: "noul", noul: 0.98 })).toBe(false);
  });
  test("safe diagnostics never include pixels or arbitrary evidence", () => {
    const diagnostic = JSON.stringify(
      safeJevRequest({
        ...request,
        state: { password: "SECRET" },
        assets: { secret: { type: "image", format: "png", data_base64: "PIXELSECRET" } },
      }),
    );
    expect(diagnostic).not.toContain("SECRET");
    expect(diagnostic).not.toContain("data_base64");
  });
});
describe("JEV actual request accounting", () => {
  function setup(maxCost?: number, now?: () => number) {
    const budget = new BudgetTracker(maxCost === undefined ? {} : { max_cost_usd: maxCost });
    return {
      budget,
      requests: new JevRequestBudget({ budget, maxCallsPerStep: 2, maxRequestsPerRun: 3, now }),
    };
  }
  test("shared step allowance cannot reset and run ceiling spans steps", () => {
    const { requests } = setup();
    requests.reserve("a", request.model);
    requests.beginStep("a");
    requests.reserve("a", request.model);
    expect(() => requests.reserve("a", request.model)).toThrow("jev_budget_exhausted");
    requests.reserve("b", request.model);
    expect(() => requests.reserve("c", request.model)).toThrow("jev_budget_exhausted");
  });
  test("deadline starts before evidence and cannot be replenished", () => {
    let now = 0;
    const { requests } = setup(undefined, () => now);
    requests.beginStep("a");
    now = 8001;
    requests.beginStep("a");
    expect(() => requests.reserve("a", request.model)).toThrow("jev_timeout");
  });
  test("strict cost reserves maximum; unknown billing stays charged", () => {
    const { requests, budget } = setup(0.003);
    const reservation = requests.reserve("a", request.model);
    expect(budget.cost_usd).toBeCloseTo(0.002688);
    reservation.fail();
    expect(requests.unknownCostRequests).toBe(1);
    expect(() => requests.reserve("b", request.model)).toThrow("max_cost_usd");
  });
  test("reconciles actual pricing and rejects unpriced models under strict caps", () => {
    const { requests, budget } = setup(0.01);
    requests.reserve("a", request.model).settle(1703, request.model);
    expect(budget.cost_usd).toBeCloseTo(0.000071526);
    expect(jevUsageCost(request.model, null)).toBeNull();
    expect(() => requests.reserve("b", "future-model")).toThrow("max_cost_usd");
  });
  test("transport consumes reservation exactly once, sends image opt-in, sanitizes errors", async () => {
    const { requests } = setup();
    let calls = 0;
    const transport = new FetchJevTransport({
      apiKey: "secret",
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        calls++;
        expect(new Headers(init?.headers).get("TypeSafe-Danger-Zone-Images")).toBe("true");
        return Response.json(valid());
      }) as unknown as typeof fetch,
    });
    const context = { purpose: "test", reservation: requests.reserve("a", request.model) };
    await transport.evaluate(request, context);
    await expect(transport.evaluate(request, context)).rejects.toThrow("jev_reservation_invalid");
    expect(calls).toBe(1);
    const failed = new FetchJevTransport({
      apiKey: "secret",
      fetchFn: (async () =>
        Response.json({ detail: "SECRETPIXELS" }, { status: 500 })) as unknown as typeof fetch,
    });
    await expect(
      failed.evaluate(request, {
        purpose: "test",
        reservation: requests.reserve("a", request.model),
      }),
    ).rejects.toThrow("jev_request_failed");
    expect(requests.unknownCostRequests).toBe(1);
  });
});

test("cancellation and forged reservations never start a request", async () => {
  let calls = 0;
  const transport = new FetchJevTransport({
    apiKey: "secret",
    fetchFn: (async () => {
      calls++;
      return Response.json(valid());
    }) as unknown as typeof fetch,
  });
  const budget = new JevRequestBudget({
    budget: new BudgetTracker(),
    maxCallsPerStep: 2,
    maxRequestsPerRun: 3,
  });
  const controller = new AbortController();
  const reservation = budget.reserve("a", request.model, controller.signal);
  controller.abort();
  await expect(
    transport.evaluate(request, { purpose: "test", reservation, signal: controller.signal }),
  ).rejects.toThrow("jev_cancelled");
  await expect(
    transport.evaluate(request, {
      purpose: "test",
      reservation: { signal: new AbortController().signal, settle() {}, fail() {} },
    }),
  ).rejects.toThrow("jev_reservation_invalid");
  expect(calls).toBe(0);
  expect(budget.unknownCostRequests).toBe(1);
});

test("request boundary enforces SDK shape, image bytes, dimensions and referenced assets", () => {
  expect(validateJevRequest(request)).toBe(request);
  const malformed: unknown[] = [
    { ...request, extra: true },
    { ...request, state: null },
    { ...request, questions: { x: { type: "box", instructions: "find", criteria: {} } } },
    {
      ...request,
      questions: { x: { type: "choice", instructions: "find", criteria: { only: "one" } } },
    },
    { ...request, assets: {} },
    { ...request, model: "jev-1.13.0" },
    { ...request, state: {} },
    { ...request, assets: { "<screen>": { ...request.assets!["<screen>"], format: "webp" } } },
    { ...request, assets: { "<screen>": { ...request.assets!["<screen>"], data_base64: "AAAA" } } },
    {
      ...request,
      assets: {
        "<screen>": {
          ...request.assets!["<screen>"],
          data_base64: `${request.assets!["<screen>"]!.data_base64}\n`,
        },
      },
    },
    { ...request, state: { invalid: NaN } },
    { ...request, state: { invalid: undefined } },
    { ...request, state: { screenshot: "<screen>".repeat(20000) } },
  ];
  for (const raw of malformed) expect(() => validateJevRequest(raw)).toThrow("jev_result_invalid");
  for (const dimension of [279, 1569]) {
    const bytes = Uint8Array.from(atob(request.assets!["<screen>"]!.data_base64), (c) =>
      c.charCodeAt(0),
    );
    new DataView(bytes.buffer).setUint32(16, dimension);
    const raw = {
      ...request,
      assets: {
        "<screen>": {
          type: "image",
          format: "png",
          data_base64: btoa(String.fromCharCode(...bytes)),
        },
      },
    };
    expect(() => validateJevRequest(raw)).toThrow("jev_result_invalid");
  }
});

test("invalid request never reaches fetch and valid transmission accounts exact bytes", async () => {
  let calls = 0;
  const budget = new JevRequestBudget({
    budget: new BudgetTracker(),
    maxCallsPerStep: 2,
    maxRequestsPerRun: 3,
  });
  const transport = new FetchJevTransport({
    apiKey: "secret",
    fetchFn: (async () => {
      calls++;
      return Response.json(valid());
    }) as unknown as typeof fetch,
  });
  await expect(
    transport.evaluate(
      { ...request, state: {} },
      { purpose: "test", reservation: budget.reserve("a", request.model) },
    ),
  ).rejects.toThrow("jev_result_invalid");
  expect(calls).toBe(0);
  expect(budget.bytes).toBe(0);
  await transport.evaluate(request, {
    purpose: "test",
    reservation: budget.reserve("a", request.model),
  });
  expect(calls).toBe(1);
  expect(budget.bytes).toBe(new TextEncoder().encode(JSON.stringify(request)).byteLength);
});

test("pinned requests reject a different served model while legacy alias remains compatible", () => {
  const changed = { ...valid(), model: "jev-1.13.0" };
  expect(() => validateJevResponse(changed, request)).toThrow("jev_result_invalid");
  expect(() => validateJevResponse(changed, { ...request, model: "jev-latest" })).not.toThrow();
});

test("validated responses omit echoed evidence and unknown provider fields", () => {
  const raw = valid();
  const canary = "IMAGE_BASE64_KEY_CANARY";
  Object.assign(raw, { echoed_request: canary });
  Object.assign(raw.usage, { raw: canary });
  Object.assign(raw.answers.pick, { image: canary });
  Object.assign(raw.answers.box.box, { screenshot: canary });
  Object.assign(raw.answers.present, { debug: canary });
  const normalized = validateJevResponse(raw, request);
  expect(JSON.stringify(normalized)).not.toContain(canary);
  expect<unknown>(normalized).toEqual(valid());
});
