import { expect, test } from "bun:test";
import { BudgetTracker, claimJevReservation } from "./budget.ts";
import { CostAccumulator } from "./cost.ts";
import { createJevExtractionMapper } from "./extraction-map.ts";
import type { JevTransport } from "./typesafe.ts";

const request = {
  step: "extract",
  fields: { price: { description: "Product USD price" } },
  candidates: [
    { selector: '[data-testid="price"]', text: "USD 101" },
    { selector: '[data-testid="discount"]', text: "Discount 10" },
  ],
};
function options(transport?: JevTransport) {
  return {
    apiKey: "fake",
    runtime: {
      budget: new BudgetTracker({ max_model_calls: 2 }),
      cost: new CostAccumulator(),
      aiWriter: { emitAiCall: () => {} },
    },
    timeoutMs: 1000,
    maxRequests: 2,
    transport,
  };
}
test("bounded independent map choices return only supplied durable selectors", async () => {
  const config = options({
    evaluate: async (req, context) => {
      claimJevReservation(context.reservation);
      context.reservation.settle(100, req.model);
      return {
        model: req.model,
        usage: { input_tokens: 100, output_tokens: 0 },
        answers: {
          field0: {
            type: "choice",
            choice: "c0",
            confidence: 0.95,
            probabilities: { c0: 0.95, c1: 0.03, none: 0.02 },
          },
        },
      };
    },
  });
  expect(await createJevExtractionMapper(config)(request)).toEqual({
    price: '[data-testid="price"]',
  });
  expect(config.runtime.budget.modelCalls).toBe(1);
});
test("confidence alone cannot authorize a weak or nonleading field choice", async () => {
  const mapper = createJevExtractionMapper(
    options({
      evaluate: async (req, context) => {
        claimJevReservation(context.reservation);
        context.reservation.settle(100, req.model);
        return {
          model: req.model,
          usage: { input_tokens: 100, output_tokens: 0 },
          answers: {
            field0: {
              type: "choice",
              choice: "c0",
              confidence: 0.99,
              probabilities: { c0: 0.4, c1: 0.59, none: 0.01 },
            },
          },
        };
      },
    }),
  );
  await expect(mapper(request)).rejects.toThrow("abstained");
});
const live = process.env.FLIGHTPLAN_RECIPE_JEV === "1" ? test : test.skip;
live(
  "live JEV validates a synthetic mapping response and preserves conservative abstention",
  async () => {
    const key = process.env.TYPESAFE_API_KEY;
    expect(Boolean(key)).toBe(true);
    const configuration = { ...options(), apiKey: key!, timeoutMs: 5000 };
    let protocolResponses = 0;
    configuration.runtime.aiWriter.emitAiCall = () => {
      protocolResponses++;
    };
    const mapper = createJevExtractionMapper(configuration);
    const outcome = await mapper(request).then(
      (map) => ({ map, error: undefined }),
      (error: Error) => ({ map: undefined, error: error.message }),
    );
    expect(protocolResponses).toBe(1);
    expect(configuration.runtime.budget.modelCalls).toBe(1);
    if (outcome.map) expect(outcome.map).toEqual({ price: '[data-testid="price"]' });
    else expect(outcome.error).toBe("extract map abstained");
  },
  10000,
);
