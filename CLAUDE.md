# CLAUDE.md

Flightplan is a TOML-defined browser workflow runner. It executes ordered steps with deterministic
assertions, effect-aware retries, selector locks, and a layered resolver. The full design and user
guide are in `README.md`; contract details are in `docs/`.

## Key references

- `src/flow/` — TOML schemas, normalization, templating, imports, and composition.
- `src/runner/runner.ts` — execution, retries, assertions, artifacts, and teardown.
- `src/driver/` — the browser-pilot boundary and `MockDriver` test seam.
- `src/artifacts/` and `src/redaction/` — run evidence and fail-closed secret handling.
- `scripts/check.ts` and `scripts/run-quiet` — quiet development checks and retained per-leg logs.
- `docs/BROWSER_PILOT_INTEGRATION.md` — recording-to-TOML workflow and browser integration contract.
- `docs/skills/` — authoring and automation skills shipped with the project.

## Operational instructions

- Author targets with durable selectors first and concise natural language last. Never persist
  browser-pilot `ref:eN` values; translate them to durable Flightplan selectors or intent.
- Mark mutation-capable steps with an explicit effect. `webmcp_call` must name one exact page tool;
  keep reads as `observe`, acknowledge mutations with `idempotent` or `at_most_once`, and assert
  meaningful result postconditions.
- Keep credentials and sensitive values in environment variables. Mark secret inputs, values, and
  result captures so artifacts and summaries remain redacted.
- Use `flightplan lint` before execution. Promote a learned lock only after assertions pass and its
  diff is reviewed; use `--frozen --no-lock-write` for CI or shared replay.
- Run output belongs under `.flightplan-runs/` (or an explicit `-o` directory). Keep raw WebMCP
  inputs/results out of artifacts unless a deliberately redacted capture is required.

## Checks and build

Checks are quiet by default. Each leg prints a short status block and the path to its complete
temporary log; failures print the captured diagnostics.

```sh
bun run check        # lint + typecheck + tests
bun run lint         # one quiet lint leg
bun run typecheck    # one quiet typecheck leg
bun run test         # one quiet test leg
bun run build        # production build
```

## Git policy

Do not run git write operations (commit, push, merge, rebase, staging, reset, branch changes, tags,
or PR creation) unless the user explicitly requests that operation.
