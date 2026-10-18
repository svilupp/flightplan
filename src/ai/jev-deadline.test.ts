import { expect, test } from "bun:test";
import { BudgetTracker, JevRequestBudget } from "./budget.ts";

function fixture() {
  let now = 0;
  const budget = new JevRequestBudget({
    budget: new BudgetTracker({}),
    maxCallsPerStep: 2,
    maxRequestsPerRun: 3,
    now: () => now,
  });
  return {
    budget,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("expired acquisition cannot start or reset the shared step deadline", async () => {
  const f = fixture();
  f.budget.beginStep("step");
  f.advance(8000);
  let started = false;
  await expect(
    f.budget.withinStep("step", async () => {
      started = true;
    }),
  ).rejects.toThrow("jev_timeout");
  expect(started).toBe(false);
});

test("evidence resolving after the shared deadline is rejected before continuation", async () => {
  const f = fixture();
  let release!: (value: string) => void;
  const pending = f.budget.withinStep(
    "step",
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  f.advance(8000);
  release("late pixels");
  await expect(pending).rejects.toThrow("jev_timeout");
});

test("abort interrupts hung evidence acquisition", async () => {
  const f = fixture();
  const controller = new AbortController();
  const pending = f.budget.withinStep(
    "step",
    () => new Promise<never>(() => {}),
    controller.signal,
  );
  controller.abort(new Error("cancelled acquisition"));
  await expect(pending).rejects.toThrow("cancelled acquisition");
});
