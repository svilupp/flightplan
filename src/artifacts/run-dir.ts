// Flightplan — run directory management.
//
// Creates a per-run directory and returns a handle of resolved absolute paths the rest of the
// artifacts layer (and the runner) program against. The layout (PLAN.md §5 Phase 2/4/5):
//
//   <base>/<runId>/
//     run.jsonl            (run/step/assertion lifecycle — Phase 2)
//     trace.jsonl          (browser actions / resolution attempts — Phase 2)
//     ai.jsonl             (model calls — created lazily by Phase 4)
//     screenshots/         (dir — Phase 5)
//     proposed-patches/    (dir — Phase 5)
//     video.webm           (opt-in video — Phase 5; created lazily by the driver when
//                           `[browser] record` is on and bp produces a video — see Unit F)
//     summary.json         (final run summary)
//
// Base dir defaults to `.flightplan-runs/` (gitignored per the scaffold) and is overridden by
// the CLI `-o`/`--out` flag (ParsedArgs.out → `createRun({ baseDir })`).
//
// Determinism: `runId` generation takes an injectable clock (`now()`) and id source
// (`genId()`), defaulting to the real wall clock + crypto random. Tests inject fixed ones so
// runIds and the directory name are reproducible (this module's brief; PLAN.md determinism
// note).
//
// Dependency-light: only `node:fs/promises` + `node:path`.

import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** The default base directory for run artifacts. Gitignored by the scaffold. */
export const DEFAULT_BASE_DIR = ".flightplan-runs";

/** Names of the artifact files/dirs inside a run directory. Single source of truth. */
export const RUN_FILES = {
  run: "run.jsonl",
  trace: "trace.jsonl",
  ai: "ai.jsonl",
  summary: "summary.json",
  // Opt-in video artifact (Phase 5, Unit F). The path is always resolved so callers have a
  // stable target; the file itself is created lazily by the driver only when `[browser] record`
  // is enabled AND browser-pilot produces a video (graceful no-op otherwise — Risk V1).
  video: "video.webm",
} as const;

export const RUN_DIRS = {
  screenshots: "screenshots",
  proposedPatches: "proposed-patches",
} as const;

/**
 * Resolved, absolute paths for one run. Returned by {@link createRun} and held by the runner.
 * `aiJsonl` is a path only — the file is created lazily when the first ai event is written
 * (Phase 4); the `screenshots/` and `proposed-patches/` dirs ARE created eagerly so callers
 * can drop files in without a mkdir race (Phase 5).
 */
export interface RunDir {
  /** The generated run id (also the leaf directory name). */
  runId: string;
  /** Absolute path to the run directory `<base>/<runId>`. */
  dir: string;
  /** Absolute path to `<base>` (the resolved base dir). */
  baseDir: string;
  runJsonl: string;
  traceJsonl: string;
  aiJsonl: string;
  summaryJson: string;
  screenshotsDir: string;
  proposedPatchesDir: string;
  /**
   * Absolute path to the opt-in video artifact `<dir>/video.webm` (Phase 5, Unit F). Always
   * resolved (so the runner has a stable path to hand the driver / put in the summary); the
   * file is created lazily by the driver only when `[browser] record` is on and bp emits a
   * video. When no video is produced, `RunSummary.video_path` stays `null` (graceful degrade).
   */
  videoWebm: string;
}

/** Options for {@link createRun}. All optional; defaults are production-real. */
export interface CreateRunOptions {
  /** Base dir; the CLI passes `ParsedArgs.out` here. Defaults to `.flightplan-runs/`. */
  baseDir?: string;
  /**
   * Resolve `baseDir` relative to this cwd (absolute base dirs are used as-is). Defaults to
   * `process.cwd()`. Tests pass a temp dir so nothing touches the real repo.
   */
  cwd?: string;
  /** Injected millisecond clock for the runId timestamp. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Injected id source for the runId's short random/sequence suffix. Defaults to an 8-char
   * lowercase base36 token from `crypto.getRandomValues`. Tests inject a fixed value.
   */
  genId?: () => string;
  /** Override the whole runId (skips generation entirely). Useful for resume/tests. */
  runId?: string;
}

/** Default short-id source: 8 lowercase base36 chars from CSPRNG bytes. */
function defaultGenId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) {
    out += (b % 36).toString(36);
  }
  return out;
}

/**
 * Build a sortable, filesystem-safe run id: `YYYYMMDDTHHMMSSmmm-<shortId>`.
 *
 * The timestamp prefix (from the injected clock, UTC) makes run dirs sort chronologically; the
 * short-id suffix disambiguates runs within the same millisecond. Both inputs are injectable
 * so tests get a stable id.
 */
export function makeRunId(now: () => number, genId: () => string): string {
  const d = new Date(now());
  const p2 = (n: number) => String(n).padStart(2, "0");
  const p3 = (n: number) => String(n).padStart(3, "0");
  const stamp =
    `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}` +
    p3(d.getUTCMilliseconds());
  return `${stamp}-${genId()}`;
}

/**
 * Resolve (without creating) the paths for a run. Pure: no IO. Useful for tests and for the
 * CLI to display where artifacts WILL go before the run starts.
 */
export function resolveRunDir(options: CreateRunOptions = {}): RunDir {
  const cwd = options.cwd ?? process.cwd();
  const rawBase = options.baseDir ?? DEFAULT_BASE_DIR;
  const baseDir = isAbsolute(rawBase) ? rawBase : resolve(cwd, rawBase);
  const runId = options.runId ?? makeRunId(options.now ?? Date.now, options.genId ?? defaultGenId);
  const dir = join(baseDir, runId);
  return {
    runId,
    dir,
    baseDir,
    runJsonl: join(dir, RUN_FILES.run),
    traceJsonl: join(dir, RUN_FILES.trace),
    aiJsonl: join(dir, RUN_FILES.ai),
    summaryJson: join(dir, RUN_FILES.summary),
    screenshotsDir: join(dir, RUN_DIRS.screenshots),
    proposedPatchesDir: join(dir, RUN_DIRS.proposedPatches),
    videoWebm: join(dir, RUN_FILES.video),
  };
}

/**
 * Create a run directory and its eager subdirectories, returning resolved {@link RunDir}
 * paths. Creates `<base>/<runId>/`, `screenshots/`, and `proposed-patches/` (recursively).
 * The JSONL files and `summary.json` are NOT created here — the JSONL writers open them
 * lazily on first write and {@link import("./writers.ts")} writes the summary at the end.
 */
export async function createRun(options: CreateRunOptions = {}): Promise<RunDir> {
  const runDir = resolveRunDir(options);
  // `recursive: true` creates `<base>` and `<base>/<runId>` in one go and is a no-op if they
  // already exist.
  await mkdir(runDir.dir, { recursive: true });
  await Promise.all([
    mkdir(runDir.screenshotsDir, { recursive: true }),
    mkdir(runDir.proposedPatchesDir, { recursive: true }),
  ]);
  return runDir;
}
