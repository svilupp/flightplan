# flightplan

A TOML-defined browser-automation flow runner. A flow file describes a browser task as an
ordered list of steps with attached assertions; flightplan executes it, self-heals selector
drift through a layered cost ladder, and validates outcomes through deterministic assertions.

Built on Bun + TypeScript + AI SDK v6 + browser-pilot.

## Quickstart

Install and sanity-check:

```sh
bun install
bun run flightplan --help
bun test
```

Start the local fixture server — nine deterministic HTML pages, one per resolution rung
(see [`examples/fixtures/README.md`](examples/fixtures/README.md)):

```sh
bun run fixtures               # serves http://localhost:3000 (alias for: bun run examples/fixtures/server.ts)
PORT=4000 bun run fixtures     # override the port
```

It logs its listening URL on start; `GET /healthz` returns `200 ok`.

With the server running, run an example flow against it. The example flows resolve
deterministically (L0/L1) and need no API key:

```sh
bun run flightplan run examples/flows/wizard.toml
```

## Commands

```sh
bun run flightplan lint examples/flows/wizard.toml      # validate a flow/config file (dir or glob also accepted)
bun run flightplan explain <run-dir>           # human-readable diagnosis of a completed run
bun run flightplan report .flightplan-runs/    # aggregate runs into campaign metrics
```

Runs are written to `.flightplan-runs/<run-id>/` by default; override with `-o <dir>`.
`explain` accepts a run directory or a `run.jsonl` path. `report` accepts one or many run
directories, or a campaign root that holds them (as shown). Run `flightplan --help` for the
full flag list (`--json`, `--frozen`, `--no-lock-write`, `--lock`, `--from`, `--to`).

AI tiers (L2 resolver / L3 vision / L4 advisor, plus `ai_judge` / `ai_pick`) require an
OpenRouter key — see [`.env.example`](.env.example) and [`docs/plans/RUNNING.md`](docs/plans/RUNNING.md)
for the full validation-campaign runbook.

## Browser connection

By default (no `[connect]` block) flightplan **attaches to a running Chrome over CDP at
`localhost:9222`**. Start Chrome with remote debugging enabled first:

```sh
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
# Linux
google-chrome --remote-debugging-port=9222
```

Attach explicitly, or point at a different endpoint (`browserURL` accepts `host:port` or
`http://host:port`; a missing port defaults to 9222; precedence is `wsUrl` → `browserURL` →
`autodiscover`):

```toml
[connect]
mode = "attach"
browserURL = "localhost:9223"
# wsUrl = "ws://localhost:9222/devtools/browser/<id>"   # most deterministic
# autodiscover = { channel = "canary", userDataDir = "/path/to/profile" }
```

Or let flightplan launch its own Chrome:

```toml
[connect]
mode = "launch"
headless = true                 # default
# channel = "stable"
# userDataDir = "/path/to/profile"
# chromeFlags = ["--window-size=1280,800"]
```

The **entry flow's `[connect]` is authoritative**: flows pulled in via `imports` are step
libraries only — their config, including any `[connect]`, is ignored.

## Example flows

The nine flows in [`examples/flows/`](examples/flows/) map 1:1 to the fixture pages
([`examples/fixtures/README.md`](examples/fixtures/README.md)):

`wizard` · `async` · `rerender` · `overlays` · `contexts` · `gauntlet` · `drift` ·
`signature` · `vision`

## Flow syntax

A step's `target` is an ordered **locator list** (`string | string[]`) — selectors first, one
concise natural-language entry last. An entry is a selector only if it starts with a whitelisted
prefix (`ref:`, `role:`, `text:`, `css:`) or `[`; everything else is natural language fed to the
fuzzy/AI tiers:

```toml
[[steps]]
id = "advance_to_plan"
do = "click"
target = ["[data-testid='wizard-next-1']", "the Next button"]
```

Steps may also be written as a compact inline-table array instead of `[[steps]]` blocks — useful
for simple, assert-light steps (assert-heavy steps stay more readable as `[[steps]]` +
`[[steps.assert]]`):

```toml
steps = [
  { id = "open", do = "goto",  url = "${inputs.base_url}/wizard" },
  { id = "name", do = "fill",  target = ["[data-testid='wizard-name']", "full name field"], value = "${inputs.full_name}" },
  { id = "next", do = "click", target = ["[data-testid='wizard-next-1']", "Next button"] },
]
```

Because TOML binds a bare key to the *most recent* table header, `steps = [...]` must appear
**before** any `[inputs]`/`[run]` table header in the file, or it silently nests under that table
instead of landing at the top level (`flightplan lint` catches this as `steps/toml-key-order`).

Flows compose via a library-and-run model: `imports` registers other flow files by id (and
composes their locks) but executes nothing by itself; a `do = "run"` step executes an imported (or
directly path-referenced) flow at that position, with `with` inputs:

```toml
imports = ["./auth/login.toml"]   # registers auth.login — nothing runs yet

[[steps]]
id = "login"
do = "run"
flow = "auth.login"                                 # by imported id (recommended) — or a path
with = { account = "${env.TEST_ACCOUNT}" }
```

`run` expansion is static (load-time): the child's steps splice in namespaced as
`<call-site-id>:<child-step-id>`, so the same sub-flow can be run at multiple call sites without
collision. Expanded child steps count toward the *parent's* `[run]` budgets, and `on_fail.goto`
targets must resolve within the same file — they cannot cross a `run` boundary.

### Vision routing — `tier_hint = "vision"`

A locator-targeting step (`click`/`fill`/`select`/`ai_pick`) may set `tier_hint = "vision"` for a
target that text tiers can't resolve — an icon-only button, a glyph, an Nth unlabeled element. The
free/deterministic tiers still run first (L0 cache/lock replay, L1 DOM heuristics); only when the
step must escalate does the AI climb **skip the L2 text tier and go straight to L3 vision** (then L4
if vision escalates). Don't burn a paid text call on a target text was never going to resolve.

```toml
[[steps]]
id = "save"
do = "click"
tier_hint = "vision"
target = "the floppy-disk save icon in the top toolbar"
```

When **two or more consecutive `tier_hint = "vision"` targeting steps sit on the same page** —
uninterrupted by any navigation, `wait`, `press`, standalone `assert`, or a non-hinted targeting
step — flightplan **batches** them into a single vision call: one screenshot, one request answers all
of them. (A hinted step carrying its own per-step `assert` or an `on_fail` is not batched — it falls
to the single-step path.) If the batch response is malformed or omits a target, that target cleanly
falls back to its own single vision call, so a bad batch answer never breaks the run. Batching needs
an AI runtime (`OPENROUTER_API_KEY`); without one the hint is inert and the step resolves
deterministically or fails at L1.

### Path-repair planner — `[plan]`

When a flow diverges from its recorded path — a step ran, but the page is no longer where the next
recorded step expects it — an optional **planner** proposes repair step(s) to get back on track and
splices them into the run, executed through the normal ladder within budget. It is a cheap-first
escalation tier (L5), a peer of the per-target ladder rather than part of it.

**The planner is DISABLED BY DEFAULT — it is strictly opt-in.** Even once enabled it is inert on any
run that lacks an AI runtime *or* a real divergence signal (a recorded lock expectation to compare
the current page against), so deterministic, no-key runs are unaffected. To turn it on:

```toml
[plan]
enabled = true
```

The `[plan]` block carries the planner *policy* (defaults shown):

```toml
[plan]
enabled             = false  # master switch; opt in with true
escalate_confidence = 0.5    # cheap-arm confidence at/below which it escalates to the capable arm
escalate_attempts   = 2      # cheap attempts for one divergence before escalating
# max_replans        = 5     # run-level cap on total replans (unset → unlimited; also settable on [run])
```

Cheap-first is mandatory: the planner defaults to a cheap model (`[ai.models.planner]`). The
capable/dueling arm (`[ai.models.planner_capable]`) is **escalation-only** — it fires only on the
low-confidence or repeated-replan signal above — and is **UNPROVEN**; do not rely on it as a default.
The flow-level `goal` field (defaults to `description` when omitted) re-anchors non-local repairs and
keys the prompt cache:

```toml
goal = "complete checkout and reach the order-confirmation page"
```

`max_replans` bounds runaway repair; the planner requires `OPENROUTER_API_KEY` like the other AI
tiers. See [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) for its cost posture.

## Status

Under active development. See [`docs/plans/`](docs/plans) for the design and phased build plans.
For writing fast, low-cost flows see [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) (resolution model
+ authoring checklist) and [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) (current limitations and
workarounds).