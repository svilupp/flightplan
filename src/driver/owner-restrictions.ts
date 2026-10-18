import type {
  ActionGuardOptions,
  ActionProposal,
  GuardStep,
  GuardVerdict,
} from "../guard/types.ts";
import { OwnerActionError } from "./owner-actions.ts";
import type { OwnerPreparedAction } from "./owner-contract.ts";

/** A caller restriction can veto an owner proposal. It never creates an owner approval. */
export function ownerRestrictions(options: ActionGuardOptions, redact: (text: string) => string) {
  let step: GuardStep | undefined;
  let evaluations = 0;
  const pending = new Set<Promise<void>>();
  async function evaluate(prepared: OwnerPreparedAction): Promise<void> {
    if (options.dispatch || options.identify)
      throw new OwnerActionError("local_dispatch_override_unsupported");
    if (
      options.mode === "enforce" &&
      prepared.assurance !== (options.requiredAssurance ?? "renderer-same-task-dom")
    )
      throw new OwnerActionError("dispatch_assurance_unavailable");
    const capturedStep = step;
    const proposal: ActionProposal = {
      version: 1,
      id: prepared.preparedId,
      policyVersion: options.policyVersion,
      operation: prepared.evidence.action,
      action: prepared.evidence.action,
      ...(prepared.evidence.destination
        ? { navigationUrl: redact(prepared.evidence.destination) }
        : {}),
      ...(step
        ? {
            stepId: step.id,
            effect: step.effect,
            intent: redact(typeof step.target === "string" ? step.target : step.do),
          }
        : {}),
      selectors: [],
      payload: "redacted",
      evidence: {
        url: redact(prepared.evidence.url),
        frame: null,
        text: redact(prepared.evidence.target ?? prepared.evidence.text),
        observedAt: prepared.evidence.observedAt,
      },
    };
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 3000),
      ...(options.signal ? [options.signal] : []),
    ]);
    let verdict: GuardVerdict = { decision: "unknown", reason: "guard_unavailable" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      if (evaluations++ >= (options.maxEvaluations ?? 100))
        verdict = { decision: "unknown", reason: "budget_exhausted" };
      else {
        signal.throwIfAborted();
        const result = await Promise.race([
          new Promise<never>((_, reject) => {
            abort = () => reject(new Error("guard_cancelled"));
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            timer = setTimeout(abort, options.timeoutMs ?? 3000);
          }),
          Promise.resolve().then(() => options.evaluate(proposal, signal)),
        ]);
        if (!signal.aborted && result && ["allow", "deny", "unknown"].includes(result.decision))
          verdict = {
            decision: result.decision,
            reason: /^[a-z0-9_]{1,80}$/.test(result.reason) ? result.reason : "guard_result",
          };
      }
    } catch {
      /* Unknown vetoes enforced input. */
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
    }
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(
          options.onObservation?.({
            proposalId: prepared.preparedId,
            policyVersion: options.policyVersion,
            operation: prepared.evidence.action,
            ...(capturedStep ? { stepId: capturedStep.id } : {}),
            mode: options.mode,
            verdict,
            dispatched:
              options.mode === "enforce" && verdict.decision !== "allow" ? false : "unknown",
          }),
        ),
        new Promise<void>((resolve) => {
          observationTimer = setTimeout(resolve, options.timeoutMs ?? 3000);
        }),
      ]);
    } catch {
      /* Observation cannot grant authority. */
    } finally {
      if (observationTimer) clearTimeout(observationTimer);
    }
    if (options.mode === "enforce" && verdict.decision !== "allow")
      throw new OwnerActionError(verdict.reason);
  }
  return {
    setStep(value: GuardStep) {
      step = value;
    },
    async beforeAuthorize(prepared: OwnerPreparedAction) {
      if (options.mode === "enforce") return evaluate(prepared);
      const task = evaluate(prepared).catch(() => {});
      pending.add(task);
      void task.then(() => pending.delete(task));
    },
    async drain() {
      await Promise.all([...pending]);
    },
  };
}
