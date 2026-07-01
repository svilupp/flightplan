// Tests for the per-run lock session (PLAN.md §5 Phase 3: read → compose → hook → write-back).
//
// Drives `openLockSession` against temp lock files (no driver needed): first-learn, auto-heal,
// frozen (no persist + fail), no-write (no persist), and imported-module composition (the L0
// hook resolving a namespaced module recipe).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockDriver } from "../driver/index.ts";
import type { ClickStep, Step } from "../flow/types.ts";
import type { ResolveContext, StepExecution } from "../ladder/index.ts";
import type { Strategy } from "../types.ts";
import { emptyLock, loadLockFile } from "./parse.ts";
import { computeMatchSignature, deriveUrlGlob } from "./signature.ts";
import { openLockSession } from "./session.ts";
import type { LockFile } from "./types.ts";
import { writeLockFile } from "./write.ts";

const inferStrategy = (_s: string): Strategy | null => "role_name";
const NOW = () => 0;
const URL = "http://localhost:3000/page";
const SIG = computeMatchSignature(`${URL}|texthash`, "/page|structhash");

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fp-locksess-"));
  tmpDirs.push(dir);
  return dir;
}

const clickStep = (over: Partial<ClickStep> = {}): Step =>
  ({ id: "s1", do: "click", target: "the button", ...over }) as ClickStep;

/** A successful L1 resolution carrying its pre-action signature basis. */
function exec(selector: string): StepExecution {
  return {
    ok: true,
    tier: "L1",
    durableSelector: selector,
    strategy: "role_name",
    escalate: false,
    signatureBasis: { sig: SIG, url: URL },
  };
}

function lockWith(source: string, selector: string): LockFile {
  const lock = emptyLock(source, "sha256:x", "");
  lock.targets.push({
    step: "s1",
    target: "the button",
    match: { url_glob: deriveUrlGlob(URL), sig: SIG },
    selector,
    strategy: "role_name",
    green_runs: 3,
  });
  return lock;
}

describe("LockSession — first learn (auto)", () => {
  test("records a new recipe and flush persists it", async () => {
    const dir = await tmp();
    const lockPath = join(dir, "flow.lock.toml");
    const session = await openLockSession({
      lockPath,
      source: "flow.toml",
      sourceHash: "sha256:x",
      mode: "auto",
      inferStrategy,
      now: NOW,
    });
    const rec = session.recordResolution(clickStep(), exec("role:button:Go"), {
      resolvedAtL0: false,
    });
    expect(rec.healed).toBe(false);
    const written = await session.flush();
    expect(written).toEqual([lockPath]);

    const onDisk = await loadLockFile(lockPath);
    expect(onDisk.targets).toHaveLength(1);
    expect(onDisk.targets[0]?.selector).toBe("role:button:Go");
    expect(onDisk.targets[0]?.green_runs).toBe(1);
  });
});

describe("LockSession — auto heal (drift)", () => {
  test("a drifted recipe heals and is persisted; prior winner demoted to candidate", async () => {
    const dir = await tmp();
    const lockPath = join(dir, "flow.lock.toml");
    await writeLockFile(lockPath, lockWith("flow.toml", "role:button:Old"));

    const session = await openLockSession({
      lockPath,
      source: "flow.toml",
      sourceHash: "sha256:x",
      mode: "auto",
      inferStrategy,
      now: NOW,
    });
    const rec = session.recordResolution(clickStep(), exec("role:button:New"), {
      resolvedAtL0: false,
    });
    expect(rec.healed).toBe(true);
    expect(rec.fail).toBe(false);
    await session.flush();

    const onDisk = await loadLockFile(lockPath);
    expect(onDisk.targets[0]?.selector).toBe("role:button:New");
    expect(onDisk.targets[0]?.candidates?.some((c) => c.selector === "role:button:Old")).toBe(true);
  });
});

describe("LockSession — frozen (CI)", () => {
  test("a drift is reported AND fails, but is NOT persisted", async () => {
    const dir = await tmp();
    const lockPath = join(dir, "flow.lock.toml");
    await writeLockFile(lockPath, lockWith("flow.toml", "role:button:Old"));

    const session = await openLockSession({
      lockPath,
      source: "flow.toml",
      sourceHash: "sha256:x",
      mode: "frozen",
      inferStrategy,
      now: NOW,
    });
    const rec = session.recordResolution(clickStep(), exec("role:button:New"), {
      resolvedAtL0: false,
    });
    expect(rec.healed).toBe(true);
    expect(rec.fail).toBe(true);
    const written = await session.flush();
    expect(written).toEqual([]);

    // The committed lock is unchanged (still the old selector).
    const onDisk = await loadLockFile(lockPath);
    expect(onDisk.targets[0]?.selector).toBe("role:button:Old");
  });
});

describe("LockSession — no-write", () => {
  test("a drift is reported but NOT persisted and does NOT fail", async () => {
    const dir = await tmp();
    const lockPath = join(dir, "flow.lock.toml");
    await writeLockFile(lockPath, lockWith("flow.toml", "role:button:Old"));

    const session = await openLockSession({
      lockPath,
      source: "flow.toml",
      sourceHash: "sha256:x",
      mode: "no-write",
      inferStrategy,
      now: NOW,
    });
    const rec = session.recordResolution(clickStep(), exec("role:button:New"), {
      resolvedAtL0: false,
    });
    expect(rec.healed).toBe(true);
    expect(rec.fail).toBe(false);
    expect(await session.flush()).toEqual([]);

    const onDisk = await loadLockFile(lockPath);
    expect(onDisk.targets[0]?.selector).toBe("role:button:Old");
  });
});

describe("LockSession — imported-module composition", () => {
  test("the L0 hook resolves a namespaced recipe from an imported module's lock", async () => {
    const dir = await tmp();
    const rootPath = join(dir, "root.lock.toml");
    const modPath = join(dir, "mod.lock.toml");
    await writeLockFile(rootPath, emptyLock("root.toml", "sha256:r", ""));
    await writeLockFile(modPath, lockWith("mod.toml", "role:button:Imported"));

    const session = await openLockSession({
      lockPath: rootPath,
      source: "root.toml",
      sourceHash: "sha256:r",
      mode: "auto",
      inferStrategy,
      now: NOW,
      imported: [{ lockPath: modPath, source: "mod.toml", sourceHash: "sha256:m", namespace: "mod" }],
      hookOptions: { namespaceFor: () => "mod" },
    });

    const ctx: ResolveContext = { driver: new MockDriver() };
    const recipe = await session.hook.lookup(clickStep(), ctx);
    expect(recipe?.selector).toBe("role:button:Imported");
    expect(recipe?.match?.sig).toBe(SIG);
  });
});
