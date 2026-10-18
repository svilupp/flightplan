import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch } from "chrome-launcher";
import { resolveConfigWithDefaults } from "../config/resolve.ts";
import { runFlow } from "../runner/runner.ts";
import {
  type NamedSessionBorrow,
  namedSessionDriverFactory,
  nativeNamedSessionBorrower,
} from "./named-session.ts";
import { createNamedSessionYieldHost } from "./named-session-yield.ts";
import type { Driver } from "./types.ts";

const enabled = process.env.FLIGHTPLAN_BP_OWNER_BROWSER === "1";
const browserTest = enabled ? test : test.skip;

async function cli(args: string[]) {
  const entry = process.env.FLIGHTPLAN_BP_CLI ?? resolve("node_modules/browser-pilot/dist/cli.mjs");
  const child = Bun.spawn([process.execPath, entry, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

browserTest(
  "real named owner: BP to cold/warm Flightplan to BP preserves connection and state",
  async () => {
    const runtime = process.env.FLIGHTPLAN_FP_MODULE
      ? ((await import(process.env.FLIGHTPLAN_FP_MODULE)) as typeof import("../index.ts"))
      : undefined;
    const runRecipe = runtime?.runFlow ?? runFlow;
    const borrowNative = runtime?.nativeNamedSessionBorrower ?? nativeNamedSessionBorrower;
    const makeNamedAdapter = runtime?.namedSessionDriverFactory ?? namedSessionDriverFactory;
    const makeYieldHost = runtime?.createNamedSessionYieldHost ?? createNamedSessionYieldHost;
    const dir = await mkdtemp(join(tmpdir(), "fp-owner-real-"));
    const session = `fp-owner-${crypto.randomUUID()}`;
    await mkdir(join(dir, "profile"));
    const chrome = await launch({
      chromeFlags: [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
      ],
      userDataDir: join(dir, "profile"),
    });
    let connections = 0;
    let activeLease: Awaited<ReturnType<typeof nativeNamedSessionBorrower>> | undefined;
    let daemonPid: number | undefined;
    const version = (await fetch(`http://127.0.0.1:${chrome.port}/json/version`).then((r) =>
      r.json(),
    )) as { webSocketDebuggerUrl: string };
    const proxy = Bun.serve<{ upstream: WebSocket; queue: string[] }>({
      port: 0,
      fetch(request, server) {
        const upstream = new WebSocket(version.webSocketDebuggerUrl);
        const queue: string[] = [];
        if (server.upgrade(request, { data: { upstream, queue } })) return undefined;
        upstream.close();
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        open(socket) {
          connections++;
          socket.data.upstream.addEventListener("open", () => {
            for (const message of socket.data.queue) socket.data.upstream.send(message);
            socket.data.queue.length = 0;
          });
          socket.data.upstream.addEventListener("message", (event) => socket.send(event.data));
          socket.data.upstream.addEventListener("close", () => socket.close());
        },
        message(socket, message) {
          const text = typeof message === "string" ? message : message.toString();
          if (socket.data.upstream.readyState === WebSocket.OPEN) socket.data.upstream.send(text);
          else socket.data.queue.push(text);
        },
        close(socket) {
          socket.data.upstream.close();
        },
      },
    });
    const pageServer = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `<html><body><button id="increment" onclick="this.textContent=String(Number(this.textContent)+1)">0</button></body></html>`,
          {
            headers: {
              "content-type": "text/html",
              "set-cookie": "continuity=preserved; Path=/; SameSite=Lax",
            },
          },
        ),
    });
    try {
      const connected = await cli([
        "connect",
        "--name",
        session,
        "--browser-url",
        `ws://127.0.0.1:${proxy.port}/devtools/browser/fixture`,
        "--page-url",
        `http://127.0.0.1:${pageServer.port}/`,
        "--json",
      ]);
      expect(connected.exitCode, connected.stderr).toBe(0);
      daemonPid = (JSON.parse(connected.stdout) as { daemon?: { pid?: number } }).daemon?.pid;
      expect(connections).toBe(1);
      const navigated = await cli([
        "exec",
        JSON.stringify({ action: "goto", url: `http://127.0.0.1:${pageServer.port}/` }),
        "-s",
        session,
        "--json",
      ]);
      expect(navigated.exitCode, navigated.stderr).toBe(0);
      const first = await borrowNative({
        session,
        targetPolicy: "selected",
        recovery: "never",
      });
      activeLease = first;
      const target = first.page.targetId;
      const epoch = first.ownerEpoch;
      const refs = await first.page.snapshot();
      expect(
        refs.interactiveElements.length,
        JSON.stringify({ connected: connected.stdout, refs }),
      ).toBeGreaterThan(0);
      expect(await first.page.evaluate<string>("document.cookie")).toContain(
        "continuity=preserved",
      );
      const contention = await cli(["snapshot", "-i", "-s", session, "--json"]);
      expect(contention.exitCode).not.toBe(0);
      expect(connections).toBe(1);
      await first.handback({ targetId: target });
      await first.detach();
      await expect(
        borrowNative({
          session,
          targetPolicy: "exact",
          targetId: "missing-target",
          recovery: "never",
        }),
      ).rejects.toThrow();
      const flow = join(dir, "flow.toml");
      await Bun.write(
        flow,
        `version=1\nkind="flow"\nid="owner.continuity"\ndescription="owner continuity fixture"\n[[steps]]\nid="increment"\ndo="click"\ntarget="css:#increment"\neffect="idempotent"\n[[steps.assert]]\ntype="visible"\nselector="#increment"\n`,
      );
      for (let pass = 0; pass < 2; pass++) {
        const adapter = makeNamedAdapter(borrowNative);
        const result = await runRecipe({
          flowPath: flow,
          out: join(dir, "runs"),
          config: resolveConfigWithDefaults([
            {
              connect: {
                mode: "session",
                session_ref: session,
                target_policy: "exact",
                target_id: target,
              },
            },
          ]),
          driverFactory: adapter.factory,
          env: {},
        });
        expect(result.summary.verdict).toBe("passed");
        expect(adapter.handback()).toMatchObject({
          status: "verified",
          target_id: target,
          owner_epoch: epoch,
        });
        expect(connections).toBe(1);
      }
      let fpLease: NamedSessionBorrow | undefined;
      let fpDriver: Driver | undefined;
      let initialGrant: string | undefined;
      let refreshed = false;
      const yieldConfig = {
        mode: "session",
        session_ref: session,
        target_policy: "exact",
        target_id: target,
      } as const;
      const yieldAdapter = makeNamedAdapter(async (request) => {
        fpLease = await borrowNative(request);
        return fpLease;
      });
      const identity = async () => {
        if (!fpLease) throw new Error("fixture lease missing");
        return {
          ownerEpoch: fpLease.ownerEpoch,
          grantToken: fpLease.fencingToken,
          pageIdentity: fpLease.page.targetId,
        };
      };
      const yieldHost = makeYieldHost({
        session,
        binding: "fixture-yield",
        borrow: borrowNative,
        flightplan: {
          currentIdentity: async () => {
            const value = await identity();
            initialGrant = value.grantToken;
            return value;
          },
          release: async () => {
            if (!fpDriver) throw new Error("fixture driver missing");
            await fpDriver.teardown();
          },
          acquire: async () => {
            if (!fpDriver) throw new Error("fixture driver missing");
            await fpDriver.connect(yieldConfig);
            const value = await identity();
            expect(value.grantToken).not.toBe(initialGrant);
            return value;
          },
          refresh: async () => {
            await fpDriver?.snapshot();
            refreshed = true;
          },
        },
        perform: async (lease) => {
          await lease.page.click("#increment");
          return { pageIdentity: lease.page.targetId };
        },
        verifyReturn: async (_checkpoint, page) =>
          page === target && (await fpDriver?.elementState?.("#increment"))?.text === "3",
      });
      const yieldFlow = join(dir, "yield.toml");
      await Bun.write(
        yieldFlow,
        'version=1\nkind="flow"\nid="owner.yield"\ndescription="owner yield fixture"\n[[steps]]\nid="host"\ndo="yield"\ntask="Increment once using the host borrowed BP page"\n[[steps.assert]]\ntype="text"\nselector="#increment"\ntext="3"\nmatch="exact"\n',
      );
      const yielded = await runRecipe({
        flowPath: yieldFlow,
        out: join(dir, "yield-runs"),
        config: resolveConfigWithDefaults([{ connect: yieldConfig }]),
        driverFactory: (config, context) => {
          fpDriver = yieldAdapter.factory(config, context);
          return fpDriver;
        },
        yieldHost,
        env: {},
        noLockWrite: true,
      });
      expect(yielded.summary.verdict).toBe("passed");
      expect(refreshed).toBe(true);
      expect(connections).toBe(1);
      const publicCli = Bun.spawn(
        [
          process.execPath,
          resolve("src/cli/index.ts"),
          "run",
          flow,
          "--session",
          session,
          "--json",
          "--no-lock-write",
          "-o",
          join(dir, "cli-runs"),
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [cliOut, cliErr, cliCode] = await Promise.all([
        new Response(publicCli.stdout).text(),
        new Response(publicCli.stderr).text(),
        publicCli.exited,
      ]);
      expect(cliCode, cliErr || cliOut).toBe(0);
      expect(JSON.parse(cliOut)).toMatchObject({
        verdict: "passed",
        session_handback: { status: "verified" },
      });
      const final = await borrowNative({
        session,
        targetPolicy: "selected",
        recovery: "never",
      });
      activeLease = final;
      expect(final.page.targetId).toBe(target);
      expect(final.ownerEpoch).toBe(epoch);
      expect(await final.page.evaluate<string>("document.cookie")).toContain(
        "continuity=preserved",
      );
      expect(
        await final.page.evaluate<string>("document.querySelector('#increment').textContent"),
      ).toBe("4");
      await final.handback({ targetId: target });
      await final.detach();
      const resumed = await cli(["snapshot", "-i", "-s", session, "--json"]);
      expect(resumed.exitCode, resumed.stderr).toBe(0);
      expect(connections).toBe(1);
    } finally {
      await activeLease?.detach().catch(() => {});
      const stopped = await cli(["daemon", "stop", "-s", session]);
      if (stopped.exitCode !== 0 && daemonPid) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          /* Already stopped. */
        }
      }
      await cli(["close", "-s", session]);
      await chrome.kill();
      await proxy.stop(true);
      await pageServer.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  },
  90000,
);
