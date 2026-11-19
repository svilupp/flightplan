import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, connect, getBrowserWebSocketUrl } from "browser-pilot";
import { type LaunchedChrome, launch } from "chrome-launcher";

const browserTest = process.env.FLIGHTPLAN_BROWSER_INTEGRATION === "1" ? test : test.skip;
const cliPath = join(import.meta.dir, "../../dist/cli/index.js");
const tmpDirs: string[] = [];
let chrome: LaunchedChrome | undefined;
let browser: Browser | undefined;

beforeAll(async () => {
  if (process.env.FLIGHTPLAN_BROWSER_INTEGRATION !== "1") return;
  chrome = await launch({ chromeFlags: ["--headless=new", "--no-first-run"] });
  browser = await connect({
    provider: "generic",
    wsUrl: await getBrowserWebSocketUrl(`http://127.0.0.1:${chrome.port}`),
  });
}, 30_000);

afterAll(async () => {
  try {
    await browser?.disconnect();
  } finally {
    await chrome?.kill();
    await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

async function waitForPause(outDir: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    for (const entry of await readdir(outDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const events = await readFile(join(outDir, entry.name, "run.jsonl"), "utf8").catch(() => "");
      if (
        events
          .split("\n")
          .some((line) => line.includes('"type":"step_start"') && line.includes('"stepId":"pause"'))
      )
        return;
    }
    await Bun.sleep(25);
  }
  throw new Error("CLI did not reach its long wait step");
}

for (const [signal, status] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  browserTest(
    `the built CLI cleans owned tabs and exits promptly on ${signal}`,
    async () => {
      if (!chrome || !browser) throw new Error("isolated Chrome was not initialized");
      const sentinel = await browser.newPage("data:text/plain,signal-sentinel");
      const before = (await browser.listTargets()).map((target) => target.targetId).sort();
      const dir = await mkdtemp(join(tmpdir(), "flightplan-signals-"));
      tmpDirs.push(dir);
      const flowPath = join(dir, "flow.toml");
      const outDir = join(dir, "runs");
      await Bun.write(
        flowPath,
        `version=1\nkind="flow"\nid="signals"\ndescription="signal cleanup"\n` +
          `[config.connect]\nmode="attach"\nbrowserURL="http://127.0.0.1:${chrome.port}"\n` +
          '[[steps]]\nid="open"\ndo="goto"\nurl="data:text/html,<h1>Ready</h1>"\neffect="observe"\n' +
          '[[steps]]\nid="pause"\ndo="wait"\nms=60000\neffect="observe"\nassert=[{type="url",url="data:text/html,<h1>Ready</h1>",match="exact"}]',
      );
      const lint = Bun.spawn(["node", cliPath, "lint", flowPath, "--json"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await lint.exited).toBe(0);
      const child = Bun.spawn(
        ["node", cliPath, "run", flowPath, "-o", outDir, "--no-lock-write", "--json"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await waitForPause(outDir);
        const interruptedAt = Date.now();
        child.kill(signal);
        timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        expect(await child.exited).toBe(status);
        expect(Date.now() - interruptedAt).toBeLessThan(3000);
        expect((await stdout) + (await stderr)).toContain("cleanup: completed");
        const after = (await browser.listTargets()).map((target) => target.targetId).sort();
        expect(after).toEqual(before);
        expect(after).toContain(sentinel.targetId);
        for (const entry of await readdir(outDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          expect(await Bun.file(join(outDir, entry.name, "summary.json")).exists()).toBe(false);
        }
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    },
    20_000,
  );
}
