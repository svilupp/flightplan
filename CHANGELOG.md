# Changelog

Semver. Each release gets a short, user-facing note: what changed for someone *using* the platform (operators, API consumers, deployers), not internal refactors. Keep entries minimal - one line where possible, grouped under `Added` / `Changed` / `Fixed` / `Removed` only when needed.

## [Unreleased]

### Added

### Fixed

## [0.0.2] - 2026-08-12

### Added

- **Native Google and OpenAI providers.** `[ai].provider = "google" | "openai"` routes through the native SDKs (provider-matched `api_key_env` defaults); model ids may carry a `:effort` suffix (`minimal|low|medium|high|xhigh`) to set reasoning effort. Default output-token cap raised to 4000 to make room for reasoning tokens.
- **`emit` step verb.** Send a message on a WebSocket the page already owns (via browser-pilot's `page.emitMessage`), optionally waiting for a correlated reply; always `at_most_once` and never persisted to lock files.
- **`[config.ai.models.default]` block.** One model block that serves as the default for every AI role (`resolver`, `advisor`, `vision`, `planner`, `planner_capable`) unless a specific role block overrides it. Precedence per role, field-by-field: explicit role field > `default` field > built-in registry; role blocks deep-merge over `default`. `fallbacks` arrays replace wholesale rather than merging — if `default` sets `model` but omits `fallbacks`, roles keep the built-in OpenRouter fallback slugs, so set `fallbacks = []` in `default` when routing to a non-OpenRouter provider.

### Changed

- **Browser-pilot 0.1.0 → 0.2.1.** Required for the new `emit` step verb.

### Compatibility

- Older flightplan versions reject `[config.ai.models.default]` as an unknown key under strict schema validation; this is not forward-compatible with older CLIs.

## [0.0.1] - 2026-07-12

### Added

- **Layered selector resolution and healing.** Flightplan replays learned selectors deterministically, falls back through DOM, text, vision, and bounded path repair, and records successful strategies for later runs.
- **Optional AI recovery.** Text, vision, and advisor tiers, batched vision resolution, advisory target memory, and opt-in path repair extend recovery when deterministic resolution cannot settle a target.
- **Safer browser execution.** Effect-aware steps, dispatch evidence, postconditions, and popup expectations prevent uncertain clicks from being repeated. Runs can attach to an existing Chrome session for background operation or launch an isolated headless browser.
- **Flow authoring and composition.** Locator lists, exact and scoped assertions, imports with `run` steps, bounded path repair, and `--from` / `--to` slices make flows easier to author and operate.
- **Browser-pilot authoring path.** Record and inspect a manual workflow with `bp record`, use `summary`, `inspect`, and `derive` as translation aids, then write and review durable Flightplan TOML and locks. Session-scoped refs are not persisted.
- **Repeatable validation and examples.** Bun checks, dependency-boundary verification, example linting, run artifacts, and benchmark reporting cover deterministic and AI-backed fixture flows.

### Changed

- **Lock and cache behavior.** Existing locks migrate to the current format; ranked selector strategies account for successful runs and drift, volatile page regions can be ignored, and a valid cached selector can be revalidated after a signature change.
- **Assertions.** CSS and test-id selectors can target non-interactive DOM nodes through live element state, with exact text and state or transition checks for clearer outcomes.
- **Documentation and release guidance.** Consumer guidance uses released browser-pilot packages and covers attach or launch setup, recording-to-TOML translation, lock promotion, frozen replay, examples, and benchmark interpretation.
- **Operating limits are explicit.** Same-origin iframe actions require an explicit frame switch; direct targeting inside an unentered frame is unsupported. Vision, AI assertions, and planner paths require `OPENROUTER_API_KEY`; visual occlusion and mid-run reconnect are outside deterministic guarantees.

### Fixed

- **Lock safety.** Frozen replay is read-only and fails closed for invalid locks or changed flows, and lock updates are credited only after the full step passes its assertions.
- **Action and assertion correctness.** `visible` and `hidden` checks honor text, secret navigation and selection values stay redacted, and imported step-id collisions are reported instead of silently selecting one.
