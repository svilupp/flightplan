// Flightplan — generic append-only JSONL writer.
//
// The shared low-level primitive the run/trace/ai writers build on. One JSON object per line,
// newline-terminated. The file is opened lazily on the first write and kept open via a
// Node/Bun `FileHandle` (one append fd) for cheap per-event appends; `close()` flushes and
// releases it.
//
// Async-safety: `write()` chains every append onto a single internal promise so concurrent
// callers can never interleave bytes or race the lazy open. Each `write()` resolves only once
// its own line has been handed to the OS, so callers can await durability per event if they
// want, or fire-and-forget and `close()` at the end.
//
// This module is deliberately untyped at the payload level (`JsonlValue`) — the typed event
// shaping lives in `writers.ts`. Keep it dependency-light: only `node:fs/promises`.

import { open, type FileHandle } from "node:fs/promises";

/**
 * A JSON-serializable event object. Any non-null object is accepted — the writer only requires
 * that `JSON.stringify` succeeds. Declared as `object` (rather than `Record<string, unknown>`)
 * so the typed event INTERFACES in events.ts (which lack an implicit index signature) pass
 * through without a cast.
 */
export type JsonlValue = object;

/**
 * An append-only newline-delimited JSON writer over a single file.
 *
 * Construct with a path; the file is created (and opened in append mode) on the first
 * `write()`. Safe to `write()` from concurrent callers. Always `close()` when done.
 */
export class JsonlWriter {
  readonly path: string;
  private handle: FileHandle | null = null;
  /** Serializes opens + appends so lines never interleave and the open never races. */
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(path: string) {
    this.path = path;
  }

  /** Open the append fd if not already open. Called under the serialized `tail`. */
  private async ensureOpen(): Promise<FileHandle> {
    if (this.handle === null) {
      // "a" = append, create if missing. Each writer owns its own fd for its run dir.
      this.handle = await open(this.path, "a");
    }
    return this.handle;
  }

  /**
   * Append one event as a single JSONL line. Resolves once the line has been written to the
   * fd. Rejects if called after {@link close}, or if serialization/IO fails.
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
      const handle = await this.ensureOpen();
      await handle.write(line);
    });
    // Keep the chain alive even if this write rejects, so later writes still run in order.
    this.tail = next.catch(() => {});
    return next;
  }

  /**
   * Flush any pending writes and close the fd. Idempotent. After close, `write()` rejects.
   * Awaits the full write chain so all queued lines are durable before the fd is released.
   */
  async close(): Promise<void> {
    if (this.closed) {
      await this.tail;
      return;
    }
    this.closed = true;
    // Wait for all queued appends to drain, then close the fd if it was ever opened.
    await this.tail;
    if (this.handle !== null) {
      await this.handle.close();
      this.handle = null;
    }
  }
}
