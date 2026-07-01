# Examples

Runnable examples for flightplan: nine example flow definitions and the demo HTTP server
they run against.

- [`flows/`](flows/) — nine `*.toml` example flow definitions, one per resolution rung
  (`wizard` · `async` · `rerender` · `overlays` · `contexts` · `gauntlet` · `drift` ·
  `signature` · `vision`). Each flow maps 1:1 to a fixture page.
- [`fixtures/`](fixtures/) — a self-contained, **zero-dependency** Bun HTTP server that serves
  nine deterministic HTML pages, one per flow. See [`fixtures/README.md`](fixtures/README.md)
  for the full route → tier → expected-state contract.

## Run

Two steps, from the repo root. First start the fixture server (terminal 1):

```sh
bun run examples/fixtures/server.ts   # serves http://localhost:3000 (alias: bun run fixtures)
```

Then run a flow against it (terminal 2). The example flows resolve deterministically (L0/L1)
and need no API key:

```sh
bun run flightplan run examples/flows/wizard.toml
```

The model-tier flows (`gauntlet`, `vision`, `drift`, `signature`) need an OpenRouter key — see
[`../docs/RUNNING.md`](../docs/RUNNING.md) for the full validation-campaign runbook.
