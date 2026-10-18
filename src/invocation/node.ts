import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult } from "../runner/types.ts";
import { sha256Text } from "../runtime.ts";
import {
  existingClaim,
  InvocationError,
  type InvocationRecord,
  type InvocationStore,
} from "./index.ts";

type Stored = InvocationRecord & { token: string };
/** Exclusive creation claims ownership. An unreadable partial claim is conservatively busy. */
export class NodeInvocationStore implements InvocationStore {
  constructor(readonly directory: string) {}
  private path(key: string) {
    return join(this.directory, `${sha256Text(key)}.json`);
  }
  private async durable(path: string, text: string) {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private async syncDirectory() {
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async claim(key: string, binding: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    try {
      await this.durable(this.path(key), JSON.stringify({ binding, token, state: "running" }));
      await this.syncDirectory();
      return { status: "claimed" as const, token };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      try {
        return existingClaim(JSON.parse(await readFile(this.path(key), "utf8")) as Stored, binding);
      } catch {
        return { status: "needs_reconciliation" as const };
      }
    }
  }
  private async update(key: string, token: string, mutate: (record: Stored) => void) {
    const record = JSON.parse(await readFile(this.path(key), "utf8")) as Stored;
    if (record.token !== token || record.state === "completed")
      throw new InvocationError("INVOCATION_STALE_CLAIM");
    mutate(record);
    const temporary = `${this.path(key)}.${randomUUID()}.tmp`;
    try {
      await this.durable(temporary, JSON.stringify(record));
      await rename(temporary, this.path(key));
      await this.syncDirectory();
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async dispatchPending(key: string, token: string) {
    await this.update(key, token, (record) => {
      record.state = "dispatch_pending";
    });
  }
  async finish(key: string, token: string, result: RunResult) {
    await this.update(key, token, (record) => {
      record.state = "completed";
      record.result = result;
    });
  }
  async fail(key: string, token: string) {
    await this.update(key, token, (record) => {
      record.state = "needs_reconciliation";
    });
  }
}
