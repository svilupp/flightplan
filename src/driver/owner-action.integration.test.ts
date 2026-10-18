import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "browser-pilot/core";
import { launch } from "chrome-launcher";
import { resolveConfigWithDefaults } from "../config/index.ts";
import type { ActionGuardOptions } from "../guard/types.ts";
import { runFlow } from "../runner/runner.ts";
import { BrowserPilotDriver } from "./browser-pilot-driver.ts";
import { nativeNamedSessionBorrower } from "./named-session.ts";
import {
  nativeOwnerActionDriverFactory,
  nativeOwnerActionsBorrower,
} from "./native-owner-actions.ts";

const ownerTest = process.env.FLIGHTPLAN_BP_OWNER_BROWSER === "1" ? test : test.skip;
ownerTest(
  "public strict owner port runs guarded recipe and rejects raw/flow widening/stale evidence",
  async () => {
    const runtime = process.env.FLIGHTPLAN_FP_MODULE
      ? ((await import(process.env.FLIGHTPLAN_FP_MODULE)) as typeof import("../index.ts"))
      : undefined;
    const runRecipe = runtime?.runFlow ?? runFlow;
    const makeOwnerFactory =
      runtime?.nativeOwnerActionDriverFactory ?? nativeOwnerActionDriverFactory;
    const borrowStrict = runtime?.nativeOwnerActionsBorrower ?? nativeOwnerActionsBorrower;
    const borrowRaw = runtime?.nativeNamedSessionBorrower ?? nativeNamedSessionBorrower;
    const directory = await mkdtemp(join(tmpdir(), "fp-owner-strict-"));
    const session = `fp-strict-${crypto.randomUUID()}`;
    const sessionDirectory = join(homedir(), ".browser-pilot", "sessions", session);
    const sessionFile = `${sessionDirectory}.json`;
    await mkdir(sessionDirectory, { recursive: true });
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `<html><body><button id="open" onclick="window.clicks=(window.clicks||0)+1">Open</button><button id="refund" onclick="window.refunds=(window.refunds||0)+1">Refund</button><input id="entry" onkeydown="if(event.key==='Enter')window.enters=(window.enters||0)+1"><div class="product"><span class="price">101</span><input class="secret" type="password" value="new-private-canary"></div></body></html>`,
          { headers: { "content-type": "text/html" } },
        ),
    });
    const driver = new BrowserPilotDriver();
    let daemon: { close(): Promise<void> } | undefined;
    let chrome: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      chrome = await launch({
        chromeFlags: [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });
      const endpointInfo = (await fetch(`http://127.0.0.1:${chrome.port}/json/version`).then(
        (response) => response.json(),
      )) as { webSocketDebuggerUrl: string };
      const endpoint = endpointInfo.webSocketDebuggerUrl;
      await driver.connect({ mode: "attach", wsUrl: endpoint });
      await driver.goto(`http://127.0.0.1:${server.port}/`, { waitForNavigation: false });
      const page = (await driver.page()) as Page;
      const moduleName = "browser-pilot/adapters/node";
      const module = (await import(moduleName)) as {
        startOwnerActionDaemon(options: {
          socketPath: string;
          wsUrl: string;
          cdp: Page["cdpClient"];
          policy: {
            id: string;
            version: string;
            mode: "enforce";
            allowedActions: string[];
            allowValueReads: boolean;
            redactText(text: string): string;
            evaluate(
              proposal: { evidence: { target?: string } },
              signal: AbortSignal,
            ): Promise<{ verdict: "allow" | "deny"; reason: string }>;
          };
          handback(session: string, target: string, url: string, epoch: string): Promise<number>;
        }): Promise<{ close(): Promise<void> }>;
      };
      let mutate = false;
      let rootEvaluations = 0;
      let localDeny = false;
      let localMutate = false;
      let localEvaluations = 0;
      const localGuard: ActionGuardOptions = {
        mode: "enforce",
        policyVersion: "additional",
        requiredAssurance: "owner-serialized-prechecked-native",
        evaluate: async () => {
          localEvaluations++;
          if (localMutate)
            await page.evaluate("document.querySelector('#open').textContent='Local changed'");
          return { decision: localDeny ? "deny" : "allow", reason: "local_restriction" };
        },
      };
      let revision = 0;
      const socketPath = join(sessionDirectory, "daemon.sock");
      daemon = await module.startOwnerActionDaemon({
        socketPath,
        wsUrl: endpoint,
        cdp: page.cdpClient,
        policy: {
          id: "fixture-global",
          version: "1",
          mode: "enforce",
          allowedActions: ["click", "fill", "press", "goto"],
          allowValueReads: true,
          redactText: (text) => text,
          evaluate: async (proposal) => {
            rootEvaluations++;
            if (mutate)
              await page.evaluate("document.querySelector('#open').textContent='Changed'");
            return {
              verdict: proposal.evidence.target === "Refund" ? "deny" : "allow",
              reason: "fixture_policy",
            };
          },
        },
        handback: async (id, target) => {
          expect(id).toBe(session);
          expect(target).toBe(page.targetId);
          return ++revision;
        },
      });
      // Trusted host registry bootstrap for this disposable named session.
      await Bun.write(
        sessionFile,
        JSON.stringify({
          schemaVersion: 1,
          id: session,
          provider: "generic",
          wsUrl: endpoint,
          targetId: page.targetId,
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          currentUrl: `http://127.0.0.1:${server.port}/`,
          transport: { mode: "daemon" },
          daemon: { socketPath, pid: process.pid, startedAt: new Date().toISOString() },
        }),
      );
      const rawRefusal = await borrowRaw({
        session,
        targetPolicy: "selected",
      }).then(
        () => "unexpected_success",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(rawRefusal).toContain("strict action profile");
      const factory = makeOwnerFactory({
        requiredAssurance: "owner-serialized-prechecked-native",
      });
      const flowPath = join(directory, "flow.toml");
      await Bun.write(
        flowPath,
        'version=1\nkind="flow"\nid="owner.strict"\ndescription="typed owner fixture"\n[outputs.rows]\nstep="read"\n[[steps]]\nid="open"\ndo="click"\ntarget="css:#open"\neffect="idempotent"\n[[steps]]\nid="fill"\ndo="fill"\ntarget="css:#entry"\nvalue="fixture value"\neffect="idempotent"\n[[steps]]\nid="enter"\ndo="press"\nkey="Enter"\neffect="idempotent"\n[[steps]]\nid="read"\ndo="extract"\nselector=".product"\n[steps.fields.price]\nselector=".price"\nsource="text"\ntype="number"\nrequired=true\n[steps.fields.secret]\nselector=".secret"\nsource="value"\ntype="string"\nsecret=true\n[[steps.assert]]\ntype="result"\npath="0.price"\ngt=100\n',
      );
      const source = await readFile(flowPath, "utf8");
      await Bun.write(
        flowPath,
        source.replace(
          '[[steps]]\nid="open"',
          `[[steps]]\nid="navigate"\ndo="goto"\nurl="http://127.0.0.1:${server.port}/"\n[[steps.assert]]\ntype="visible"\nselector="#open"\n[[steps]]\nid="open"`,
        ),
      );
      const config = resolveConfigWithDefaults([
        {
          browser: { dialog: "fail" },
          connect: {
            mode: "session",
            session_ref: session,
            target_policy: "exact",
            target_id: page.targetId,
          },
        },
      ]);
      const result = await runRecipe({
        flowPath,
        out: join(directory, "runs"),
        config,
        driverFactory: factory,
        actionGuard: localGuard,
        env: {},
        noLockWrite: true,
      });
      expect({ summary: result.summary }).toMatchObject({ summary: { verdict: "passed" } });
      expect(await page.evaluate<number>("window.clicks")).toBe(1);
      expect(await page.evaluate<number>("window.enters")).toBe(1);
      expect(JSON.stringify(result.summary)).not.toContain("new-private-canary");
      expect(await readFile(result.summary.trace_path!, "utf8")).not.toContain(
        "new-private-canary",
      );
      for (const [id, target] of [
        ["denied", "refund"],
        ["stale", "open"],
        ["local-denied", "open"],
        ["local-stale", "open"],
      ]) {
        mutate = id === "stale";
        localDeny = id === "local-denied";
        localMutate = id === "local-stale";
        const beforeRoot = rootEvaluations;
        await Bun.write(
          flowPath,
          `version=1\nkind="flow"\nid="owner.${id}"\ndescription="policy fixture"\n[[steps]]\nid="action"\ndo="click"\ntarget="css:#${target}"\neffect="observe"\n`,
        );
        const blocked = await runRecipe({
          flowPath,
          out: join(directory, id!),
          config,
          driverFactory: factory,
          actionGuard: localGuard,
          env: {},
          noLockWrite: true,
        });
        expect(blocked.summary.verdict).toBe("failed");
        expect(blocked.summary.steps[0]?.dispatchState).toBe("not_dispatched");
        if (localDeny) expect(rootEvaluations).toBe(beforeRoot);
      }
      expect(localEvaluations).toBeGreaterThanOrEqual(6);
      expect(await page.evaluate<number>("window.refunds||0")).toBe(0);
      expect(await page.evaluate<number>("window.clicks")).toBe(1);
      const lease = await borrowStrict({ session, targetPolicy: "selected" });
      expect((await lease.port.capabilities()).profile).toBe("strict");
      await lease.handback({ targetId: page.targetId });
      await lease.detach();
    } finally {
      await daemon?.close();
      await driver.teardown();
      await chrome?.kill();
      await server.stop(true);
      await rm(sessionFile, { force: true });
      await rm(sessionDirectory, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
  90000,
);
