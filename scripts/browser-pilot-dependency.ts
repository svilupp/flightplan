#!/usr/bin/env bun

/**
 * FP-07 browser-pilot dependency guard.
 *
 * This script deliberately owns only Flightplan-local state. `link` changes the local
 * node_modules entry and preserves an existing copied package by moving it aside. `packed`
 * stages the package in a temporary directory, packs it there, and runs a temporary consumer
 * against the tarball. It never runs install/build in either repository.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export const BROWSER_PILOT_PACKAGE = "browser-pilot";

export type DependencyKind = "symlink" | "copy" | "file";

export interface PackageProvenance {
  lexicalPath: string;
  realPath: string;
  kind: DependencyKind;
  version: string;
  packageHash: string;
  sourceCommit?: string;
  sourceDirty?: boolean;
  sourceHash?: string;
  buildFreshness: "fresh" | "stale" | "unknown";
  buildFreshnessDetail: string;
}

export interface ApiCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface ApiCompatibility {
  ok: boolean;
  checks: ApiCheck[];
}

export interface VerificationReport {
  ok: boolean;
  errors: string[];
  installed?: PackageProvenance;
  source?: PackageProvenance;
  api?: ApiCompatibility;
  packedHash?: string;
}

export const API_CONTRACTS = [
  {
    label: "dispatch metadata",
    patterns: [/dispatchState/, /retrySafe/, /matchedConditions/],
    detail: "StepResult exposes dispatchState, retrySafe, and matchedConditions.",
  },
  {
    label: "navigation-loss receipt",
    patterns: [/navigationObserved/, /waitUntil/],
    detail: "action receipts and navigation actions expose navigation-loss evidence.",
  },
  {
    label: "explicit-target failure",
    patterns: [/TargetNotFoundError/, /targetUrl/, /fallbackToBestTarget/],
    detail: "explicit target constraints have a fail-closed error and opt-in fallback.",
  },
  {
    label: "semantic readiness",
    patterns: [/waitForReady/, /ReadinessDiagnostics/],
    detail: "Page exposes waitForReady and readiness diagnostics.",
  },
  {
    label: "detached-ref recovery",
    patterns: [/detached/, /recoverStaleRef/],
    detail: "detached-node classification and stale-ref recovery are present.",
  },
  {
    label: "popup target contract",
    patterns: [/listTargets/, /newPage/, /targetId/],
    detail: "popup discovery can preserve opener/target identity.",
  },
] as const;

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  files?: string[];
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface SourceConfig {
  dependencySpec: string;
  sourceRoot?: string;
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readPackageJson(root: string): Promise<PackageJson> {
  return readJson<PackageJson>(join(root, "package.json"));
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      result.push(path);
    }
  }
  return result.sort();
}

async function optionalFiles(root: string): Promise<string[]> {
  try {
    return await listFiles(root);
  } catch (error) {
    if (isMissingError(error)) return [];
    throw error;
  }
}

async function hashFiles(root: string, files: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of files.sort()) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function packageContentHash(root: string): Promise<string> {
  const packageJson = join(root, "package.json");
  const distFiles = await optionalFiles(join(root, "dist"));
  return hashFiles(root, [packageJson, ...distFiles]);
}

async function sourceContentHash(root: string): Promise<string | undefined> {
  const sourceFiles = await optionalFiles(join(root, "src"));
  if (sourceFiles.length === 0) return undefined;
  const supportingFiles = ["package.json", "tsconfig.json", "tsup.config.ts"]
    .map((name) => join(root, name))
    .filter((path) => Bun.file(path).size > 0);
  return hashFiles(root, [...sourceFiles, ...supportingFiles]);
}

function gitValue(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

async function buildFreshness(root: string): Promise<{
  status: PackageProvenance["buildFreshness"];
  detail: string;
}> {
  const sourceFiles = await optionalFiles(join(root, "src"));
  const distFiles = await optionalFiles(join(root, "dist"));
  if (sourceFiles.length === 0 || distFiles.length === 0) {
    return {
      status: "unknown",
      detail: "source or dist files are unavailable; freshness cannot be established",
    };
  }

  const sourceStats = await Promise.all(sourceFiles.map((path) => stat(path)));
  const distStats = await Promise.all(distFiles.map((path) => stat(path)));
  const latestSource = Math.max(...sourceStats.map((item) => item.mtimeMs));
  const earliestDist = Math.min(...distStats.map((item) => item.mtimeMs));
  if (latestSource > earliestDist) {
    return {
      status: "stale",
      detail:
        "at least one source file is newer than the oldest generated dist file; rebuild browser-pilot in its own repository before using this package",
    };
  }
  return {
    status: "fresh",
    detail: "source and generated dist timestamps are consistent",
  };
}

export async function classifyDependencyPath(path: string): Promise<DependencyKind> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "copy";
  return "file";
}

export async function inspectPackage(
  lexicalPath: string,
  kindOverride?: DependencyKind,
): Promise<PackageProvenance> {
  const kind = kindOverride ?? (await classifyDependencyPath(lexicalPath));
  const realPath = await realpath(lexicalPath);
  const packageJson = await readPackageJson(realPath);
  if (packageJson.name !== BROWSER_PILOT_PACKAGE) {
    throw new Error(
      `Expected ${BROWSER_PILOT_PACKAGE} at ${realPath}, found ${packageJson.name ?? "unnamed package"}`,
    );
  }
  if (!packageJson.version) throw new Error(`browser-pilot at ${realPath} has no package version`);

  const freshness = await buildFreshness(realPath);
  const sourceCommit = gitValue(realPath, ["rev-parse", "HEAD"]);
  const sourceDirty =
    sourceCommit !== undefined ? gitValue(realPath, ["status", "--porcelain"]) !== "" : undefined;
  const sourceHash = await sourceContentHash(realPath);

  return {
    lexicalPath,
    realPath,
    kind,
    version: packageJson.version,
    packageHash: await packageContentHash(realPath),
    ...(sourceCommit ? { sourceCommit } : {}),
    ...(sourceDirty !== undefined ? { sourceDirty } : {}),
    ...(sourceHash ? { sourceHash } : {}),
    buildFreshness: freshness.status,
    buildFreshnessDetail: freshness.detail,
  };
}

export function sourceConfigFromPackage(packageJson: PackageJson, repoRoot: string): SourceConfig {
  const dependencySpec = packageJson.dependencies?.[BROWSER_PILOT_PACKAGE];
  if (!dependencySpec) {
    throw new Error(`package.json has no ${BROWSER_PILOT_PACKAGE} dependency`);
  }
  if (!dependencySpec.startsWith("file:")) return { dependencySpec };
  const sourcePath = dependencySpec.slice("file:".length);
  return {
    dependencySpec,
    sourceRoot: resolve(repoRoot, sourcePath),
  };
}

async function installedPackagePath(repoRoot: string): Promise<string> {
  const direct = join(repoRoot, "node_modules", BROWSER_PILOT_PACKAGE);
  try {
    await lstat(direct);
    return direct;
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }

  const requireFromFlightplan = createRequire(join(repoRoot, "package.json"));
  const entry = requireFromFlightplan.resolve(BROWSER_PILOT_PACKAGE);
  let cursor = dirname(entry);
  while (cursor !== dirname(cursor)) {
    if (await Bun.file(join(cursor, "package.json")).exists()) return cursor;
    cursor = dirname(cursor);
  }
  throw new Error(`Could not locate the installed ${BROWSER_PILOT_PACKAGE} package from ${entry}`);
}

async function declarationText(root: string): Promise<string> {
  const declarations = (await optionalFiles(join(root, "dist"))).filter((path) =>
    path.endsWith(".d.ts"),
  );
  if (declarations.length === 0) return "";
  return (await Promise.all(declarations.map((path) => readFile(path, "utf8")))).join("\n");
}

export async function checkApiCompatibility(root: string): Promise<ApiCompatibility> {
  const declarations = await declarationText(root);
  const checks = API_CONTRACTS.map((contract) => {
    const missing = contract.patterns.filter((pattern) => !pattern.test(declarations));
    return {
      label: contract.label,
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? contract.detail
          : `missing declaration markers: ${missing.map((pattern) => pattern.toString()).join(", ")}`,
    };
  });
  return { ok: checks.every((check) => check.ok), checks };
}

export function boundaryConsumerTypeScript(): string {
  return `
import * as bp from "browser-pilot";
import type { Browser as BrowserType, Page as PageType, PageOptions, Step, StepResult } from "browser-pilot";

type DispatchState = NonNullable<StepResult["dispatchState"]>;
type Receipt = NonNullable<StepResult["receipt"]>;
type ReadyOptions = Parameters<PageType["waitForReady"]>[0];
type TargetError = InstanceType<typeof bp.TargetNotFoundError>;
type PopupPage = ReturnType<BrowserType["newPage"]>;
type PopupTargets = ReturnType<BrowserType["listTargets"]>;

const dispatchState: DispatchState = "uncertain";
const receipt: Receipt = {
  dispatchState,
  retrySafe: false,
  inputEventsSent: [],
  navigationObserved: true,
};
const matchedConditions: NonNullable<StepResult["matchedConditions"]> = [];
const detached: NonNullable<StepResult["failureReason"]> = "detached";
const step: Step = {
  action: "waitForReady",
  selector: "#ready",
  waitUntil: "load",
  effect: "at_most_once",
};
const ready: ReadyOptions = {
  any: ["#ready"],
  loadingHidden: ".loading",
  stableForMs: 10,
};
const target: PageOptions = {
  targetUrl: "https://expected.example",
  fallbackToBestTarget: false,
};
const missingTarget: TargetError | undefined = undefined;
const popupPage: PopupPage | undefined = undefined;
const popupTargets: PopupTargets | undefined = undefined;

if (dispatchState !== "uncertain" || receipt.retrySafe !== false || detached !== "detached") {
  throw new Error("dispatch metadata or detached-node contract changed");
}
if (!step || !ready || !target || missingTarget !== undefined || popupPage !== undefined || popupTargets !== undefined || matchedConditions.length !== 0) {
  throw new Error("packed boundary type contract was not exercised");
}
`;
}

export function boundaryConsumerJavaScript(): string {
  return `
import * as bp from "browser-pilot";

const requiredRuntime = [
  ["Browser.fromCDP", typeof bp.Browser.fromCDP === "function"],
  ["Browser.listTargets", typeof bp.Browser.prototype.listTargets === "function"],
  ["Browser.newPage", typeof bp.Browser.prototype.newPage === "function"],
  ["Page.waitForReady", typeof bp.Page.prototype.waitForReady === "function"],
  ["Page.targetId", "targetId" in bp.Page.prototype],
  ["recoverStaleRef", typeof bp.recoverStaleRef === "function"],
  ["TargetNotFoundError", typeof bp.TargetNotFoundError === "function"],
];
const missing = requiredRuntime.filter(([, ok]) => !ok).map(([name]) => name);
if (missing.length > 0) throw new Error("missing runtime contracts: " + missing.join(", "));

const cdp = {
  async send(method) {
    if (method === "Target.setDiscoverTargets") {
      return {};
    }
    if (method === "Target.getTargets") {
      return {
        targetInfos: [
          { targetId: "good-target", type: "page", url: "https://good.example", title: "Good" },
        ],
      };
    }
    throw new Error("packed target-boundary test reached unsupported CDP method: " + method);
  },
};
const browser = bp.Browser.fromCDP(cdp, { wsUrl: "ws://packed-boundary.invalid" });
let explicitTargetFailed = false;
try {
  await browser.page("missing", { targetId: "missing-target" });
} catch (error) {
  if (!(error instanceof bp.TargetNotFoundError)) throw error;
  explicitTargetFailed = true;
}
if (!explicitTargetFailed) throw new Error("explicit target failure fell back to another target");
`;
}

async function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  const process = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

function commandFailure(result: CommandResult): string {
  const output = `${result.stdout}${result.stderr}`.trim();
  return output || `command exited with status ${result.status}`;
}

function describeProvenance(label: string, provenance: PackageProvenance): void {
  console.log(`${label}: ${provenance.kind.toUpperCase()} OK`);
  console.log(`  resolved path: ${provenance.realPath}`);
  console.log(`  lexical path: ${provenance.lexicalPath}`);
  console.log(`  version: ${provenance.version}`);
  console.log(`  source commit: ${provenance.sourceCommit ?? "unavailable"}`);
  console.log(
    `  source worktree: ${
      provenance.sourceDirty === undefined
        ? "unavailable"
        : provenance.sourceDirty
          ? "DIRTY"
          : "CLEAN"
    }`,
  );
  console.log(`  source hash: ${provenance.sourceHash ?? "unavailable"}`);
  console.log(`  build hash: ${provenance.packageHash}`);
  console.log(
    `  build freshness: ${provenance.buildFreshness.toUpperCase()} (${provenance.buildFreshnessDetail})`,
  );
}

function describeApi(api: ApiCompatibility): void {
  console.log(`  API compatibility: ${api.ok ? "OK" : "FAIL"}`);
  for (const check of api.checks) {
    console.log(`    ${check.ok ? "OK" : "FAIL"} ${check.label}: ${check.detail}`);
  }
}

async function resolveSourceConfig(repoRoot: string): Promise<SourceConfig> {
  return sourceConfigFromPackage(await readPackageJson(repoRoot), repoRoot);
}

async function verifyInstalled(
  repoRoot: string,
  config: SourceConfig,
): Promise<VerificationReport> {
  const errors: string[] = [];
  let installed: PackageProvenance | undefined;
  let source: PackageProvenance | undefined;

  const installedPath = await installedPackagePath(repoRoot);
  installed = await inspectPackage(installedPath);
  describeProvenance("installed browser-pilot", installed);

  if (config.sourceRoot) {
    source = await inspectPackage(config.sourceRoot, "copy");
    console.log(`  dependency spec: ${config.dependencySpec}`);
    console.log(`  expected source: ${source.realPath}`);
    if (installed.realPath !== source.realPath && installed.packageHash !== source.packageHash) {
      errors.push(
        `installed browser-pilot hash ${installed.packageHash} does not match source hash ${source.packageHash}; the file: dependency was copied stale`,
      );
    }
    if (source.buildFreshness !== "fresh") {
      errors.push(
        `source browser-pilot build is ${source.buildFreshness}: ${source.buildFreshnessDetail}`,
      );
    }
    if (installed.kind === "copy" && installed.realPath !== source.realPath) {
      errors.push(
        `installed browser-pilot is a copied directory at ${installed.realPath}; run dev:link-browser-pilot or refresh from a built tarball`,
      );
    }
  } else {
    console.log(`  dependency spec: ${config.dependencySpec}`);
    console.log(
      "  source provenance: unavailable for a non-file dependency; package hash is authoritative",
    );
  }

  const api = await checkApiCompatibility(installed.realPath);
  describeApi(api);
  if (!api.ok) errors.push("installed browser-pilot API surface is incompatible with FP-07");
  return { ok: errors.length === 0, errors, installed, source, api };
}

async function packageForPacking(
  sourceRoot: string | undefined,
  installed: PackageProvenance,
): Promise<string> {
  return sourceRoot ?? installed.realPath;
}

async function verifyPacked(
  repoRoot: string,
  sourceRoot: string | undefined,
  installed?: PackageProvenance,
): Promise<VerificationReport> {
  const errors: string[] = [];
  const tempRoot = await mkdtemp(join(tmpdir(), "flightplan-browser-pilot-packed-"));
  try {
    const packSource = await packageForPacking(
      sourceRoot,
      installed ?? (await inspectPackage(await installedPackagePath(repoRoot))),
    );
    const packSourceProvenance = await inspectPackage(packSource, "copy");
    describeProvenance("packed source", packSourceProvenance);
    const stageRoot = join(tempRoot, "stage");
    await mkdir(stageRoot, { recursive: true });
    await cp(join(packSource, "package.json"), join(stageRoot, "package.json"));
    await cp(join(packSource, "dist"), join(stageRoot, "dist"), { recursive: true });

    const pack = await runCommand(
      process.execPath,
      ["pm", "pack", "--ignore-scripts", "--quiet", "--destination", tempRoot],
      stageRoot,
    );
    if (pack.status !== 0) {
      errors.push(`bun pm pack failed: ${commandFailure(pack)}`);
      return { ok: false, errors };
    }
    const tarballs = (await readdir(tempRoot)).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      errors.push(`expected exactly one packed browser-pilot tarball, found ${tarballs.length}`);
      return { ok: false, errors };
    }
    const tarball = join(tempRoot, tarballs[0]!);
    const packedHash = createHash("sha256")
      .update(await readFile(tarball))
      .digest("hex");
    console.log(`packed browser-pilot tarball hash: ${packedHash}`);

    const unpackRoot = join(tempRoot, "unpacked");
    await mkdir(unpackRoot, { recursive: true });
    const unpack = await runCommand("tar", ["-xzf", tarball, "-C", unpackRoot], tempRoot);
    if (unpack.status !== 0) {
      errors.push(`tar extraction failed: ${commandFailure(unpack)}`);
      return { ok: false, errors, packedHash };
    }

    const packedRoot = join(unpackRoot, "package");
    const packedArtifact = await inspectPackage(packedRoot, "copy");
    describeProvenance("packed artifact", packedArtifact);
    if (packedArtifact.packageHash !== packSourceProvenance.packageHash) {
      errors.push(
        `packed artifact hash ${packedArtifact.packageHash} does not match source package hash ${packSourceProvenance.packageHash}`,
      );
    }
    const packedApi = await checkApiCompatibility(packedRoot);
    describeApi(packedApi);
    if (!packedApi.ok) errors.push("packed browser-pilot API surface is incompatible with FP-07");

    const consumerRoot = join(tempRoot, "consumer");
    const consumerPackage = join(consumerRoot, "node_modules", BROWSER_PILOT_PACKAGE);
    await mkdir(dirname(consumerPackage), { recursive: true });
    await cp(packedRoot, consumerPackage, { recursive: true });
    await writeFile(join(consumerRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(join(consumerRoot, "consumer.ts"), boundaryConsumerTypeScript());
    await writeFile(
      join(consumerRoot, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            module: "ESNext",
            moduleResolution: "Bundler",
            target: "ES2022",
            strict: true,
            skipLibCheck: true,
            noEmit: true,
          },
          include: ["consumer.ts"],
        },
        null,
        2,
      ),
    );
    await writeFile(join(consumerRoot, "consumer.mjs"), boundaryConsumerJavaScript());

    const typecheck = await runCommand(
      join(repoRoot, "node_modules", ".bin", "tsc"),
      ["--project", join(consumerRoot, "tsconfig.json")],
      consumerRoot,
    );
    if (typecheck.status !== 0) {
      errors.push(`packed consumer typecheck failed: ${commandFailure(typecheck)}`);
      return { ok: false, errors, packedHash };
    }
    console.log("packed consumer typecheck: OK");

    const runtime = await runCommand(
      process.execPath,
      ["run", join(consumerRoot, "consumer.mjs")],
      consumerRoot,
    );
    if (runtime.status !== 0) {
      errors.push(`packed consumer runtime failed: ${commandFailure(runtime)}`);
      return { ok: false, errors, packedHash };
    }
    console.log(
      "packed consumer runtime: OK (dispatch metadata, explicit target failure, readiness, detached refs, popup target contract)",
    );
    return { ok: errors.length === 0, errors, packedHash, api: packedApi };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function backupName(nodeModules: string): Promise<string> {
  const base = join(nodeModules, `.flightplan-${BROWSER_PILOT_PACKAGE}-copy-${Date.now()}`);
  let candidate = base;
  let suffix = 1;
  while (true) {
    try {
      await lstat(candidate);
      candidate = `${base}-${suffix}`;
      suffix += 1;
    } catch (error) {
      if (isMissingError(error)) return candidate;
      throw error;
    }
  }
}

export async function linkBrowserPilot(repoRoot: string): Promise<void> {
  const config = await resolveSourceConfig(repoRoot);
  if (!config.sourceRoot) {
    throw new Error(
      `dev:link-browser-pilot requires a local file: dependency; current spec is ${config.dependencySpec}`,
    );
  }
  const sourceRoot = await realpath(config.sourceRoot);
  const source = await inspectPackage(sourceRoot, "copy");
  const nodeModules = join(repoRoot, "node_modules");
  const installedPath = join(nodeModules, BROWSER_PILOT_PACKAGE);
  await mkdir(nodeModules, { recursive: true });

  let preservedCopy: string | undefined;
  try {
    const existing = await lstat(installedPath);
    if (existing.isSymbolicLink() && (await realpath(installedPath)) === sourceRoot) {
      console.log(`dev:link-browser-pilot: OK (already linked to ${sourceRoot})`);
      describeProvenance("source browser-pilot", source);
      return;
    }
    preservedCopy = await backupName(nodeModules);
    await rename(installedPath, preservedCopy);
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }

  await symlink(sourceRoot, installedPath, "dir");
  if ((await realpath(installedPath)) !== sourceRoot) {
    throw new Error(`created browser-pilot link does not resolve to ${sourceRoot}`);
  }
  console.log(`dev:link-browser-pilot: OK (linked ${installedPath} -> ${sourceRoot})`);
  if (preservedCopy) console.log(`  preserved previous copy: ${preservedCopy}`);
  console.log("  no install or external-repository mutation was performed");
  describeProvenance("source browser-pilot", source);
}

function printReport(label: string, report: VerificationReport): void {
  console.log(`${label}: ${report.ok ? "OK" : "FAIL"}`);
  for (const error of report.errors) console.log(`  ERROR: ${error}`);
}

export async function run(mode: "verify" | "packed", repoRoot: string): Promise<boolean> {
  const config = await resolveSourceConfig(repoRoot);
  let installed: PackageProvenance | undefined;
  let allOk = true;
  if (mode === "verify") {
    try {
      const installedReport = await verifyInstalled(repoRoot, config);
      installed = installedReport.installed;
      printReport("verify:browser-pilot installed", installedReport);
      allOk = installedReport.ok && allOk;
    } catch (error) {
      allOk = false;
      console.log("verify:browser-pilot installed: FAIL");
      console.log(`  ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const packedReport = await verifyPacked(repoRoot, config.sourceRoot, installed);
    printReport("verify:browser-pilot packed", packedReport);
    allOk = packedReport.ok && allOk;
  } catch (error) {
    allOk = false;
    console.log("verify:browser-pilot packed: FAIL");
    console.log(`  ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }
  return allOk;
}

async function main(argv: string[]): Promise<number> {
  const repoRoot = resolve(import.meta.dir, "..");
  const mode = argv[0] ?? "verify";
  if (mode === "link") {
    await linkBrowserPilot(repoRoot);
    return 0;
  }
  if (mode === "verify" || mode === "packed") return (await run(mode, repoRoot)) ? 0 : 1;
  console.error(
    `Unknown browser-pilot dependency command ${JSON.stringify(mode)} (expected link, verify, or packed)`,
  );
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `browser-pilot dependency guard: FAIL: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
