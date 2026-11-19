---
name: authoring-flightplan-workflows
description: Author, lint, run, debug, and prove TOML-defined Flightplan browser workflows with effect-aware retries, exact assertions, locks, popup expectations, dependency freshness, and mutation evidence. Use when creating or reviewing Flightplan plans, running deterministic fixtures, debugging ladder behavior, or preparing gated live browser automation.
---

# Authoring Flightplan Workflows

Use this skill for Flightplan flow files, fixture runs, lock recipes, and safety reviews.

Read [references/benchmark-learnings.md](references/benchmark-learnings.md) when the task involves
Shopify/Swap-style admin SPAs, mutations, popups, cached browser-pilot dependencies, or proof artifacts.

Assume the `flightplan` command is already available. Examples use `flightplan ...`; use
`npx @svilupp/flightplan ...` or `bunx @svilupp/flightplan ...` when invoking from a package-managed project, and
`bun run flightplan ...` from this checkout.

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
2. Write the flow with stable selectors, natural-language anchors, explicit effects, and deterministic
   assertions.
3. Lint before connecting to Chrome:

   ```sh
   flightplan lint path/to/flow.toml --deny-warnings
   flightplan migrate-effects path/to/flow.toml
   ```

   `--deny-warnings` makes warnings fail the gate while preserving their severity and counts.
   Add `--json` for machine-readable diagnostics.

4. Run deterministic flows with lock writes disabled while proving behavior:

   ```sh
   flightplan run path/to/flow.toml \
     --frozen --no-lock-write --json -o /tmp/flightplan-run
   ```

5. Inspect `summary.json`, `run.jsonl`, and `trace.jsonl`. Confirm dispatch state, retry safety,
   matched postconditions, target provenance, mutation counts, and artifact associations.
6. Repeat from a clean fixture reset. A single green run is not proof for an at-most-once workflow.

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

WebMCP is experimental and page-scoped. Use Chrome 149+ with the required origin-trial/testing
configuration, a secure context, origin isolation, and the page's Permissions Policy. Run
`bp webmcp status` before authoring a flow. Discovery, invocation, and browser compatibility remain
browser-pilot's responsibility; Flightplan does not add a second WebMCP transport.

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

A URL change is a navigation milestone, not application readiness. Attach a postcondition to
`goto` for delayed hydration, empty first snapshots, loading overlays, and same-document updates.
A precondition runs before the action and therefore inspects the previous page on `goto`.
This postcondition checks the destination:

```toml
[[steps]]
id = "open_orders"
do = "goto"
url = "${inputs.base_url}/orders"

[[steps.assert]]
type = "text"
selector = "css:[data-testid='page-title']"
text = "Orders"
match = "exact"
purpose = "postcondition"
timeout_ms = 6000
```

`[config.timeouts] goto_ms` bounds document navigation (default 30000 ms); `nav_ms` bounds
optional settling (default 2000 ms). An explicit `nav_ms` supplies the legacy document limit only
when `goto_ms` is absent. A `goto` step's `timeout_ms` overrides document load only. Assertion
timeouts are independent. Strict owner-action hosts enforce their own deadlines; named-session
compatibility borrowers use driver deadlines.

### Write exact postconditions

Prefix CSS assertion selectors with `css:`, including tag names such as `css:h1`. For `hidden`,
`state = "hidden"`, and `count = 0`, give an explicit selector such as `css:app-banner` or
`text:Shipping notice`. A valid query with no matches proves absence. Use `value = ""` to clear a
field or assert an empty value. Explicit `role:` and `text:` assertion selectors match full accessible names;
use the assertion's `match` for substring checks. Semantic counts measure accessibility nodes;
use CSS for DOM element counts. Use `match = "exact"` and scope the selector for business state.
Available URL modes are `exact`, `origin_path`, `glob`, and `contains`; text modes are `exact`,
`contains`, and `regex`.
Use state assertions for `enabled`, `checked`, `selected`, and `new_page`; use transition assertions
for `url_changed`, `text_changed`, `value_changed`, and `state_changed`.

```toml
[[steps.assert]]
type = "text"
selector = "css:[data-testid='payment-badge']"
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
[config.ai]
enabled = true

[config.ai.models.default]
model = "gpt-5.6-luna:xhigh"
fallbacks = []
```

This is the recommended default. Precedence per role, field-by-field: explicit role field >
`default` field > built-in registry. Role blocks deep-merge over `default`; `fallbacks` arrays
replace wholesale, they do not merge. Footgun: if `default` sets `model` but omits `fallbacks`,
roles keep the built-in OpenRouter fallback slugs — set `fallbacks = []` in `default` when using
a non-OpenRouter provider.

For advanced, mixed setups keep per-role `[config.ai.models.<role>]` blocks (e.g. cheap resolver,
stronger planner), or route through a native provider by setting `[config.ai] provider = "google"
| "openai"` (key envs: `GOOGLE_GENERATIVE_AI_API_KEY` / `OPENAI_API_KEY`) and using that provider's
own model ids. Any model id may carry a `:effort` suffix (`minimal|low|medium|high|xhigh`) to set
reasoning effort:

```toml
[config.ai]
enabled = true
provider = "google"

[config.ai.models.resolver]
model = "gemini-3-pro:high"   # google has no native xhigh; it maps to high
```

### Authenticate through Cloudflare Access (`[config.auth.cf_access]`)

Use `[config.auth.cf_access]` when the target origin sits behind Cloudflare Access. Put it in the
entry flow's configuration; imported flows supply steps, not connection or auth configuration.
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

For Google/OAuth login without a test bypass, use the README's "Saved auth state" recipe or an
attended named browser session. `[config.auth].cookie_file_env` names an environment variable that
holds a snapshot path. Cookie restoration does not renew server-side expiry; assert the signed-in
page after navigation and stop when authentication is required.

Raw attach checks visibility and focus before a keypress. Set `[config.connect] foreground = true`
only when activation is intended; it targets the selected tab after guard approval and verifies focus.
Failure sends no key. Keep keypresses in separate steps: mixed raw-attach batches are rejected before
any action. Assert the actual key's effect. Prefer named sessions for coordinated ownership;
serialize raw attach externally and never overlap it with a named owner on the same profile.

## Running and proving mutations

For local admin fixtures:

```sh
export BROWSER_PILOT_TESTING_ROOT=/path/to/browser-pilot-testing
export FLIGHTPLAN_ROOT=/path/to/flightplan

cd "$BROWSER_PILOT_TESTING_ROOT"
PORT=3000 bun run start

cd "$FLIGHTPLAN_ROOT"
ALLOW_MUTATIONS=1 flightplan run \
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
flightplan explain /tmp/flightplan-proof/<run-id>
flightplan report /tmp/flightplan-proof
```

Classify the failure:

- `not_dispatched`: repair resolution, readiness, or actionability; a retry may be safe only when
  policy explicitly permits it.
- `dispatched`: inspect the postcondition; never dispatch again.
- `uncertain`: poll the postcondition and inspect the ledger; never dispatch again.
- assertion timeout with a committed ledger entry: fix the assertion scope or timing, not the action.
- stale-lock rejection: refresh or intentionally quarantine the lock after reviewing the flow diff.

AI is off by default. Set `[config.ai] enabled = true` only for authorized AI runs; keys alone do
not enable it. Explicit classifiers, profiles, AI assertions, vision hints and planners require
permission before browser acquisition. Cached extraction maps can replay with AI off. A configured
remote guard with AI off is a preflight error, including shadow mode; do not silently remove guards.
Zero call/cost budgets stop remote work before it starts, including guard work; zero screenshots
stop model image capture. Recording remains independent: use `[config.browser] record = false`.
Trusted injected guard callbacks remain active. `--frozen --no-lock-write` controls lock persistence.
Frozen mode permits live fallback without a lock; check lock existence separately when a promoted
baseline is required. Planner enablement is rejected if a prepared step, child flow, or hook has
an `at_most_once` effect. Backward failure jumps cannot cross protected steps that may have dispatched.
Use `lint --deny-warnings` for a strict gate. Sweep shares run's `--input`, `--input-env`, and
`--inputs-file` flags and validates all bindings before dispatch. Inspect `sweep.json` for denied
baseline units; `report` only aggregates executed runs.

## References

Read [references/benchmark-learnings.md](references/benchmark-learnings.md) for the concrete Shopify
and Swap failure patterns that motivated these rules.

## Hosted and borrowed browser acquisition

Read `docs/cloudflare-hosted.md` in the Flightplan checkout when selecting a
Cloudflare provider or embedding a host-owned session. `mode = "hosted"` owns
its allocation; `mode = "session"` requires a host acquirer, `session_ref` and
explicit `target_policy` (`exact` also requires `target_id`). Credentials remain
environment-variable names. The portable Worker entry requires host acquisition
and binary artifact ports; local attach/launch is a native-host path.

Borrowed teardown detaches, preserving the owner. Retain `providerCleanup` when
owned teardown reports `cleanup_pending`; reconcile that exact allocation.
Cancellation/deadline and contention need independent evidence from successful
flow runs. Local Node/Chromium success does not prove Kitesurf frame semantics or
live provider behavior. See the browser-pilot validation report for those gates.

Use `examples/flows/saucedemo-checkout.toml` and the examples README for a public
demo login/cart/checkout proof; its demo completion is not a real payment oracle.
Keep credentials in environment references. Read the examples README before
running: the verified Chrome 154 fixture uses a disposable profile with credential
saving disabled; default fresh-profile launches retained an input-delivery failure.

## JEV, recipes and shared sessions

Read `docs/JEV.md` in the Flightplan checkout for profile configuration and JEV assertions.
Inspect `flightplan config <flow> --json` before running; repeat all required ceilings when
replacing a run table. Image permission does not bypass capture safety. Keep deterministic
postconditions alongside model assertions and never retry an uncertain mutation.

Read `docs/CALLABLE_RECIPES.md` for typed inputs, entry/outcome conditions, extraction and outputs.
Keep business loops in the host. Prefer explicit extraction selectors; secret fields require them.
`resolve = "ai"` requests fresh selection without target-lock reuse. Use `list`/`describe` for
discovery and `check` for current entry inspection only. Secret inputs use `--input-env`;
retries reuse one `--idempotency-key`. A new key does not prove a mutation is safe to repeat.
Child and hook secret inputs share run-wide redaction; secret extraction in either disables
recording for the whole run. Changed dependencies or bound destinations conflict with an existing
invocation key, including secret-marked raw URLs. Declared secret inputs retain reference-based
rotation. Identity remains scoped to the store and namespace; CLI defaults use the working
directory, and shared claims can conflict after relocation. Reconcile the earlier outcome before
issuing a new key after an upgrade.

Read `docs/BROWSER_PILOT_INTEGRATION.md` for named sessions, guards and host yield. Require verified
handback and fresh observations before resuming BP actions. Local guards cannot override owner
policy. Native assurance requires trusted host opt-in and `browser.dialog = "fail"`.
Yield requires return assertions and a fresh grant; it cannot restore a crashed runner cursor.
