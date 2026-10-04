import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sourceNode =
  spawnSync("node", ["--no-warnings", "--experimental-transform-types", "--eval", ""], {
    stdio: "ignore",
  }).status === 0;

test.skipIf(!sourceNode)(
  "native CLI drains large JSON output before process termination",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "flightplan-review-drain-"));
    const flow = join(directory, "large.toml");
    const loader = join(directory, "source-loader.mjs");
    // Resolve source-only dynamic .js imports without building shared dist.
    await writeFile(
      loader,
      `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js'))
        return nextResolve(specifier.slice(0, -3) + '.ts', context);
      throw error;
    }
  }`,
    );
    const count = 2000;
    await writeFile(
      flow,
      `version = 1\nkind = "flow"\nid = "review.output"\ndescription = "Large deterministic output"\n` +
        Array.from(
          { length: count },
          (_, index) => `\n[[steps]]\nid = "step_${index}"\ndo = "wait"\nms = 1\n`,
        ).join(""),
    );
    const harness = join(directory, "capture.mjs");
    const args = [
      "--no-warnings",
      "--experimental-transform-types",
      "--loader",
      loader,
      resolve("src/cli/index.ts"),
      "migrate-effects",
      flow,
      "--json",
    ];
    // Both producer and consumer use native Node streams, not Bun's pipe adapter.
    await writeFile(
      harness,
      `import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ${JSON.stringify(args)}, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.pause();
    const resume = setTimeout(() => child.stdout.resume(), 1000);
    child.on('error', (error) => { throw error; });
    // exit is insufficient: close establishes that both pipes have drained.
    child.on('close', (code) => {
      clearTimeout(resume);
      let result;
      try { result = JSON.parse(stdout); }
      catch (error) { console.log(JSON.stringify({ code, stderr, bytes: stdout.length, parseError: error.message })); return; }
      console.log(JSON.stringify({ code, stderr, bytes: stdout.length, count: result.suggestions.length, last: result.suggestions.at(-1).step }));
    });`,
    );
    try {
      const child = Bun.spawn(["node", harness], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      const captured = JSON.parse(stdout);
      expect(captured).toMatchObject({ code: 0, stderr: "", count, last: `step_${count - 1}` });
      expect(captured.bytes).toBeGreaterThan(8192);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  10000,
);
