// Flightplan — generic append-only JSONL writer.
//
// The shared low-level primitive the run/trace/ai writers build on. One JSON object per line,
// newline-terminated. Appends go through the injected {@link FileSystemPort} — no `node:fs` fd
// is opened here, so this writer runs anywhere the port can (e.g. Cloudflare Workers).
//
// Async-safety: `write()` chains every append onto a single internal promise so concurrent
// callers can never interleave bytes or race the port. Each `write()` resolves only once its
// own line has been handed to the port, so callers can await durability per event if they
// want, or fire-and-forget and `close()` at the end.
//
// This module is deliberately untyped at the payload level (`JsonlValue`) — the typed event
// shaping lives in `writers.ts`.

import type { FileSystemPort } from "../runtime.ts";

/**
 * A JSON-serializable event object. Any non-null object is accepted — the writer only requires
 * that `JSON.stringify` succeeds. Declared as `object` (rather than `Record<string, unknown>`)
 * so the typed event INTERFACES in events.ts (which lack an implicit index signature) pass
 * through without a cast.
 */
export type JsonlValue = object;

/**
 * An append-only newline-delimited JSON writer over a single file, backed by an injected
 * {@link FileSystemPort}. Safe to `write()` from concurrent callers. `close()` is a no-op
 * beyond draining the write queue — there is no fd to release (each append round-trips through
 * `fs.appendTextFile`; accepted perf tradeoff, see PLAN §2.5).
 */
export class JsonlWriter {
  readonly path: string;
  /** Serializes appends so lines never interleave. */
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly fs: FileSystemPort;

  constructor(path: string, fs: FileSystemPort) {
    this.path = path;
    this.fs = fs;
  }

  /**
   * Append one event as a single JSONL line. Resolves once the line has been handed to the
   * port. Rejects if called after {@link close}, or if serialization/IO fails.
   */
  write(event: JsonlValue): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(`JsonlWriter(${this.path}): write after close`));
    }
    // Serialize OUTSIDE the chain so a stringify error rejects this call without poisoning the
    // tail for subsequent writers.
    let line: string;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch (err) {
      return Promise.reject(
        new Error(
          `JsonlWriter(${this.path}): failed to serialize event: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }

    const next = this.tail.then(async () => {
      await this.fs.appendTextFile(this.path, line);
    });
    // Keep the chain alive even if this write rejects, so later writes still run in order.
    this.tail = next.catch(() => {});
    return next;
  }

  /**
   * Flush any pending writes. Idempotent. After close, `write()` rejects. Awaits the full write
   * chain so all queued lines are durable before resolving.
   */
  async close(): Promise<void> {
    if (this.closed) {
      await this.tail;
      return;
    }
    this.closed = true;
    await this.tail;
  }
}
