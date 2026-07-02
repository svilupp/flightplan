// Flightplan — flow/ public surface.
// flow/step/assertion types, the flow loader, import resolution + composition, and
// templating. Canonical reference: PLAN.md §4 (data model) and §2 (flow/).

export type { ImportGraph, ImportNode, ImportRelation } from "./imports.ts";
// Import resolution + composition.
export {
  extractRefs,
  ImportCycleError,
  ImportResolutionError,
  isRunFlowPath,
  resolveImports,
  resolveModulePath,
} from "./imports.ts";
export type { LoadedFlow } from "./load.ts";
// Loading.
export {
  computeSourceHash,
  FlowValidationError,
  loadFlowFile,
  parseFlowFile,
} from "./load.ts";
// Normalization (for_each expansion) — used by the loader and the linter.
export { expandForEachInDoc, expandForEachSteps, ForEachError } from "./normalize.ts";
export type { FlattenOptions } from "./run.ts";
// `run` step flattening (load-time composition, PLAN_v002 §3).
export {
  collectImportScope,
  flattenRunSteps,
  loadFlowFileFlattened,
  RunResolutionError,
} from "./run.ts";
// Schemas (zod 4) — exported so the linter / downstream phases can re-validate.
export {
  AiJudgeAssertionSchema,
  AiPickStepSchema,
  AssertionSchema,
  AssertStepSchema,
  ClickStepSchema,
  CountAssertionSchema,
  DeterministicAssertionSchema,
  FillStepSchema,
  FlowFileSchema,
  GotoStepSchema,
  HiddenAssertionSchema,
  ImportsSchema,
  OnFailSchema,
  PressStepSchema,
  RunStepSchema,
  SelectStepSchema,
  StepSchema,
  TextAssertionSchema,
  UrlAssertionSchema,
  ValueAssertionSchema,
  VisibleAssertionSchema,
  WaitStepSchema,
} from "./schema.ts";
export type { LoopContext, TemplateContext, TemplateRef } from "./template.ts";

// Templating.
export {
  applyInputsTemplating,
  applyInputsTemplatingDeep,
  applyLoopTemplating,
  applyLoopTemplatingDeep,
  applyTemplating,
  applyTemplatingDeep,
  collectRefs,
  hasLoopToken,
  resolveInputs,
  TemplateError,
} from "./template.ts";
// Types (derived from the schemas; see ./types.ts).
export type {
  AiJudgeAssertion,
  AiPickStep,
  Assertion,
  AssertStep,
  ClickStep,
  CountAssertion,
  DeterministicAssertion,
  FillStep,
  FlowFile,
  GotoStep,
  HiddenAssertion,
  Imports,
  OnFail,
  PressStep,
  RunStep,
  SelectStep,
  Step,
  TextAssertion,
  UrlAssertion,
  ValueAssertion,
  VisibleAssertion,
  WaitStep,
} from "./types.ts";
