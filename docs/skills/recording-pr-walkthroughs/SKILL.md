---
name: recording-pr-walkthroughs
description: Record browser feature walkthroughs with browser-pilot and Flightplan. Use when a pull request needs a short demo video of a UI change or a workflow replay.
---

# Recording PR walkthroughs

Show one user-visible change and its result. Use a demo account or fixture data and
get past sign-in before recording. Chrome captures the tab's actual pixels.

Use browser-pilot CLI 0.9.0 or newer. Use the default browser-pilot daemon when
Flightplan drives the tab.

1. Set up the starting screen in local desktop Chrome 153 or newer. With remote
   debugging enabled, run `bp connect --name demo --target-url localhost:3000`,
   substituting the preview URL. Check the selected tab with `bp targets -s demo`.
   Use `bp use-target <id> -s demo` if you need to pin a different tab.
2. Start the recorder from the project directory. Wait for the recording message
   before driving the tab. The optional label displays briefly at the start.

   ```sh
   bp record video -s demo -f .flightplan-runs/walkthrough.mp4 --label "Save a filtered view"
   ```

   Use a new filename for each take. From a browser-pilot source checkout, use
   `bun run dev:bp` in place of `bp` if the installed CLI lacks `record video`.
   Use an absolute output path when recording from that checkout.
3. Drive that tab with `bp exec -s demo` or by hand. Pause briefly on the result,
   then stop the recorder with Ctrl+C or send SIGINT to its process. For a
   Flightplan replay, lint the flow first and let the session handback save the clip.

   ```sh
   flightplan lint demo.toml &&
     flightplan run demo.toml --session demo --frozen --no-lock-write
   ```

   For a replay, check that the outcome assertion passed. Keep a walkthrough on
   one tab and aim for 15–45 seconds. The recorder defaults to 90 seconds.
4. Play back the clip and check that the result is visible. For broad GitHub
   playback, convert the AV1 MP4 to H.264 if `ffmpeg` is available.

   ```sh
   ffmpeg -n -i .flightplan-runs/walkthrough.mp4 -c:v libx264 -crf 24 -pix_fmt yuv420p \
     -movflags +faststart .flightplan-runs/walkthrough-github.mp4
   ```

   Use 10 MB as the size limit for free GitHub plans. Return the local clip path.
   When the user asks to attach it, use the PR editor or `gh pr comment --attach`
   if the installed GitHub CLI supports it. [GitHub attachment limits and codecs](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files) · [GitHub CLI attachments](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli)

## If native recording is unavailable

`bp record video` checks the connected build by calling `Page.startScreenRecording`.
Try current desktop Chrome. If the target must stay on its existing build, use
the system screen recorder for a manual clip or `bp exec --record` for screenshots.
