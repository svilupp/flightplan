// Flightplan — Phase 5 Unit F: opt-in video / frame capture at the driver boundary.
//
// Fully offline: no live Chrome, no real browser-pilot launch, no network. Covers
//  1. the run-dir video artifact path (`RunDir.videoWebm` → `<dir>/video.webm`),
//  2. the MockDriver record contract (start/stop/save + configurable fake artifacts),
//  3. that video is INERT by default (disabled → no capture calls, graceful nulls),
//  4. that BrowserPilotDriver exposes the capability and degrades gracefully when not
//     connected (no Chrome required).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveRunDir } from "../artifacts/run-dir.ts";
import { BrowserPilotDriver } from "./browser-pilot-driver.ts";
import { MockDriver } from "./mock-driver.ts";

describe("run-dir video artifact path (Unit F)", () => {
  test("resolveRunDir exposes <dir>/video.webm", () => {
    const rd = resolveRunDir({ baseDir: "/tmp/fp-video-test", runId: "vid-1" });
    expect(rd.videoWebm).toBe(join(rd.dir, "video.webm"));
    expect(rd.videoWebm).toBe(join(rd.baseDir, "vid-1", "video.webm"));
  });
});

describe("MockDriver video capture (Unit F)", () => {
  test("records start/stop/save and returns the configured fake artifacts", async () => {
    const d = new MockDriver();
    const rd = resolveRunDir({ baseDir: "/tmp/fp-video-test", runId: "vid-2" });
    d.setVideoPath(rd.videoWebm);

    await d.startRecording({ dir: rd.screenshotsDir });
    const shotPath = join(rd.screenshotsDir, "step-0.png");
    const shot = await d.saveScreenshot(shotPath);
    const video = await d.stopRecording();

    // start recorded the dir; save echoed the requested path; stop returned the fake video.
    expect(d.lastRecordingDir).toBe(rd.screenshotsDir);
    expect(shot).toBe(shotPath);
    expect(video).toBe(rd.videoWebm);

    // the call log captured every invocation, in order, with args.
    expect(d.callsTo("startRecording")).toHaveLength(1);
    expect(d.callsTo("saveScreenshot")).toHaveLength(1);
    expect(d.callsTo("stopRecording")).toHaveLength(1);
    expect(d.callsTo("startRecording")[0]?.args[0]).toEqual({ dir: rd.screenshotsDir });
    expect(d.callsTo("saveScreenshot")[0]?.args[0]).toBe(shotPath);
  });

  test("stopRecording defaults to null (graceful 'no video produced')", async () => {
    const d = new MockDriver();
    expect(await d.stopRecording()).toBeNull();
  });

  test("saveScreenshot can be scripted to fail (returns null)", async () => {
    const d = new MockDriver().setSavedScreenshotPath(null);
    expect(await d.saveScreenshot("/runs/r/screenshots/x.png")).toBeNull();
  });

  test("video is inert by default — no capture calls unless the runner opts in", async () => {
    const d = new MockDriver();
    // a normal (record-disabled) run only does page ops; it never touches recording.
    await d.snapshot();
    await d.batch([]);
    expect(d.callsTo("startRecording")).toHaveLength(0);
    expect(d.callsTo("stopRecording")).toHaveLength(0);
    expect(d.callsTo("saveScreenshot")).toHaveLength(0);
  });

  test("reset() clears the recording dir but keeps configured defaults", async () => {
    const d = new MockDriver().setVideoPath("/runs/r/video.webm");
    await d.startRecording({ dir: "/runs/r/screenshots" });
    expect(d.lastRecordingDir).toBe("/runs/r/screenshots");
    d.reset();
    expect(d.lastRecordingDir).toBeUndefined();
    expect(d.callsTo("startRecording")).toHaveLength(0);
    // the configured fake video path survives reset (it is a default, not call state).
    expect(await d.stopRecording()).toBe("/runs/r/video.webm");
  });
});

describe("BrowserPilotDriver video capability (offline, no Chrome)", () => {
  test("implements the optional record methods and degrades gracefully when not connected", async () => {
    const d = new BrowserPilotDriver();
    expect(typeof d.startRecording).toBe("function");
    expect(typeof d.stopRecording).toBe("function");
    expect(typeof d.saveScreenshot).toBe("function");

    // No connect() → no page. None of these throw; saveScreenshot/stopRecording return null
    // (fail-safe). startRecording just stores intent (engages on the next batch, post-connect).
    await d.startRecording({ dir: "/tmp/fp-video-test/never-written" });
    expect(await d.saveScreenshot("/tmp/fp-video-test/never-written/step-0.png")).toBeNull();
    expect(await d.stopRecording()).toBeNull();
  });
});
