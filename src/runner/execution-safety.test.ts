import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { memoryFileSystem } from "../adapters/memory.ts";
import { FakeClock } from "../assert/clock.ts";
import { resolveConfigWithDefaults } from "../config/resolve.ts";
import { MockDriver } from "../driver/mock-driver.ts";
import { makeInteractiveElement, makeSnapshot, makeSuccessBatch } from "../driver/mock-fixtures.ts";
import { InvalidSelectorError } from "../driver/normalize-selector.ts";
import { lintText } from "../lint/lint.ts";
import { runFlow } from "./runner.ts";

const header = 'version=1\nkind="flow"\nid="safety"\ndescription="execution safety"\n';

function fixture(body: string) {
  const fs = memoryFileSystem();
  const driver = new MockDriver();
  return {
    fs,
    driver,
    opts: {
      flowPath: "/flow.toml",
      flowSource: header + body,
      fs,
      driverFactory: () => driver,
      config: resolveConfigWithDefaults([]),
      clock: new FakeClock(),
      env: {},
      out: "/runs",
    },
  };
}

for (const effect of ["at_most_once", "idempotent"] as const) {
  test(`a backward jump ${effect === "at_most_once" ? "protects" : "can repeat"} an earlier ${effect} action`, async () => {
    const { driver, opts } = fixture(
      '[[steps]]\nid="rewind"\ndo="wait"\nms=0\n' +
        `[[steps]]\nid="mutation"\ndo="press"\nkey="Enter"\neffect="${effect}"\n` +
        '[[steps]]\nid="check"\ndo="wait"\nms=0\non_fail={goto="rewind",max=1}\n' +
        'assert=[{type="url",url="https://example.test/missing",match="exact",when="before",timeout_ms=1}]',
    );
    const result = await runFlow(opts);
    expect(result.summary.verdict).toBe("failed");
    expect(driver.callsTo("press")).toHaveLength(effect === "at_most_once" ? 1 : 2);
    expect(driver.callsTo("teardown")).toHaveLength(1);
  });
}

test("runtime-expanded step IDs cannot hide an earlier protected dispatch from a backward jump", async () => {
  const { driver, opts } = fixture(
    '[[steps]]\nid="rewind"\ndo="wait"\nms=0\ncapture={name="n",type="url"}\n' +
      '[[steps]]\nid="pay-${capture.n}"\ndo="press"\nkey="Enter"\neffect="at_most_once"\n' +
      'assert=[{type="url",url="http://localhost:3000/",match="exact"}]\n' +
      '[[steps]]\nid="check"\ndo="wait"\nms=0\non_fail={goto="rewind",max=1}\n' +
      'assert=[{type="url",url="https://example.test/missing",match="exact",when="before",timeout_ms=1}]',
  );
  const result = await runFlow(opts);
  expect(result.summary.verdict).toBe("failed");
  expect(driver.callsTo("press")).toHaveLength(1);
});

for (const alias of ["popup", "expect_page", "new_page"] as const) {
  test(`an unsupported keyboard ${alias} expectation is rejected before any browser acquisition`, async () => {
    const { driver, opts } = fixture(
      '[[steps]]\nid="open"\ndo="press"\nkey="Enter"\neffect="at_most_once"\n' +
        `${alias}={url="/never",timeout_ms=1}\n` +
        'assert=[{type="url",url="http://localhost:3000/",match="exact"}]',
    );
    const lint = await lintText(opts.flowSource, opts.flowPath, { fs: opts.fs, cwd: "/" });
    expect(lint.errorCount).toBeGreaterThan(0);
    expect(
      lint.diagnostics.some((item) => item.message.includes("Popup expectations require")),
    ).toBe(true);
    await expect(runFlow(opts)).rejects.toThrow("Popup expectations require");
    expect(driver.callsTo("connect")).toHaveLength(0);
    expect(driver.callsTo("press")).toHaveLength(0);
  });
}

for (const effect of ["at_most_once", "idempotent"] as const) {
  test(`an unmatched popup cannot pass on an unrelated assertion (${effect})`, async () => {
    const { fs, driver, opts } = fixture(
      `[[steps]]\nid="open"\ndo="click"\ntarget="role:button:Open"\neffect="${effect}"\n` +
        'popup={url="/missing",timeout_ms=1}\n' +
        'on_fail={goto="self",max=2}\nassert=[{type="url",url="https://example.test/opener",match="exact"}]',
    );
    driver.setSnapshot(
      makeSnapshot({
        url: "https://example.test/opener",
        interactiveElements: [makeInteractiveElement({ ref: "e1", role: "button", name: "Open" })],
      }),
    );
    driver.setBatchResult(makeSuccessBatch("role:button:Open", "click"));
    driver.setNewPageResult({ matched: false, reason: "popup expectation did not match" });
    const result = await runFlow(opts);
    expect(result.summary.verdict).toBe(effect === "at_most_once" ? "inconclusive" : "failed");
    expect(result.summary.steps[0]?.ok).toBe(false);
    expect(result.summary.drift_count).toBe(0);
    expect(driver.callsTo("batch")).toHaveLength(1);
    expect(await fs.fileExists("/flow.lock.toml")).toBe(false);
    if (effect === "at_most_once")
      expect(result.summary.inconclusive_reason).toContain("may have dispatched an at-most-once");
  });
}

for (const phase of ["before", "capture"] as const) {
  test(`an invalid ${phase} selector fails the step with its original dispatch state`, async () => {
    const { driver, opts } = fixture(
      '[[steps]]\nid="action"\ndo="press"\nkey="Enter"\neffect="at_most_once"\non_fail={goto="self",max=2}\n' +
        (phase === "before"
          ? 'assert=[{type="transition",kind="value_changed",selector="css:["}]'
          : 'capture={name="value",type="value",selector="css:["}'),
    );
    driver.onElementState(() => {
      throw new InvalidSelectorError("css:[ cannot be parsed");
    });
    const result = await runFlow(opts);
    expect(result.summary.verdict).toBe("failed");
    expect(result.summary.steps[0]).toMatchObject({
      ok: false,
      dispatchState: phase === "before" ? "not_dispatched" : "dispatched",
      retrySafe: false,
    });
    expect(result.summary.steps[0]?.error).toContain("invalid selector");
    expect(driver.callsTo("press")).toHaveLength(phase === "before" ? 0 : 1);
    expect(driver.callsTo("teardown")).toHaveLength(1);
  });
}

test("budget exhaustion retains its own inconclusive reason", async () => {
  const { opts } = fixture('[[steps]]\nid="wait"\ndo="wait"\nms=0');
  const result = await runFlow({
    ...opts,
    config: resolveConfigWithDefaults([{ run: { max_steps: 0 } }]),
  });
  expect(result.exitCode).toBe(3);
  expect(result.summary.inconclusive_reason).toBe("budget exceeded: max_steps");
});

test("step IDs cannot escape the screenshot directory", async () => {
  const { driver, opts } = fixture('[[steps]]\nid="../../../../escape"\ndo="wait"\nms=0');
  driver.setScreenshot("AA==");
  const result = await runFlow({
    ...opts,
    config: resolveConfigWithDefaults([{ browser: { record: true } }]),
  });
  expect(result.summary.verdict).toBe("passed");
  expect(result.summary.screenshot_paths).toHaveLength(1);
  for (const path of result.summary.screenshot_paths)
    expect(dirname(path)).toBe(`${result.runDir}/screenshots`);
});
