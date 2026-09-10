import type { Driver } from "../driver/types.ts";
import type { RunOptions } from "./types.ts";

/** Interruption is an embedding error, separate from a workflow/assertion verdict. */
export class RunInterruptedError extends Error {
  readonly code: "RUN_CANCELLED" | "RUN_TIMEOUT";
  /** Writes dispatched before interruption may still commit; reconcile before retrying. */
  pendingWrites: string[] = [];
  /** These calls may have produced effects, even if their replies never arrived. */
  pendingBrowserOperations: string[] = [];
  cleanup: "completed" | "failed" | "pending" = "pending";

  constructor(readonly reason: "cancelled" | "timeout") {
    super(reason === "timeout" ? "Flightplan run deadline exceeded" : "Flightplan run cancelled");
    this.name = "RunInterruptedError";
    this.code = reason === "timeout" ? "RUN_TIMEOUT" : "RUN_CANCELLED";
  }
}

function validateTimeout(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 2_147_483_647)) {
    throw new RangeError(`${name} must be an integer between 1 and 2147483647`);
  }
}

/** One local execution fence. It cannot undo remote effects or cancel non-cooperative ports. */
export class RunControl {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  private readonly pending = new Set<{ kind: string; name: string }>();
  private readonly timeout: ReturnType<typeof setTimeout> | undefined;
  private readonly deadline: number | undefined;
  private readonly externalSignal: AbortSignal | undefined;
  private readonly abort = (): void => this.interrupt("cancelled");
  private readonly stopped: Promise<never>;
  private rejectStopped!: (error: RunInterruptedError) => void;
  private error: RunInterruptedError | undefined;
  private driver: Driver | undefined;
  private connection: Promise<unknown> | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private readonly cleanupTimeoutMs: number;

  constructor(opts: Pick<RunOptions, "signal" | "timeoutMs" | "cleanupTimeoutMs">) {
    validateTimeout(opts.timeoutMs, "timeoutMs");
    validateTimeout(opts.cleanupTimeoutMs, "cleanupTimeoutMs");
    this.cleanupTimeoutMs = opts.cleanupTimeoutMs ?? 1000;
    this.deadline = opts.timeoutMs === undefined ? undefined : Date.now() + opts.timeoutMs;
    this.stopped = new Promise((_, reject) => {
      this.rejectStopped = reject;
    });
    // A pre-aborted signal can fire before the runner has attached its race.
    void this.stopped.catch(() => {});
    this.externalSignal = opts.signal;
    opts.signal?.addEventListener("abort", this.abort, { once: true });
    if (opts.signal?.aborted) this.abort();
    if (opts.timeoutMs !== undefined) {
      this.timeout = setTimeout(() => this.interrupt("timeout"), opts.timeoutMs);
    }
  }

  private interrupt(reason: "cancelled" | "timeout"): void {
    if (this.error) return;
    const error = new RunInterruptedError(reason);
    error.pendingWrites = [
      ...new Set([...this.pending].filter((p) => p.kind === "write").map((p) => p.name)),
    ];
    error.pendingBrowserOperations = [
      ...new Set([...this.pending].filter((p) => p.kind === "browser").map((p) => p.name)),
    ];
    this.error = error;
    this.rejectStopped(error);
    this.controller.abort(error);
  }

  check(): void {
    // Immediate VFS promises can starve the timer queue. Check elapsed time at each boundary
    // as well, including after synchronous parsing/hash work and before admitting new calls.
    if (!this.error && this.deadline !== undefined && Date.now() >= this.deadline) {
      this.interrupt("timeout");
    }
    if (this.error) throw this.error;
  }

  async wait<T>(work: () => T | Promise<T>): Promise<T> {
    this.check();
    const value = await Promise.race([
      Promise.resolve().then(() => {
        this.check();
        return work();
      }),
      this.stopped,
    ]);
    this.check();
    return value;
  }

  /** Preserve optional and synchronous methods, receiver binding, and class/private state. */
  guard<T extends object>(
    target: T,
    kind: "fs" | "browser" | "clock" | "ai",
    children: readonly string[] = [],
  ): T {
    // An empty facade permits wrapping even frozen ports; methods still run on the original
    // receiver so private fields work. No host instance is mutated or shallow-copied.
    const facade: T = Object.create(target);
    return new Proxy(facade, {
      get: (_, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (children.includes(String(key)) && value !== null && typeof value === "object") {
          return this.guard(value, kind);
        }
        if (typeof value !== "function") return value;
        if (kind === "browser" && key === "teardown") return () => this.cleanup();
        return (...args: unknown[]) => {
          this.check();
          const name = String(key);
          const writing = kind === "fs" && /^(write|append|mkdir)/.test(name);
          const operation = {
            kind: writing ? "write" : kind,
            name: writing ? String(args[0]) : name,
          };
          this.pending.add(operation);
          let result: unknown;
          try {
            result = Reflect.apply(value, target, args);
          } catch (error) {
            this.pending.delete(operation);
            throw error;
          }
          if (
            result &&
            typeof result === "object" &&
            "then" in result &&
            typeof result.then === "function"
          ) {
            const completion = Promise.resolve(result).finally(() =>
              this.pending.delete(operation),
            );
            void completion.catch(() => {});
            if (kind === "browser" && key === "connect") this.connection = completion;
            return this.wait(() => completion);
          }
          this.pending.delete(operation);
          this.check();
          return result;
        };
      },
    });
  }

  attach(driver: Driver): Driver {
    this.driver = driver;
    this.check();
    return this.guard(driver, "browser");
  }

  /** Wait for a late connect before teardown so it cannot attach a browser after cleanup. */
  private cleanup(): Promise<void> {
    this.cleanupPromise ??= (async () => {
      try {
        await this.connection;
      } catch {
        /* A failed connect can still need cleanup. */
      }
      await this.driver?.teardown();
    })();
    return this.cleanupPromise;
  }

  async interrupted(maskedError?: unknown): Promise<never> {
    const error = this.error!;
    // A genuine harness error can race the interrupt signal/deadline and be discarded when the
    // caller falls back to this cancellation path. Preserve it as `cause` so it is not lost.
    if (maskedError !== undefined && maskedError !== error && error.cause === undefined) {
      error.cause = maskedError;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      error.cleanup = await Promise.race([
        this.cleanup().then(
          () => "completed" as const,
          () => "failed" as const,
        ),
        new Promise<"pending">((resolve) => {
          timer = setTimeout(() => resolve("pending"), this.cleanupTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    throw error;
  }

  get interruptedError(): RunInterruptedError | undefined {
    return this.error;
  }

  dispose(): void {
    clearTimeout(this.timeout);
    this.externalSignal?.removeEventListener("abort", this.abort);
  }
}
