---
name: authoring-flightplan-workflows
description: Author, lint, run, debug, and prove TOML-defined Flightplan browser workflows with effect-aware retries, exact assertions, locks, popup expectations, dependency freshness, and mutation evidence. Use when creating or reviewing Flightplan plans, running deterministic fixtures, debugging ladder behavior, or preparing gated live browser automation.
---

# Authoring Flightplan Workflows

Use this skill for Flightplan flow files, fixture runs, lock recipes, and safety reviews.

Read [references/benchmark-learnings.md](references/benchmark-learnings.md) when the task involves
Shopify/Swap-style admin SPAs, mutations, popups, cached browser-pilot dependencies, or proof artifacts.

## Operating contract

Keep this lifecycle intact:

```text
resolve -> veto ambiguity/policy -> validate preconditions -> dispatch once
  -> observe postconditions -> classify -> retry observation only
```

- Resolve candidates before any effectful action.
- Treat `dispatched` and `uncertain` as terminal for the side effect.
- Never use a new ladder tier, `on_fail.self`, or a generic retry to repeat an uncertain effect.
- A postcondition can rescue an uncertain result; it cannot authorize another dispatch.
- Fail closed when retry metadata, target identity, lock hashes, or mutation gates are missing.

## Workflow

1. Inspect the target application and fixture contract. Identify hydration delays, repeated controls,
   popups, mutation endpoints, seeded resources, and cleanup behavior.
2. Install the locked dependencies before debugging a flow:

   ```sh
   bun install
   ```

3. Write the flow with stable selectors, natural-language anchors, explicit effects, and deterministic
   assertions.
4. Lint before connecting to Chrome:

   ```sh
   bun run flightplan lint path/to/flow.toml
   bun run flightplan migrate-effects path/to/flow.toml
   ```

5. Run deterministic flows with lock writes disabled while proving behavior:

   ```sh
   bun run flightplan run path/to/flow.toml \
     --frozen --no-lock-write --json -o /tmp/flightplan-run
   ```

6. Inspect `summary.json`, `run.jsonl`, and `trace.jsonl`. Confirm dispatch state, retry safety,
   matched postconditions, target provenance, mutation counts, and artifact associations.
7. Repeat from a clean fixture reset. A single green run is not proof for an at-most-once workflow.

## Authoring rules

### Classify every step

| Effect | Use for | Rule |
|---|---|---|
| `observe` | `goto`, waits, assertions, read-only review | No side effect allowed |
| `idempotent` | Safe repeated setup or navigation | Still require a postcondition |
| `at_most_once` | Create, approve, pay, save, submit, confirm | One dispatch maximum; no self-retry |

Mark every action with `effect`. The linter treats clicks, fills, and selects as mutation-capable,
including filters and tab changes, so give them an explicit effect and a natural-language anchor.
`emit` (WebSocket command injection) is inherently `at_most_once` - the schema forces/defaults it and
`steps/emit-no-retry` rejects `retry.max > 0` - but it still needs a deterministic postcondition like
any other action. For dangerous steps, use `retry = { policy = "never" }` when the step must not be
re-entered.

`webmcp_call` invokes an exact tool exposed by the page through browser-pilot. Keep the
default `effect = "observe"` for tools advertising `readOnlyHint`; acknowledge mutation explicitly
with `idempotent` or `at_most_once`. Assert the structured result with `type = "result"` and a dot
`path`, and mark sensitive result captures `secret = true` so raw values never enter artifacts.

Do not write `on_fail = { goto = "self" }` for an effect that may have dispatched. Use a deterministic
postcondition and observation polling instead.

### Fill verification (`verify`)

A `fill` step accepts `verify = "exact" | "normalized" | "off"` (default `"normalized"`), forwarded
to browser-pilot's native fill verification. Some fields
auto-format as you type — a phone field re-spacing `+447881122333` into `+44 7881 122333`, a card
field inserting spaces — which trips a strict post-fill readback compare with
`Fill value did not stick. Expected "..." but got "...".`. The default `"normalized"` tolerates
that (Unicode NFKC + whitespace-collapse, then whitespace-stripped, compare); use `"off"` when a
formatter inserts punctuation the normalized compare won't strip (dashes, parens), and `"exact"`
to keep the strict compare.

### Target repeated controls

Use an ordered locator list. Put durable selectors first and one concise anchor last:

```toml
target = [
  "[data-row-id='D1235'] [data-testid='duplicate-order']",
  "the Duplicate order action for draft D1235",
]
```

Scope status and actions to the relevant row, panel, badge, or landmark. Do not rely on the first
`More actions`, `Save`, `Paid`, or `Fulfilled` match.

### Model readiness

A URL change is a navigation milestone, not application readiness. Add a wait or a semantic
precondition for delayed hydration, empty first snapshots, loading overlays, and same-document updates:

```toml
[[steps]]
id = "open_orders"
do = "goto"
url = "${inputs.base_url}/orders"

[[steps.assert]]
type = "visible"
selector = "[data-testid='page-title']"
text = "Orders"
purpose = "precondition"
timeout_ms = 6000
```

### Write exact postconditions

Use `match = "exact"` and scope the selector for business state. Available URL modes are
`exact`, `origin_path`, `glob`, and `contains`; text modes are `exact`, `contains`, and `regex`.
Use state assertions for `enabled`, `checked`, `selected`, and `new_page`; use transition assertions
for `url_changed`, `text_changed`, `value_changed`, and `state_changed`.

```toml
[[steps.assert]]
type = "text"
selector = "[data-testid='payment-badge']"
text = "Paid"
match = "exact"
purpose = "postcondition"
```

Capture values before a reversible mutation and assert the restored value after cleanup. A positive
timeline message is not proof that the current status badge changed.

### Arm popups on the trigger step

Popup observation belongs on the action that opens the page. Include enough identity to exclude
unrelated tabs and allow `about:blank` to become the final URL:

```toml
[[steps]]
id = "sign_in_store"
do = "click"
effect = "at_most_once"
target = ["[data-store-id='store-001'] [data-testid='store-sign-in']", "the sign-in action in store-001"]

[steps.popup]
type = "page"
url = "/swap-admin/signed-in?popup=1&storeId=store-001"
title = "uat.swap-os.com · Store session"
timeout_ms = 5000
```

Never identify a popup by index or by whichever tab became active. Preserve the opener and verify
the matched popup in the run artifact.

### Compose flows carefully

`imports` registers a flow; it does not execute it. Use `do = "run"` to execute the imported flow.
The entry flow owns `[connect]`, `[run]`, and safety policy. Expanded child steps count toward the
parent budget, and `on_fail` targets cannot cross a `run` boundary.

### Pick provider, model, and reasoning effort

AI tiers default to OpenRouter (`OPENROUTER_API_KEY`). The simplest way to pin a model is
`[config.ai.models.default]`: it seeds every role at once (resolver, advisor, vision, planner,
planner_capable), so a flow that does not need per-role tiering never repeats the block:

```toml
[config.ai.models.default]
model = "gpt-5.6-luna:xhigh"
fallbacks = []
```

This is the recommended default. Precedence per role, field-by-field: explicit role field >
`default` field > built-in registry. Role blocks deep-merge over `default`; `fallbacks` arrays
replace wholesale, they do not merge. Footgun: if `default` sets `model` but omits `fallbacks`,
roles keep the built-in OpenRouter fallback slugs — set `fallbacks = []` in `default` when using
a non-OpenRouter provider. Older flightplan versions reject `[config.ai.models.default]` as an
unknown key.

For advanced, mixed setups keep per-role `[config.ai.models.<role>]` blocks (e.g. cheap resolver,
stronger planner), or route through a native provider by setting `[config.ai] provider = "google"
| "openai"` (key envs: `GOOGLE_GENERATIVE_AI_API_KEY` / `OPENAI_API_KEY`) and using that provider's
own model ids. Any model id may carry a `:effort` suffix (`minimal|low|medium|high|xhigh`) to set
reasoning effort:

```toml
[config.ai]
provider = "google"

[config.ai.models.resolver]
model = "gemini-3-pro:high"   # google has no native xhigh; it maps to high
```

### Authenticate through Cloudflare Access (`[config.auth]`)

Use `[config.auth]` only when the target origin sits behind Cloudflare Access. It is a
`[config.*]` block, so it layers like every other one (defaults → global `flightplan.toml` →
entry flow → CLI) — set `cf_access` once in a global `flightplan.toml` and every flow inherits it.
Secrets are always env var **names**, never literal values:

```toml
[config.auth.cf_access]
url = "https://app.example.com"
client_id_env = "CF_ACCESS_CLIENT_ID"
client_secret_env = "CF_ACCESS_CLIENT_SECRET"
mode = "cookie"                        # "cookie" (default) | "headers"
```

`mode = "cookie"` mints a `CF_Authorization` JWT out-of-band and sets it as a cookie; `mode =
"headers"` sends the raw client id/secret headers on every request the tab makes, so prefer
cookie mode unless policy requires headers. Generic escape hatches
(`[config.auth.extra_headers.from_env]`, `[[config.auth.cookies]]` with `value_from_env`) work
standalone without `cf_access`. Auth is applied once, right after `connect()` and before the
first `goto`; never put a literal secret in a flow — only the env var **name**. See
`README.md`'s "Cloudflare Access auth" section and `src/config/schema.ts` for the full field
reference.

## Running and proving mutations

For local admin fixtures:

```sh
export BROWSER_PILOT_TESTING_ROOT=/path/to/browser-pilot-testing
export FLIGHTPLAN_ROOT=/path/to/flightplan

cd "$BROWSER_PILOT_TESTING_ROOT"
PORT=3000 bun run start

cd "$FLIGHTPLAN_ROOT"
ALLOW_MUTATIONS=1 bun run flightplan run \
  "$BROWSER_PILOT_TESTING_ROOT/automations/flightplan/swap-return-approve.toml" \
  --frozen --no-lock-write --json -o /tmp/flightplan-proof
```

Reset before each independent mutation lane. For proof, require:

- exact ledger counts, including duplicate attempts and idempotency keys;
- a `summary.json`, `run.jsonl`, and `trace.jsonl` with valid associations;
- `dispatchState`, `retrySafe`, and postcondition evidence for every effectful step;
- restored state for reversible settings changes;
- no live credentials or live tenant when testing local fixtures.

Use `ALLOW_MUTATIONS=1` only for seeded local mutation flows. Live lanes also need an exact tenant
and store allowlist, a seeded disposable resource, a mutation budget, and cleanup/restoration.

## Debugging

Use the artifacts before changing selectors:

```sh
bun run flightplan explain /tmp/flightplan-proof/<run-id>
bun run flightplan report /tmp/flightplan-proof
```

Classify the failure:

- `not_dispatched`: repair resolution, readiness, or actionability; a retry may be safe only when
  policy explicitly permits it.
- `dispatched`: inspect the postcondition; never dispatch again.
- `uncertain`: poll the postcondition and inspect the ledger; never dispatch again.
- assertion timeout with a committed ledger entry: fix the assertion scope or timing, not the action.
- stale-lock rejection: refresh or intentionally quarantine the lock after reviewing the flow diff.

Keep `[config.plan].enabled = false` for deterministic safety proofs. Enable the planner only in a
separate AI-backed experiment with a bounded `max_replans` and a clear goal.

## References

Read [references/benchmark-learnings.md](references/benchmark-learnings.md) for the concrete Shopify
and Swap failure patterns that motivated these rules.
