import { FlowFileSchema, StepSchema } from "./schema.ts";
import type { Step } from "./types.ts";

/** Only compiler-created boundary metadata is admitted after ordinary action validation. */
export function validateBoundSteps(steps: unknown[]): Step[] {
  return steps.map((value, index) => {
    const invalid = (): never => {
      // Schema messages can include enum values or caller-provided keys. Do not echo input data.
      throw new Error(`BOUND_STEP_INVALID: steps[${index}] violates its action schema`);
    };
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const { __boundary, __outputs, ...action } = value as Record<string, unknown>;
    if (typeof action.id !== "string") return invalid();
    if (__boundary !== undefined && __boundary !== "before" && __boundary !== "after")
      return invalid();
    if (__boundary !== undefined && action.do !== "assert") return invalid();
    const parsed = StepSchema.safeParse({
      ...action,
      ...(__boundary !== undefined ? { id: "compiled-boundary" } : {}),
    });
    if (!parsed.success) return invalid();
    if (__outputs !== undefined && !FlowFileSchema.shape.outputs.safeParse(__outputs).success)
      return invalid();
    return Object.assign(parsed.data, {
      id: action.id,
      ...(__boundary !== undefined ? { __boundary } : {}),
      ...(__outputs !== undefined ? { __outputs } : {}),
    });
  });
}
