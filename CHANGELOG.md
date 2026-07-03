# Changelog

Semver. Each release gets a short, user-facing note: what changed for someone *using* the platform (operators, API consumers, deployers), not internal refactors. Keep entries minimal — one line where possible, grouped under `Added` / `Changed` / `Fixed` / `Removed` only when needed.

## [Unreleased]

### Added

- **Unified targeting — `target` is a locator list (clean break).** A step's `target` is now
  `string | string[]`: selector entries (prefixed `ref:`/`role:`/`text:`/`css:`, or starting with
  `[`) feed the L1 selector array in author order, and the first natural-language entry feeds the
  fuzzy/AI tiers. `hints` and `intent` are **removed** from the schema — not deprecated, gone — a
  pre-v002 flow using either now fails lint with `steps/removed-targeting-fields`, which spells out
  the fold into one `target` list. `steps/no-raw-selector` is retired (selectors are now legal
  directly in `target`); `steps/target-needs-nl` and `steps/target-unprefixed-selector` (warnings)
  take its place. All `examples/flows/*.toml` are migrated to the new form.
- **Compact inline-table step syntax, documented and blessed.** `steps = [{ id = "...", do = "..." ,
  ... }]` was already valid against the schema and is now first-class: use it for simple,
  assert-light steps; keep `[[steps]]` + `[[steps.assert]]` for assert-heavy ones. New lint rule
  `steps/toml-key-order` catches the TOML footgun where `steps = [...]` placed after an `[inputs]`/
  `[run]` table header silently nests as `inputs.steps`/`run.steps` instead of landing at the top
  level.
- **Composition: imports are a library, `run` executes.** `imports` now only *registers* modules
  (bringing each flow's `id` into scope and composing locks) — it never executes anything by
  itself, and simplifies to `string | string[]` (the `[[imports]]` table form and import-site
  `with` are gone). A new `do = "run"` step executes a flow — by imported id (recommended) or by
  direct path — at that position, with `with` inputs. Expansion is static at load time: the
  child's steps splice into the parent, namespaced `<call-site-id>:<child-step-id>`, so the same
  sub-flow can run at multiple call sites without collision. Expanded steps count toward the
  *parent's* `[run]` budgets (a child's own `[run]` block only applies when it runs standalone),
  and `on_fail.goto` stays file-scoped — it cannot jump across a `run` boundary.
- **`flightplan run --to <step-id>`, the counterpart to `--from`.** Stops a run after the named
  step, inclusive — use it alone to run a flow up to a given step for debugging, or combine with
  `--from <step-id>` to run just a slice. Both flags resolve against the load-time-flattened step
  list, so namespaced ids from `run` steps (`<call-site-id>:<child-step-id>`) work for either end.
  Setup/teardown hooks are unaffected by either flag — they always run, since they execute outside
  the sliced step list. An unknown `--to` (or, when combined with `--to`, an unknown `--from`) id
  now fails the run with a clear error instead of silently running the whole flow; an inverted
  range (`--from` after `--to`) fails the same way.
- **Lint catalog additions for the above.** `steps/removed-targeting-fields`,
  `steps/target-present`, `steps/target-needs-nl`, `steps/target-unprefixed-selector`,
  `steps/text-hint-unscoped`, `steps/toml-key-order`, `imports/unique-ids`, `imports/no-with`,
  `imports/unused-import`, `run/flow-in-scope`, `templating/with-inputs-declared`,
  `assert/screenshot-needs-vision`, `assert/end-state-unasserted`, `templating/unused-input`,
  `lock/orphaned-target`, `security/unmarked-secret`. `steps/no-raw-selector` is retired.
- **AI-step "note-to-future-self" (advisory context).** Each lock target may now carry an optional
  `[targets.memory]` block (`note` + `note_updated`) — a sparse, freeform hint that only matters when
  an AI tier already runs. When the resolver (L2) or vision (L3) resolves a target, a FRESH stored
  note is prepended to its prompt as extra context ("last time: icon-only toolbar, floppy-disk glyph
  top-right, no testid"), and the model may EMIT an updated note via structured output. Notes are
  **advisory only**: they never gate correctness (assertions stay authoritative) and never change
  tier routing (the prescribed L0→L1 path always runs first). They are **redacted** (secrets/PII
  masked before the note reaches the committed lock or `ai.jsonl`) and **decayed** (a note older than
  45 days is not fed back into a prompt and is dropped on the next write). Under `--frozen` a stored
  note is read for context but never written.
- **Learned selector playbook (lock format v1 → v2).** Each lock target now stores a ranked
  strategy **portfolio** (`[[targets.strategies]]` — `kind` / `selector` / `greens` / `last_ok` /
  `last_drift`) instead of a single winner plus flat candidates. The target remembers *every* way it
  has successfully found an element, each with its own track record, and self-orders by a
  deterministic recency-weighted score. At L0 the top strategies are RACED over one shared snapshot
  (0 AI): when several resolve to the same element it acts with high confidence and credits them all;
  when they disagree it prefers the best-track-record strategy corroborated by the element's
  role+accessible-name and demotes the disagreeing ones; drift becomes a re-ranking event, not a
  cache break. The Layer-3 per-target revalidation is now a thin adapter over this one race (no
  parallel code path). The run trace surfaces the winning strategy + agreement count (e.g.
  `strategy:"testid", agreement:"3/4"`) so `report`/`explain` can show portfolio health.
  - _Auto-migration:_ old v1 locks (winner + `candidates` + `green_runs`) load and migrate in memory
    to the portfolio form on the first read (winner → first strategy carrying its `green_runs`→
    `greens` / `last_seen`→`last_ok`; candidates → further strategies), and re-serialize as pure v2
    on the next non-frozen write. No run fails on migration; committed locks (e.g.
    `examples/flows/wizard.lock.toml`) load unchanged.
  - _Decay/prune:_ a strategy whose most recent event is a drift is capped below fresh ones, greens
    decay by an exponential recency weight, and the portfolio is capped at `K_MAX` (6) — the
    lowest-scored strategies are dropped.
  - _`--frozen`:_ the portfolio is READ-ONLY — resolution still uses the ranked race + agreement
    logic, but no track records are written.
- **L0 cache-hit quality.** The L0 cache signature now ignores volatile page regions by default and
  can recover from a signature miss without paying for AI re-resolution:
  - _Volatile-text masking (zero-config):_ the text component of `match.sig` is now computed from
    the accessibility tree and excludes dynamic regions (ARIA `status`/`alert`/`log`/`timer`/
    `progressbar`/`marquee` roles, `[aria-live]`, `[data-live]`, and `hidden`/`aria-hidden`
    subtrees). A live counter, clock, or feed no longer forces an L0 miss.
  - _New `[cache]` config block:_ `ignore_regions = [...]` (CSS selectors excluded from BOTH the
    text and structural hashing) and `signature = "full" | "struct-only"` (struct-only trusts a
    cached recipe while the role-tree skeleton is unchanged, even if the masked text drifts). A
    targeting step may override the mode with `cache = "full" | "struct-only"`.
  - _Per-target revalidation on an L0 miss:_ when the page signature no longer matches, L0 first
    checks whether the cached selector still uniquely resolves the locked target in the current
    snapshot; if so it replays as an L0 hit (0 AI calls, no L2/L3 escalation) rather than
    re-resolving. The run trace marks these with an `l0_revalidated` note. Under `--frozen`, a lock
    with a stale signature but a still-valid selector now HITs via revalidation instead of failing.

- **Adaptive-resolution follow-ups (Phase B).** Batched vision resolution (resolve multiple unlabeled
  targets on a page from a single screenshot / single call, with per-target fallback on a malformed
  batch response); tightened note-field guardrails (persist a note only from a corroborated /
  high-confidence pick and sanitize volatile tokens — index / testid / label — before it reaches the
  lock); and additional lint rules for the resolution surface.
- **`tier_hint = "vision"` routing.** A locator-targeting step (`click`/`fill`/`select`/`ai_pick`)
  may set `tier_hint = "vision"` for a target text tiers can't resolve (icon-only button, glyph, Nth
  unlabeled element). The free tiers still run first (L0 cache/lock, L1 DOM); only on escalation does
  the AI climb SKIP the L2 text tier and go straight to L3 vision (then L4). Inert without an AI
  runtime.
- **Vision batching.** When ≥2 consecutive `tier_hint = "vision"` targeting steps sit on the same
  page — uninterrupted by any navigation, `wait`, `press`, standalone `assert`, or non-hinted step —
  flightplan resolves them from ONE screenshot + ONE vision call instead of one call each (measured
  ~79.5% cheaper / ~74.7% faster on an 8-icon batch). A hinted step with its own `assert` or `on_fail`
  is not batched. The batch response is strict-JSON parsed with clean per-target fallback to a single
  call for any target it does not cleanly answer (malformed/missing/duplicated key), so a bad batch
  never breaks the run.
- **Path-repair planner (L5), `[plan]`.** When a flow diverges from its recorded path (a step ran but
  the page is no longer where the next recorded step expects), an optional cheap-first planner
  proposes repair step(s) and splices them into the run, executed through the normal ladder within
  budget. It is a peer of the per-target ladder, not part of it. **DISABLED BY DEFAULT — strictly
  opt-in** — and even when enabled it is inert unless BOTH an AI runtime is present AND a real
  divergence signal exists (a recorded lock expectation for the next step); no-AI-runtime runs stay
  byte-identical. Enable with `[plan]\nenabled = true`. Policy fields on `[plan]`: `enabled`
  (default `false`), `escalate_confidence` (default `0.5`), `escalate_attempts` (default `2`),
  `max_replans`. Cheap-first is mandatory (the cheap `[ai.models.planner]` model); the
  capable/dueling arm (`[ai.models.planner_capable]`) is escalation-only and **UNPROVEN**. Prompt
  caching is mandatory (keyed on the flow `goal`). Requires `OPENROUTER_API_KEY`.
- **Flow-level `goal` field.** The durable WHAT a flow accomplishes. Optional — defaults to the flow
  `description` when omitted. Load-bearing for the path-repair planner's non-local repairs (it
  re-anchors a divergence far from the intent) and keys the planner's prompt cache.
- **`max_replans` budget.** A run-level hard stop on total path-repair replans, settable on `[plan]`
  or `[run]` (with `[run]` winning). Bounds runaway repair so a pathological page cannot drive
  unbounded planner spend; exceeding it maps to the `inconclusive` verdict like the other budget
  ceilings. Unset → unlimited.
- **Assertions resolve CSS/testid selectors via the driver (`Page.elementState`).** flightplan now
  consumes browser-pilot's `Page.elementState` primitive. `visible`/`hidden`/`text`/`value`/`count`
  assertions resolve arbitrary CSS and `[data-testid]` selectors — including compound selectors
  (`div.card`, `css:tr`) and selectors on **non-interactive** nodes — against the live DOM, instead
  of name-matching only interactive elements in the accessibility snapshot. A `css:`-prefixed
  assertion selector is now the same escape hatch for bare CSS it is in a step `target` (prefix
  stripped before it reaches the driver). This lifts the long-standing "asserts can't match
  `[data-testid]`/CSS on non-interactive elements" limitation. The delegation is feature-detected: a
  driver without `elementState` falls back to the accessibility-snapshot path unchanged (no
  regression).
- **Docs: performance & known-issues.** New `docs/PERFORMANCE.md` (learned strategy portfolio, the
  cheap-first tier model, and a flow-authoring best-practices checklist) and `docs/KNOWN_ISSUES.md`
  (assertions resolving CSS/testid selectors on non-interactive nodes via `elementState`, plus the
  remaining assertion gaps — no `checked`/`enabled` type, opaque elements needing vision).

### Changed

- **Lock format bumped to v2.** New writes emit the `strategies` portfolio and drop the v1
  `strategy`/`selector`/`candidates`/`green_runs` fields. A green L0 replay now updates track records
  (its `greens` accumulates), so a committed lock is no longer byte-identical across repeated green
  runs — but the winning selector stays stable until a genuine drift. This is not a heal.
- **Signature format change → one-time re-heal.** Because the text component is now masked, the
  `match.sig` stored in existing `*.lock.toml` files no longer matches. The first non-frozen run
  re-computes and re-writes the signature automatically (a normal heal; no action required). Under
  `--frozen` the run still passes as long as the cached selector resolves (via the new revalidation
  path).

### Updated

### Fixed

- **`visible`/`hidden` no longer silently drop the text check when given BOTH `selector` and
  `text`.** Previously a `{ selector, text }` `visible`/`hidden` assertion ignored `text` and
  checked presence only. Now the element at `selector` must be visible AND its text must contain
  `text` (`hidden` negates the pair), so a wrong value under the right selector correctly fails.
- **Frozen runs fail fast on a corrupt lock.** A `--frozen` run against a malformed/corrupt committed
  lock now errors instead of silently downgrading to an empty lock and passing.
- **Secret redaction covers `select`/`goto`.** Values marked `secret = true` on `select` and `goto`
  (value/url) are now redacted from run/ai/trace artifacts, not just on `fill` — previously such
  secrets could reach those artifacts in cleartext.
- **Import step-id collisions now warn.** When the same step id is defined by more than one imported
  flow, the run emits a warning naming the step id and the competing modules instead of silently
  binding to the first.

## [0.0.1] — 2026-06-30

- Initial release
