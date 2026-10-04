# Examples

Runnable Flightplan examples include local deterministic fixtures and opt-in
external website workflows.

- [`flows/`](flows/) — local `*.toml` flow definitions for fixture scenarios
  (`wizard` · `async` · `rerender` · `overlays` · `contexts` · `gauntlet` · `drift` ·
  `signature` · `vision` · `cf-access-example`). Each of the nine fixture-scenario flows maps
  1:1 to a fixture page; `cf-access-example.toml` reuses the `wizard` fixture page to
  demonstrate `[config.auth]` (Cloudflare Access) wiring without needing a real
  Access-protected origin. Cookie-state examples document saved login wiring;
  SauceDemo checkout and locked-user flows target the public website described below.
- [`fixtures/`](fixtures/) — a self-contained, **zero-dependency** Bun HTTP server that serves
  nine deterministic HTML pages, one per flow. See [`fixtures/README.md`](fixtures/README.md)
  for the full route → tier → expected-state contract.

## Run

The fixture server and Bun commands below are for this repository checkout. In a published
consumer project, use `flightplan ...`, `npx flightplan ...`, or `bunx flightplan ...` (see the root
README quick start).

From the repo root, start Chrome/Chromium with remote debugging enabled at `localhost:9222`, or
add a `[config.connect]` block with `mode = "launch"` to the flow. Then start the fixture server
in terminal 1:

```sh
bun run examples/fixtures/server.ts   # serves http://localhost:3000 (alias: bun run fixtures)
```

Then run a flow against it (terminal 2). The deterministic examples resolve at L0/L1 and need no
API key. A warm lock replay that stays at L0 can also be keyless. Cold runs that escalate to
L2-L5, or `ai_pick`/AI assertion steps that invoke a model, need `OPENROUTER_API_KEY`:

```sh
bun run flightplan run examples/flows/wizard.toml
```

`examples/flows/cf-access-example.toml` lints and runs against the fixture server like any other
example; its `[config.auth.cf_access]` block is a documentation placeholder — replace `url` and
the commented `[[config.auth.cookies]]` `domain` with your real Access-protected origin, and
export the referenced env vars (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, ...) before
pointing it at one; against the fixture server it is a no-op because that origin has no Access
policy.

To lint all checked-in examples, pass the directory. Flightplan expands this form to the flow
files and excludes committed `*.lock.toml` sidecars:

```sh
bun run flightplan lint examples/flows
```

## Author a flow from browser-pilot

Use the released browser-pilot package in the project where you capture a workflow. Record and
inspect the manual workflow, derive it for reference, then translate the actions and assertions by
hand into Flightplan TOML. Do not copy `ref:eN` values into a flow or lock; they are ephemeral.

```sh
bp record -s flightplan-dev --profile automation -f artifacts/example.recording.json
bp record summary artifacts/example.recording.json
bp record inspect artifacts/example.recording.json
bp record derive artifacts/example.recording.json -o artifacts/example.workflow.json
# Use a real flow path; this repository's checked-in example is wizard.toml.
bun run flightplan lint examples/flows/wizard.toml
bun run flightplan run examples/flows/wizard.toml
bun run flightplan run examples/flows/wizard.toml --frozen
```

The complete translation table and lock-promotion rules are in
[`../docs/BROWSER_PILOT_INTEGRATION.md`](../docs/BROWSER_PILOT_INTEGRATION.md).

The model-tier flows (`gauntlet`, `vision`, `drift`, `signature`) need an OpenRouter key when
they invoke their AI tier or an AI assertion. A warm replay can be keyless only when it stays at
L0 and executes no AI-backed step or assertion. See
[`../docs/BENCHMARK.md`](../docs/BENCHMARK.md) for the validation methodology.

## SauceDemo public demo

[`flows/saucedemo-checkout.toml`](flows/saucedemo-checkout.toml) logs in as the
public `standard_user`, adds one Sauce Labs Backpack and one Sauce Labs Bike
Light, checks both cart rows and quantities, fills demo checkout information,
verifies subtotal $39.98 / tax $3.20 / total $43.18, and finishes the simulated
order. Completion requires the exact `Thank you for your order!` heading and
an empty cart. [`flows/saucedemo-locked-user.toml`](flows/saucedemo-locked-user.toml)
verifies the exact locked-out-user error and that login remains visible.
These are network-dependent website examples, not pages served by our fixture
server. They use durable `data-test` selectors, explicit effects, never-retry
mutations and deterministic assertions; no AI key is required.

Set `SAUCEDEMO_PASSWORD` locally to the public demo password displayed on
[the login page](https://www.saucedemo.com/). The flow stores only an environment
reference and redacts the password input. The recorded validation used a disposable Chrome profile with credential
saving disabled. On Chrome 154, a default fresh profile acknowledged Backpack mouse
input but delivered no page mouse events; the cart did not change. Coordinates,
hit target and document visibility were correct. `--enable-automation` alone did
not resolve it. Disabling credential storage in that disposable profile restored
input and the exact completion assertions. This implicates profile/browser UI
state but does not identify a particular native dialog.

Lint either standalone flow:

```sh
bun run flightplan lint examples/flows/saucedemo-checkout.toml
bun run flightplan lint examples/flows/saucedemo-locked-user.toml
```

Run the standalone flows with the public demo password set in your environment:

```sh
bun run flightplan run examples/flows/saucedemo-checkout.toml --frozen --no-lock-write
bun run flightplan run examples/flows/saucedemo-locked-user.toml --frozen --no-lock-write
```

Inspect each run's `summary.json`, `run.jsonl`, `trace.jsonl` and checkout
`order-complete.png` in `.flightplan-runs/`. Website availability/content can
change, so these examples are opt-in. This mock completion requires no card
and proves neither Adyen integration nor real payment support.

For standalone `flightplan run`, use an isolated profile with credential saving
disabled and set `[config.connect] userDataDir` to that profile's path. Set
`Default/Preferences` to use `credentials_enable_service = false`
and `profile.password_manager_enabled = false` before launch, then delete the
profile after Chrome exits. Apply these settings only to the disposable automation
profile, never the user's normal Chrome profile. Without that setup, the initial
Chrome 154 failure remains a documented negative. The default TOML intentionally
contains no machine-specific profile path.

### Hosted Cloudflare Chromium

Native hosted runs need `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
Use the [hosted connection configuration](../docs/cloudflare-hosted.md#flow-configuration)
in a copy of either flow, replacing its `[config.connect]` launch block.
Set `SAUCEDEMO_PASSWORD` to the public demo password before running the CLI.
Hosted runs allocate a billable browser. Public SauceDemo needs no Cloudflare
Access service token.
