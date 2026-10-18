import { OwnerActionDriver } from "../driver/owner-action-driver.ts";
import type { Driver } from "../driver/types.ts";
import type {
  ActionGuardOptions,
  ActionProposal,
  GuardIdentity,
  GuardStep,
  GuardStepContext,
  GuardVerdict,
} from "./types.ts";

const contexts = new WeakMap<Driver, (step: GuardStep) => void>();
const drains = new WeakMap<Driver, () => Promise<void>>();
const mutations = new Set([
  "batch",
  "goto",
  "press",
  "click",
  "fill",
  "type",
  "select",
  "check",
  "hover",
  "submit",
  "emitCommand",
  "webmcpCall",
  "evalInFrame",
  "evaluateExpression",
  "clearBrowserState",
  "switchToFrame",
  "switchToMain",
  "setDialogPolicy",
]);
const identityKeys = ["documentId", "targetId", "resourceId", "ownerEpoch", "grantToken"] as const;

export class GuardBlockedError extends Error {
  readonly dispatchState = "not_dispatched";
  constructor(readonly reason: string) {
    super(`action_guard_blocked:${reason}`);
    this.name = "GuardBlockedError";
  }
}
export function isGuardedDriver(driver: Driver): boolean {
  return contexts.has(driver);
}
export function setGuardStep(driver: Driver, step: GuardStep): void {
  contexts.get(driver)?.(step);
}
export async function drainGuardObservations(driver: Driver): Promise<void> {
  await drains.get(driver)?.();
}

async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("guard_unavailable"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
      Promise.resolve().then(work),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "unknown";
}

function selectorsFor(operation: string, args: unknown[]): string[] {
  const selector =
    operation === "batch"
      ? (args[0] as Array<{ selector?: unknown }> | undefined)?.[0]?.selector
      : ["click", "fill", "type", "select", "check", "hover", "submit", "switchToFrame"].includes(
            operation,
          )
        ? args[0]
        : undefined;
  return typeof selector === "string"
    ? [selector]
    : Array.isArray(selector)
      ? selector.filter((s): s is string => typeof s === "string")
      : [];
}

/** Guard the driver boundary, including warm replay, repair and direct verbs. */
export function createGuardedDriver(
  driver: Driver,
  options: ActionGuardOptions,
  redact: (text: string) => string,
): Driver {
  if (driver instanceof OwnerActionDriver) {
    const restriction = driver.installActionGuard(options, redact);
    contexts.set(driver, (step) => restriction.setStep(step));
    drains.set(driver, () => restriction.drain());
    return driver;
  }
  let context: GuardStepContext | undefined;
  let evaluations = 0;
  let cachedText = "";
  let cachedUrl = "";
  let observedAt = 0;
  const pending = new Set<Promise<void>>();
  const observe = async (
    proposal: ActionProposal,
    verdict: GuardVerdict,
    dispatched: boolean | "unknown",
  ) => {
    try {
      await bounded(
        async () => {
          await options.onObservation?.({
            proposalId: proposal.id,
            policyVersion: options.policyVersion,
            operation: proposal.operation,
            ...(proposal.stepId ? { stepId: proposal.stepId } : {}),
            mode: options.mode,
            verdict,
            dispatched,
          });
        },
        AbortSignal.timeout(options.timeoutMs ?? 3000),
      );
    } catch {
      // Observation failures cannot change authorization or an authoritative action.
    }
  };
  const proxy = new Proxy(driver, {
    get(target, property) {
      if (property === "page" && options.mode === "enforce")
        return () => {
          throw new GuardBlockedError("raw_page_unavailable");
        };
      const member = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      if (property === "snapshot")
        return async (...args: unknown[]) => {
          const snapshot = await member.apply(target, args);
          cachedText = redact(JSON.stringify(snapshot.accessibilityTree));
          cachedUrl = redact(snapshot.url ?? cachedUrl);
          observedAt = Date.now();
          return snapshot;
        };
      if (property === "currentUrl")
        return async () => {
          const url = await member.call(target);
          cachedUrl = redact(url);
          return url;
        };
      if (typeof property !== "string" || !mutations.has(property)) return member.bind(target);
      return async (...args: unknown[]) => {
        if (property === "setDialogPolicy") {
          if (options.mode === "enforce" && !["dismiss", "fail"].includes(stringValue(args[0])))
            throw new GuardBlockedError("unguarded_dialog_policy");
          return member.apply(target, args);
        }
        const proposal: ActionProposal = {
          version: 1,
          id: crypto.randomUUID(),
          policyVersion: options.policyVersion,
          operation: property,
          action:
            property === "batch"
              ? stringValue((args[0] as Array<{ action?: unknown }> | undefined)?.[0]?.action)
              : property,
          ...(property === "webmcpCall"
            ? {
                tool: redact(stringValue((args[0] as { tool?: unknown } | undefined)?.tool)),
              }
            : {}),
          ...(property === "press" ? { key: redact(stringValue(args[0])) } : {}),
          ...(property === "goto" ? { navigationUrl: redact(stringValue(args[0])) } : {}),
          ...(context
            ? { stepId: context.id, intent: context.intent, effect: context.effect }
            : {}),
          selectors: selectorsFor(property, args).map(redact),
          payload: [
            "batch",
            "fill",
            "type",
            "select",
            "webmcpCall",
            "emitCommand",
            "evalInFrame",
            "evaluateExpression",
          ].includes(property)
            ? "redacted"
            : "none",
          evidence: { url: cachedUrl, frame: driver.currentFrame(), text: cachedText, observedAt },
        };
        cachedText = "";
        const signal = AbortSignal.any([
          AbortSignal.timeout(options.timeoutMs ?? 3000),
          ...(options.signal ? [options.signal] : []),
        ]);
        const assess = async (): Promise<GuardVerdict> => {
          try {
            if (property === "batch" && (!Array.isArray(args[0]) || args[0].length !== 1))
              return { decision: "unknown", reason: "multi_action_batch" };
            if (evaluations >= (options.maxEvaluations ?? 100))
              return { decision: "unknown", reason: "budget_exhausted" };
            evaluations++;
            const result = await bounded(async () => {
              if (options.identify) {
                const identity = await options.identify({
                  operation: property,
                  args,
                  driver,
                  signal,
                });
                if (
                  !identity ||
                  !identityKeys.every(
                    (key) =>
                      Object.hasOwn(identity, key) &&
                      typeof identity[key] === "string" &&
                      identity[key].trim().length > 0,
                  )
                )
                  throw new Error("identity_unavailable");
                proposal.evidence.identity = Object.fromEntries(
                  identityKeys.map((key) => [key, redact(identity[key])]),
                ) as unknown as GuardIdentity;
              }
              signal.throwIfAborted();
              return options.evaluate(proposal, signal);
            }, signal);
            return result && ["allow", "deny", "unknown"].includes(result.decision)
              ? {
                  decision: result.decision,
                  reason: /^[a-z0-9_]{1,80}$/.test(result.reason) ? result.reason : "guard_result",
                }
              : { decision: "unknown", reason: "invalid_result" };
          } catch {
            return { decision: "unknown", reason: "guard_unavailable" };
          }
        };
        if (options.mode === "shadow") {
          const authoritative = Promise.resolve()
            .then(() => member.apply(target, args))
            .then(
              (value: unknown) => ({ ok: true as const, value }),
              (error: unknown) => ({ ok: false as const, error }),
            );
          const task = assess()
            .then(async (verdict) => {
              const outcome = await authoritative;
              await observe(proposal, verdict, outcome.ok ? true : "unknown");
            })
            .catch(() => {});
          pending.add(task);
          void task.then(() => pending.delete(task));
          const outcome = await authoritative;
          if (!outcome.ok) throw outcome.error;
          return outcome.value;
        }
        let verdict = await assess();
        if (signal.aborted) verdict = { decision: "unknown", reason: "cancelled" };
        if (verdict.decision !== "allow") {
          await observe(proposal, verdict, false);
          throw new GuardBlockedError(verdict.reason);
        }
        if (!options.dispatch) {
          verdict = { decision: "unknown", reason: "atomic_dispatch_unavailable" };
          await observe(proposal, verdict, false);
          throw new GuardBlockedError(verdict.reason);
        }
        const invocation = { operation: property, args, driver, signal };
        const required = options.requiredAssurance ?? "renderer-same-task-dom";
        const assurance = options.dispatchAssurance?.(invocation);
        if (assurance !== required) {
          verdict = { decision: "unknown", reason: "dispatch_assurance_unavailable" };
          await observe(proposal, verdict, false);
          throw new GuardBlockedError(verdict.reason);
        }
        const result = await options.dispatch(proposal, {
          operation: property,
          args,
          driver,
          signal,
        });
        await observe(proposal, verdict, true);
        return result;
      };
    },
  });
  contexts.set(proxy, (step) => {
    context = {
      id: step.id,
      effect: step.effect,
      intent: redact(
        typeof step.target === "string"
          ? step.target
          : Array.isArray(step.target)
            ? step.target.join(" | ")
            : step.do,
      ),
    };
  });
  drains.set(proxy, async () => {
    await Promise.all([...pending]);
  });
  return proxy;
}
