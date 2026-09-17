// Flightplan — the `CandidateChooser` abstraction.
//
// `resolveL2` (`resolver-l2.ts`) walks an ORDERED chain of `CandidateChooser`s: on an `abstain`/
// `error` result it falls through to the next chooser; a `pick` acts immediately; an
// `escalateTo: "vision"` short-circuits the chain straight to L3. This file owns the
// chooser-agnostic contract, the deterministic zero-key `HeuristicChooser`, and the chain-
// selection rule (`resolveChooserChain`). SDK-free — importable next to `resolve-common.ts`.

import type { Step } from "../flow/types.ts";
import type { BatchActionVerb } from "../ladder/index.ts";
import type { CandidatePacketEntry } from "./resolve-common.ts";

export type ChooserKind = "heuristic" | "jev" | "llm";

/** Per-call context a chooser needs beyond the intent + candidate list. */
export interface ChooseContext {
  /** The step being resolved (step.id feeds `purpose` strings; the chooser never inspects effect). */
  step: Step;
  /** The batch action verb (`actionForStep`, `resolve-common.ts`). */
  action: BatchActionVerb;
  /** FRESH stored advisory note for this target, if any (`storedNoteForStep`). */
  note?: string;
  /** Runtime cancellation signal (combined the same way `generate`'s deps.signal is). */
  signal?: AbortSignal;
}

/** Discriminated result: a gated pick, an abstain (fall through / escalate), or a chooser error. */
export type ChooseResult =
  | {
      kind: "pick";
      /** Index into the candidate packet (=== `RankedCandidate` index). */
      index: number;
      /** 0..1, ALREADY gated by the chooser's own confidence threshold. */
      confidence: number;
      reason?: string;
      /** Generative choosers only (LLM `note_out`); JEV/heuristic never set this. */
      note?: string;
      /** JEV only — logged to the `ai_call` event; never gates downstream logic. */
      probabilities?: Record<string, number>;
    }
  | { kind: "abstain"; reason: string; escalateTo?: "vision" }
  | { kind: "error"; reason: string };

/** One candidate-choosing backend. */
export interface CandidateChooser {
  readonly kind: ChooserKind;
  choose(
    intent: string,
    candidates: CandidatePacketEntry[],
    ctx: ChooseContext,
  ): Promise<ChooseResult>;
}

/**
 * Minimum fuzzy `score` (`CandidatePacketEntry.score`) for the heuristic's top-ranked candidate to
 * be picked at all. Matches L1's `minScore` default (`ladder/l1.ts`) — below this the deterministic
 * fuzzy match itself would not have been confident.
 */
export const HEURISTIC_MIN_SCORE = 0.4;

/**
 * Minimum top-two score gap for the heuristic to pick (mirrors `isAmbiguous`, `ladder/fuzzy.ts`).
 * A near-tied top two is exactly the ambiguity shape L1 already vetoed on — the heuristic must not
 * paper over it.
 */
export const HEURISTIC_MIN_GAP = 0.1;

/**
 * Deterministic, zero-key chooser: picks index 0 iff the packet is non-empty, its score clears
 * {@link HEURISTIC_MIN_SCORE}, and the top-two score gap clears {@link HEURISTIC_MIN_GAP}; else
 * abstains. Useful as the terminal `"auto"` rung and for offline/deterministic tests.
 */
export class HeuristicChooser implements CandidateChooser {
  readonly kind = "heuristic" as const;

  choose(
    _intent: string,
    candidates: CandidatePacketEntry[],
    _ctx: ChooseContext,
  ): Promise<ChooseResult> {
    if (candidates.length === 0) {
      return Promise.resolve({ kind: "abstain", reason: "heuristic: no candidates" });
    }
    const top = candidates[0]!;
    if (top.score < HEURISTIC_MIN_SCORE) {
      return Promise.resolve({
        kind: "abstain",
        reason: `heuristic: top score ${top.score} below threshold`,
      });
    }
    const second = candidates[1];
    const gap = top.score - (second?.score ?? 0);
    if (gap < HEURISTIC_MIN_GAP) {
      return Promise.resolve({
        kind: "abstain",
        reason: `heuristic: top-two gap ${gap.toFixed(2)} below threshold`,
      });
    }
    return Promise.resolve({
      kind: "pick",
      index: top.index,
      confidence: top.score,
      reason: "heuristic: top score",
    });
  }
}

/** Thrown at runtime build when an EXPLICIT classifier's prerequisite is missing (fail-fast). */
export class ClassifierConfigError extends Error {}

export const AI_CLASSIFIERS = ["auto", "heuristic", "jev", "llm"] as const;
export type ClassifierName = (typeof AI_CLASSIFIERS)[number];

/**
 * Build the ordered chooser chain for `resolveL2` to walk. Explicit settings are STRICT (exactly
 * one chooser; a missing prerequisite is a config error). `"auto"` is a PREFERENCE ORDERING: JEV
 * (if its key is set) → LLM (if a generative provider is available) → heuristic (terminal safety
 * net, always present in `"auto"`).
 */
export function resolveChooserChain(opts: {
  classifier: ClassifierName;
  /** `env[jevKeyEnv]` was non-empty at runtime-build time. */
  jevAvailable: boolean;
  /** Env var NAME LABEL (never a value) — used verbatim (already quoted) in the
   * `ClassifierConfigError` message. Build via `jevApiKeyEnvLabel` (`config/resolve.ts`): the
   * default case names both `"TYPESAFE_API_KEY"`/`"JEV_API_KEY"`; an explicit `jev_api_key_env`
   * names only that one NAME. */
  jevKeyEnv: string;
  /** A real `GenerateFn` exists (provider key present / factory-injected). */
  llmAvailable: boolean;
  makeJev: () => CandidateChooser;
  makeLlm: () => CandidateChooser;
}): CandidateChooser[] {
  switch (opts.classifier) {
    case "heuristic":
      return [new HeuristicChooser()];
    case "jev":
      if (!opts.jevAvailable) {
        throw new ClassifierConfigError(
          `[ai] classifier = "jev" but env ${opts.jevKeyEnv} is not set`,
        );
      }
      return [opts.makeJev()];
    case "llm":
      if (!opts.llmAvailable) {
        throw new ClassifierConfigError(
          '[ai] classifier = "llm" but no generative provider key is available',
        );
      }
      return [opts.makeLlm()];
    case "auto": {
      const chain: CandidateChooser[] = [];
      if (opts.jevAvailable) chain.push(opts.makeJev());
      if (opts.llmAvailable) chain.push(opts.makeLlm());
      chain.push(new HeuristicChooser());
      return chain;
    }
  }
}
