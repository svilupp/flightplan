# Examples

Runnable examples for flightplan: ten example flow definitions and the demo HTTP server
they run against.

- [`flows/`](flows/) — ten `*.toml` example flow definitions, one per fixture scenario
  (`wizard` · `async` · `rerender` · `overlays` · `contexts` · `gauntlet` · `drift` ·
  `signature` · `vision` · `cf-access-example`). Each of the nine fixture-scenario flows maps
  1:1 to a fixture page; `cf-access-example.toml` reuses the `wizard` fixture page to
  demonstrate `[config.auth]` (Cloudflare Access) wiring without needing a real
  Access-protected origin.
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
