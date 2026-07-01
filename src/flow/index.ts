// Flightplan — flow/ public surface.
// flow/step/assertion types, the flow loader, import resolution + composition, and
// templating. Canonical reference: PLAN.md §4 (data model) and §2 (flow/).

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
  ImportTable,
  PressStep,
  SelectStep,
  Step,
  TextAssertion,
  UrlAssertion,
  ValueAssertion,
  VisibleAssertion,
  WaitStep,
} from "./types.ts";

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
  ImportTableSchema,
  PressStepSchema,
  SelectStepSchema,
  StepSchema,
  TextAssertionSchema,
  UrlAssertionSchema,
  ValueAssertionSchema,
  VisibleAssertionSchema,
  WaitStepSchema,
} from "./schema.ts";

// Loading.
export {
  computeSourceHash,
  FlowValidationError,
  loadFlowFile,
  parseFlowFile,
} from "./load.ts";
export type { LoadedFlow } from "./load.ts";

// Import resolution + composition.
export {
  extractRefs,
  ImportCycleError,
  ImportResolutionError,
  resolveImports,
} from "./imports.ts";
export type { ImportGraph, ImportNode, ImportRelation } from "./imports.ts";

// Templating.
export {
  applyTemplating,
  applyTemplatingDeep,
  collectRefs,
  resolveInputs,
  TemplateError,
} from "./template.ts";
export type { TemplateContext, TemplateRef } from "./template.ts";
