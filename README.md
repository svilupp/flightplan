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
full flag list (`--json`, `--frozen`, `--no-lock-write`, `--lock`, `--from`).

AI tiers (L2 resolver / L3 vision / L4 advisor, plus `ai_judge` / `ai_pick`) require an
OpenRouter key — see [`.env.example`](.env.example) and [`docs/RUNNING.md`](docs/RUNNING.md)
for the full validation-campaign runbook.

## Example flows

The nine flows in [`examples/flows/`](examples/flows/) map 1:1 to the fixture pages
([`examples/fixtures/README.md`](examples/fixtures/README.md)):

`wizard` · `async` · `rerender` · `overlays` · `contexts` · `gauntlet` · `drift` ·
`signature` · `vision`

## Status

Under active development. See [`docs/PLAN.md`](docs/PLAN.md) for the design and phased build plan.