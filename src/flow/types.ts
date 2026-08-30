// Flightplan — flow TS types.
//
// DERIVED from the zod schemas in `./schema.ts` via `z.infer` so the validator and types
// stay in lock-step (PLAN.md §4 warns a mismatch propagates downstream). The named aliases
// below are what the rest of the codebase imports. Canonical reference: PLAN.md §4.

import type { z } from "zod";
import type {
  AiJudgeAssertionSchema,
  AiPickStepSchema,
  AssertionSchema,
  AssertStepSchema,
  CaptureSchema,
  ClickStepSchema,
  CountAssertionSchema,
  DeterministicAssertionSchema,
  EmitAwaitReplySchema,
  EmitStepSchema,
  EvalStepSchema,
  EvaluateStepSchema,
  FillStepSchema,
  FlowFileSchema,
  GotoStepSchema,
  HiddenAssertionSchema,
  ImportsSchema,
  OnFailSchema,
  PopupExpectationSchema,
  PressStepSchema,
  ResultAssertionSchema,
  RunStepSchema,
  SelectStepSchema,
  StateAssertionSchema,
  StepSchema,
  SwitchFrameStepSchema,
  SwitchToMainStepSchema,
  TextAssertionSchema,
  TransitionAssertionSchema,
  UrlAssertionSchema,
  ValueAssertionSchema,
  VisibleAssertionSchema,
  WaitStepSchema,
  WebMcpCallStepSchema,
} from "./schema.ts";

// ---- Assertions ----
export type VisibleAssertion = z.infer<typeof VisibleAssertionSchema>;
export type HiddenAssertion = z.infer<typeof HiddenAssertionSchema>;
export type TextAssertion = z.infer<typeof TextAssertionSchema>;
export type UrlAssertion = z.infer<typeof UrlAssertionSchema>;
export type ValueAssertion = z.infer<typeof ValueAssertionSchema>;
export type CountAssertion = z.infer<typeof CountAssertionSchema>;
export type StateAssertion = z.infer<typeof StateAssertionSchema>;
export type TransitionAssertion = z.infer<typeof TransitionAssertionSchema>;
export type ResultAssertion = z.infer<typeof ResultAssertionSchema>;
export type AiJudgeAssertion = z.infer<typeof AiJudgeAssertionSchema>;
export type DeterministicAssertion = z.infer<typeof DeterministicAssertionSchema>;
export type Assertion = z.infer<typeof AssertionSchema>;
export type Capture = z.infer<typeof CaptureSchema>;
export type PopupExpectation = z.infer<typeof PopupExpectationSchema>;

// ---- Control flow ----
export type OnFail = z.infer<typeof OnFailSchema>;

// ---- Steps ----
export type GotoStep = z.infer<typeof GotoStepSchema>;
export type ClickStep = z.infer<typeof ClickStepSchema>;
export type FillStep = z.infer<typeof FillStepSchema>;
export type SelectStep = z.infer<typeof SelectStepSchema>;
export type PressStep = z.infer<typeof PressStepSchema>;
export type WaitStep = z.infer<typeof WaitStepSchema>;
export type AssertStep = z.infer<typeof AssertStepSchema>;
export type AiPickStep = z.infer<typeof AiPickStepSchema>;
export type RunStep = z.infer<typeof RunStepSchema>;
export type SwitchFrameStep = z.infer<typeof SwitchFrameStepSchema>;
export type SwitchToMainStep = z.infer<typeof SwitchToMainStepSchema>;
export type EmitAwaitReply = z.infer<typeof EmitAwaitReplySchema>;
export type EmitStep = z.infer<typeof EmitStepSchema>;
export type EvalStep = z.infer<typeof EvalStepSchema>;
export type EvaluateStep = z.infer<typeof EvaluateStepSchema>;
export type WebMcpCallStep = z.infer<typeof WebMcpCallStepSchema>;
export type Step = z.infer<typeof StepSchema>;

// ---- Imports ----
export type Imports = z.infer<typeof ImportsSchema>;

// ---- FlowFile ----
export type FlowFile = z.infer<typeof FlowFileSchema>;
