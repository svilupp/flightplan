// Flightplan — `resolveChooserChain` matrix + `HeuristicChooser` unit tests (PLAN_JEV.md §7.2).

import { describe, expect, test } from "bun:test";
import type { CandidateChooser } from "./chooser.ts";
import { ClassifierConfigError, HeuristicChooser, resolveChooserChain } from "./chooser.ts";
import type { CandidatePacketEntry } from "./resolve-common.ts";

function fakeChooser(kind: "jev" | "llm"): CandidateChooser {
  return {
    kind,
    choose: () => Promise.resolve({ kind: "abstain", reason: "fake" }),
  };
}

describe("resolveChooserChain", () => {
  test('"auto" with both keys: JEV then LLM then heuristic', () => {
    const chain = resolveChooserChain({
      classifier: "auto",
      jevAvailable: true,
      jevKeyEnv: "TYPESAFE_API_KEY",
      llmAvailable: true,
      makeJev: () => fakeChooser("jev"),
      makeLlm: () => fakeChooser("llm"),
    });
    expect(chain.map((c) => c.kind)).toEqual(["jev", "llm", "heuristic"]);
  });

  test('"auto" with only the JEV key: JEV then heuristic', () => {
    const chain = resolveChooserChain({
      classifier: "auto",
      jevAvailable: true,
      jevKeyEnv: "TYPESAFE_API_KEY",
      llmAvailable: false,
      makeJev: () => fakeChooser("jev"),
      makeLlm: () => fakeChooser("llm"),
    });
    expect(chain.map((c) => c.kind)).toEqual(["jev", "heuristic"]);
  });

  test('"auto" with only the LLM key: LLM then heuristic', () => {
    const chain = resolveChooserChain({
      classifier: "auto",
      jevAvailable: false,
      jevKeyEnv: "TYPESAFE_API_KEY",
      llmAvailable: true,
      makeJev: () => fakeChooser("jev"),
      makeLlm: () => fakeChooser("llm"),
    });
    expect(chain.map((c) => c.kind)).toEqual(["llm", "heuristic"]);
  });

  test('"auto" with zero keys still ends in the heuristic terminal rung', () => {
    const chain = resolveChooserChain({
      classifier: "auto",
      jevAvailable: false,
      jevKeyEnv: "TYPESAFE_API_KEY",
      llmAvailable: false,
      makeJev: () => fakeChooser("jev"),
      makeLlm: () => fakeChooser("llm"),
    });
    expect(chain.map((c) => c.kind)).toEqual(["heuristic"]);
  });

  test('"heuristic" is always exactly [HeuristicChooser], regardless of key availability', () => {
    const chain = resolveChooserChain({
      classifier: "heuristic",
      jevAvailable: true,
      jevKeyEnv: "TYPESAFE_API_KEY",
      llmAvailable: true,
      makeJev: () => fakeChooser("jev"),
      makeLlm: () => fakeChooser("llm"),
    });
    expect(chain).toHaveLength(1);
    expect(chain[0]).toBeInstanceOf(HeuristicChooser);
  });

  test('explicit "jev" with the key present: exactly [JevChooser]', () => {
    const chain = resolveChooserChain({
      classifier: "jev",
      jevAvailable: true,
      jevKeyEnv: "TYPESAFE_API_KEY",
      llmAvailable: true,
      makeJev: () => fakeChooser("jev"),
      makeLlm: () => fakeChooser("llm"),
    });
    expect(chain.map((c) => c.kind)).toEqual(["jev"]);
  });

  test('explicit "jev" with the key MISSING throws ClassifierConfigError naming the env NAME', () => {
    expect(() =>
      resolveChooserChain({
        classifier: "jev",
        jevAvailable: false,
        jevKeyEnv: "TYPESAFE_API_KEY",
        llmAvailable: true,
        makeJev: () => fakeChooser("jev"),
        makeLlm: () => fakeChooser("llm"),
      }),
    ).toThrow(ClassifierConfigError);
    try {
      resolveChooserChain({
        classifier: "jev",
        jevAvailable: false,
        jevKeyEnv: "TYPESAFE_API_KEY",
        llmAvailable: true,
        makeJev: () => fakeChooser("jev"),
        makeLlm: () => fakeChooser("llm"),
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ClassifierConfigError);
      expect((err as Error).message).toContain("TYPESAFE_API_KEY");
      // never leaks a value, only the env NAME
      expect((err as Error).message).not.toMatch(/sk-|Bearer/i);
    }
  });

  test('explicit "llm" with no generative provider throws ClassifierConfigError', () => {
    expect(() =>
      resolveChooserChain({
        classifier: "llm",
        jevAvailable: true,
        jevKeyEnv: "TYPESAFE_API_KEY",
        llmAvailable: false,
        makeJev: () => fakeChooser("jev"),
        makeLlm: () => fakeChooser("llm"),
      }),
    ).toThrow(ClassifierConfigError);
  });

  test('explicit "llm" with a provider present: exactly [LlmChooser]', () => {
    const chain = resolveChooserChain({
      classifier: "llm",
      jevAvailable: false,
      jevKeyEnv: "TYPESAFE_API_KEY",
      llmAvailable: true,
      makeJev: () => fakeChooser("jev"),
      makeLlm: () => fakeChooser("llm"),
    });
    expect(chain.map((c) => c.kind)).toEqual(["llm"]);
  });
});

describe("HeuristicChooser", () => {
  const chooser = new HeuristicChooser();

  test("picks index 0 when score clears the threshold and the top-two gap is wide", async () => {
    const candidates: CandidatePacketEntry[] = [
      { index: 0, role: "button", name: "Save", score: 0.9 },
      { index: 1, role: "button", name: "Cancel", score: 0.3 },
    ];
    const result = await chooser.choose("save it", candidates, {
      step: { id: "s1", do: "click" } as never,
      action: "click",
    });
    expect(result).toMatchObject({ kind: "pick", index: 0, confidence: 0.9 });
  });

  test("abstains on an empty packet", async () => {
    const result = await chooser.choose("save it", [], {
      step: { id: "s1", do: "click" } as never,
      action: "click",
    });
    expect(result.kind).toBe("abstain");
  });

  test("abstains when the top score is below the threshold", async () => {
    const candidates: CandidatePacketEntry[] = [
      { index: 0, role: "button", name: "Save", score: 0.2 },
    ];
    const result = await chooser.choose("save it", candidates, {
      step: { id: "s1", do: "click" } as never,
      action: "click",
    });
    expect(result.kind).toBe("abstain");
  });

  test("abstains when the top-two gap is too narrow (ambiguity shape)", async () => {
    const candidates: CandidatePacketEntry[] = [
      { index: 0, role: "button", name: "Save", score: 0.6 },
      { index: 1, role: "button", name: "Save", score: 0.55 },
    ];
    const result = await chooser.choose("save it", candidates, {
      step: { id: "s1", do: "click" } as never,
      action: "click",
    });
    expect(result.kind).toBe("abstain");
  });
});
