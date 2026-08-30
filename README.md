# flightplan

TOML-defined browser workflows with deterministic assertions, effect-aware retry policy, selector
locks, and a layered resolver backed by browser-pilot.

## Quick start

For a published consumer project:

```sh
npm install @svilupp/flightplan browser-pilot
# Or use Bun: bun add @svilupp/flightplan browser-pilot
# If `flightplan` is on PATH (for example, after a global install):
flightplan --help
flightplan --version
flightplan lint path/to/flow.toml
flightplan run path/to/flow.toml --frozen --no-lock-write --json
# In a project, the same commands can use `npx flightplan` or `bunx flightplan`.
```

Run Chrome with CDP on `localhost:9222`, or set `[config.connect] mode = "launch"` in the flow.

For repository development:

```sh
bun install
bun run check
bun run flightplan --help
```

Checks are quiet on success: each leg prints a short status block and a temporary log path. If a
leg fails, its captured diagnostics are printed. Run `bun run lint`, `bun run typecheck`, or
`bun run test` to execute one leg.

Run a deterministic fixture flow:

```sh
bun run fixtures
bun run flightplan run examples/flows/wizard.toml --frozen --no-lock-write --json
```

The fixture server listens on `http://localhost:3000`. The example flows use the default CDP attach
at `localhost:9222`, so start Chrome/Chromium with remote debugging enabled first, or add a
`[config.connect]` block with `mode = "launch"`. Deterministic L0/L1 flows need no API key.
AI resolver, vision, planner, and `ai_judge` paths need `OPENROUTER_API_KEY` by default.

The simplest way to pick a model is `[config.ai.models.default]`: it seeds every AI role (resolver,
advisor, vision, planner, planner_capable) at once, so you don't repeat the same block per role:

```toml
[config.ai.models.default]
model = "gpt-5.6-luna:xhigh"
fallbacks = []
```

This is the recommended way to force a single model across the whole flow. Resolution per role is
field-by-field: an explicit field in that role's own block wins, then the same field in `default`,
then the built-in registry. Role blocks deep-merge over `default` — set `model` in `default` and
override just `pricing` for one role, for example — but `fallbacks` arrays replace wholesale rather
than merging. If `default` sets `model` but not `fallbacks`, roles still fall back to the built-in
OpenRouter fallback slugs; set `fallbacks = []` explicitly in `default` when using a non-OpenRouter
provider to avoid an unexpected fallback to an OpenRouter model id. Older flightplan versions reject
`[config.ai.models.default]` as an unknown key (strict schema), so it is not forward-compatible with
older CLIs.

For advanced setups, keep per-role `[config.ai.models.<role>]` blocks — e.g. a cheap resolver with a
stronger planner — or set `[config.ai] provider = "google" | "openai"` to route through
`@ai-sdk/google` / `@ai-sdk/openai` instead (with `GOOGLE_GENERATIVE_AI_API_KEY` / `OPENAI_API_KEY`
as the matching default key env, overridable via `api_key_env`); model ids in `[ai.models.*]` are
then the provider's OWN ids, not OpenRouter slugs. Any model id may carry a `:effort` suffix
(`minimal|low|medium|high|xhigh`), e.g. `"openai/gpt-5.6-luna:xhigh"`, to set the reasoning effort
for that model (Google has no native `xhigh`; it maps to `high`). Example — Gemini with high
reasoning, per-role:

```toml
[config.ai]
provider = "google"          # uses GOOGLE_GENERATIVE_AI_API_KEY

[config.ai.models.resolver]
model = "gemini-3-pro:high"  # native Google model id + reasoning effort suffix
```

## Install

Install the public packages with npm or Bun. The direct `browser-pilot` dependency exposes the
`bp` discovery and WebMCP diagnostics CLI; Flightplan also declares it as its runtime driver. The
CLI and library run on Node.js 18+ or Bun:

```sh
npm install @svilupp/flightplan browser-pilot
# or
bun add @svilupp/flightplan browser-pilot
```

Once the executable is on `PATH`, call it as `flightplan ...`. In a project, `npx flightplan ...`
and `bunx flightplan ...` are equivalent package runners. From this repository, use
`bun run flightplan ...`.

The library is published as ESM with TypeScript declarations; import it from a Node.js ESM project
or use the `flightplan` executable for command-line workflows.

## Why the tiered resolver

Flightplan uses deterministic lock replay and DOM resolution first, then pays for AI only when a
flow needs it. In the current 54-run comparison, the tiered path passed 27/27 runs in 104.2s for
$0.0077; the AI-only baseline passed 24/27 in 200.5s for $0.0440. That is 1.93x faster and 5.72x
cheaper, with zero drift and stable locks. Warm lock replay made 98.92% of resolutions deterministic.
See [`docs/BENCHMARK.md`](docs/BENCHMARK.md) for the methodology, limits, and full results.

The savings compound on repeat runs. After locks are learned, the warm benchmark reached L0 on
97.85% of resolving steps, and reported cost per pass fell from $0.004604 cold to $0.000533 warm:
8.6x lower, or roughly 10x cheaper. The exploration cost is paid while learning a workflow, not on
every test rerun.

## HOW TO: write a Flightplan flow

Start with a small flow that states its target, connection mode, inputs, budget, and safety policy:

```toml
version = 1
kind = "flow"
id = "orders.pay-seeded"
description = "Pay the seeded draft once"
goal = "Leave the seeded draft in the exact Paid state"

[config.connect]
mode = "launch"
headless = true

[config.plan]
enabled = false

[inputs]
base_url = "http://localhost:3000"

[run]
max_steps = 12
assertions = "eager"
assert_timeout_ms = 6000

[[steps]]
id = "open_draft"
do = "goto"
url = "${inputs.base_url}/shopify/draft_orders/D1236?cookie=hide"

[[steps.assert]]
type = "text"
selector = "[data-testid='draft-id']"
text = "D1236"
match = "exact"
purpose = "precondition"

[[steps]]
id = "pay_once"
do = "click"
effect = "at_most_once"
retry = { policy = "never" }
target = ["[data-testid='mark-as-paid']", "the Mark as paid action for draft D1236"]

[[steps.assert]]
type = "text"
selector = "[data-testid='payment-badge']"
text = "Paid"
match = "exact"
purpose = "postcondition"
```

### 1. Classify the effect

| `effect` | Use |
|---|---|
| `observe` | `goto`, waits, assertions, read-only review |
| `idempotent` | Safe repeated setup or navigation |
| `at_most_once` | Create, approve, pay, save, submit, confirm |

Mark action steps explicitly. The linter treats clicks, fills, selects, `emit`, and `webmcp_call` as
mutation-capable, even when a click only filters a table or changes tabs. `emit` (WebSocket command
injection, see [docs/BROWSER_PILOT_INTEGRATION.md](docs/BROWSER_PILOT_INTEGRATION.md#emit--websocket-command-injection))
is always `at_most_once` - the linter rejects any other value. Do not add `on_fail = { goto = "self" }`
to a step that may have dispatched. Use `retry = { policy = "never" }` for dangerous steps and let an
exact postcondition rescue an uncertain result.

### WebMCP calls

Flightplan uses browser-pilot's WebMCP bridge through the `webmcp_call` step. It invokes one exact
page-provided tool with structured input and can assert or capture a typed result:

WebMCP is experimental and page-scoped. The target must satisfy the browser's secure-context,
origin-isolation, and Permissions Policy requirements. Chrome's origin trial starts at version 149;
for local testing, enable `chrome://flags/#enable-webmcp-testing` and use browser-pilot's
`bp webmcp status` to diagnose availability before running a flow.

```toml
[[steps]]
id = "lookup"
do = "webmcp_call"
tool = "orders.lookup"
input = { order_id = "${inputs.order_id}" }
effect = "observe" # requires the tool's readOnlyHint annotation

[[steps.assert]]
type = "result"
path = "order.status"
equals = "ready"
```

Use `origin` to disambiguate same-named tools and `from_origins` for explicit cross-origin discovery.
Mutation-capable tools require `effect = "idempotent"` or `"at_most_once"`; invocation failures are
treated as uncertain and are never automatically replayed. Raw inputs/results stay out of artifacts;
mark a result capture `secret = true` when its value must be masked in summaries and step events. See
[the browser-pilot integration guide](docs/BROWSER_PILOT_INTEGRATION.md#webmcp_call--page-provided-tools)
for the full contract.

### 1a. Fill verification (`verify`)

`page.fill` verifies by reading the field back and comparing it to what was typed. Some fields
auto-format as you type (a phone field re-spacing
`+447881122333` into `+44 7881 122333`, a card field spacing out digits) — that legitimate
reformat looks identical to a real fill failure. Flightplan's `verify` option maps straight onto
browser-pilot's native fill verification, forwarded through the batch step:

```toml
[[steps]]
id = "enter_phone"
do = "fill"
target = "phone number"
value = "+447881122333"
verify = "normalized" # default — tolerates a whitespace/formatting-only mismatch
```

| `verify` | Behavior |
|---|---|
| `"normalized"` (default) | browser-pilot compares the typed value to the field's value after Unicode NFKC normalization and whitespace-collapse; if that still doesn't match, it falls back to a whitespace-stripped compare (covering an auto-spacing formatter, e.g. a phone or card field). A genuine mismatch still fails the step. |
| `"off"` | Verification is skipped entirely. Use when a formatter inserts punctuation (dashes, parens) that a normalized compare won't tolerate. |
| `"exact"` | The strict `!==` compare — any mismatch fails the step. |

`verify` never changes how the value is TYPED — browser-pilot's own char-by-char typing fallback
(when a direct value-set doesn't stick) still applies regardless of `verify`; this option only
controls whether a post-fill readback mismatch is treated as pass or fail. The `"normalized"`
compare is case-sensitive by design (emails, passwords, and codes are case-significant) and never
strips punctuation like `-()./`.

### 2. Resolve before acting

Targets are ordered locator lists. Put durable selectors first and one natural-language anchor last:

```toml
target = [
  "[data-row-id='D1235'] [data-testid='duplicate-order']",
  "the Duplicate order action for draft D1235",
]
```

The resolver must reject ambiguity before dispatch. Scope repeated controls to a row, panel, landmark,
or seeded resource. Do not rely on the first `More actions`, `Save`, or matching status label.

Author-facing selector prefixes are `ref:`, `role:`, `text:`, `css:`, and leading `[` CSS selectors.
Keep the natural-language entry concise. Internal `fingerprint:` lock tokens are not author-facing
selectors.

### 3. Treat readiness as a semantic condition

A changed URL or committed navigation is not application readiness. Add a wait or a semantic
precondition for delayed hydration, empty first snapshots, loading overlays, and same-document navigation.

```toml
[[steps.assert]]
type = "visible"
selector = "[data-testid='page-title']"
text = "Orders"
purpose = "precondition"
timeout_ms = 6000
```

### 4. Make assertions exact and scoped

Available URL matches: `exact`, `origin_path`, `glob`, `contains`.

Available text matches: `exact`, `contains`, `regex`.

Use `state` for `enabled`, `disabled`, `checked`, `unchecked`, `selected`, `dialog`, `menu`, and
`new_page`. Use `transition` for `url_changed`, `text_changed`, `value_changed`, and `state_changed`.
Use `capture` when a reversible flow must restore an observed value.

Do not let `Paid` match `Unpaid`, a timeline message satisfy a status badge, or a broad URL match a
different tenant. Use a selector or landmark for every business-state assertion.

### 5. Arm popups on the trigger action

Declare the popup on the step that opens it. Flightplan arms observation before dispatch and preserves
the opener page:

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

Filter by opener, URL, type, title, and creation time. Handle `about:blank` followed by delayed
navigation. Never select a popup by tab index.

### 6. Compose flows with imports

`imports` registers a library; it does not execute it. A `do = "run"` step executes the imported flow.
The entry flow owns `[connect]`, run budgets, and safety policy. Expanded child steps count toward the
parent budget; `on_fail` targets cannot cross a `run` boundary.

## Run, lock, and dependency workflows

Run repository checks from a checkout:

```sh
bun run check
bun run lint
bun run typecheck
bun run test
```

Lint and preview effect policy before execution:

```sh
flightplan lint path/to/flow.toml
flightplan migrate-effects path/to/flow.toml
```

Use frozen, no-lock-write runs for proof and CI:

```sh
flightplan run path/to/flow.toml \
  --frozen --no-lock-write --json -o /tmp/flightplan-run
```

Locks contain learned target strategies and a `source_hash`. A stale lock must not replay against a
changed flow. Refresh a lock only after reviewing the flow diff and the new target strategies.

## Development-only: proving Shopify and Swap fixtures

The deterministic admin fixtures live in the sibling `browser-pilot-testing` checkout. This is a
development-only local-fixture workflow, not a consumer setup. Start the server, reset between
lanes, and run the TOMLs through Flightplan:

```sh
export BROWSER_PILOT_TESTING_ROOT=/path/to/browser-pilot-testing
export FLIGHTPLAN_ROOT=/path/to/flightplan

cd "$BROWSER_PILOT_TESTING_ROOT"
PORT=3000 bun run start

cd "$FLIGHTPLAN_ROOT"
bun run flightplan run \
  "$BROWSER_PILOT_TESTING_ROOT/automations/flightplan/shopify-duplicate.toml" \
  --frozen --no-lock-write --json -o /tmp/flightplan-proof
```

For seeded local mutations only:

```sh
ALLOW_MUTATIONS=1 bun run flightplan run \
  "$BROWSER_PILOT_TESTING_ROOT/automations/flightplan/swap-return-approve.toml" \
  --frozen --no-lock-write --json -o /tmp/flightplan-proof
```

Proof requires all of the following:

- Shopify duplicate, pay, create, and fulfillment ledger entries each equal `1`.
- Swap review leaves the ledger at `0`.
- Swap approval, settings save, and settings restore each equal `1`.
- Popup artifacts identify the matched target and opener.
- Every run contains valid `summary.json`, `run.jsonl`, and `trace.jsonl`.
- Reversible settings flows end at the original persisted value.
- An uncertain transport result is observed, never replayed.

`ALLOW_MUTATIONS=1` is a local fixture gate. Live mutations also require an allowlisted tenant/store,
a seeded disposable resource, a mutation budget, and cleanup or restoration.

## Inspect failures

```sh
flightplan explain /tmp/flightplan-proof/<run-id>
flightplan report /tmp/flightplan-proof
flightplan sweep examples/flows --trials 3 --compare-baseline -o /tmp/flightplan-campaign
```

Read the result as a state machine:

| Result | Meaning | Next action |
|---|---|---|
| `not_dispatched` | No effect reached the page | Fix readiness, ambiguity, or actionability; retry only if policy allows |
| `dispatched` | Input may have reached the page | Observe the postcondition; never dispatch again |
| `uncertain` | Transport result cannot prove effect state | Poll state/ledger; never dispatch again |
| Assertion timeout after a commit | Action happened; oracle is wrong or late | Fix assertion scope/timing, not mutation retry |
| Stale lock | Flow and learned recipe differ | Review diff, refresh lock intentionally, or run frozen to fail closed |

Artifacts are the source of truth. Exit code alone cannot prove that an action committed once.

## Troubleshooting

**"You are using an unsupported command-line flag: --no-sandbox. Stability and security will
suffer."** Flightplan launches Chrome with `--no-sandbox` by default so it also works in
containerized and root environments. In headed mode Chrome shows this as a yellow warning bar; it's
expected and harmless outside those environments. If you don't need it, override the defaults with
an explicit `chromeFlags` array in `[config.connect]` (an empty array falls back to the defaults, so
list the flags you want, and add `"--headless=new"` yourself for headless runs):

```toml
[config.connect]
mode = "launch"
headless = false
chromeFlags = ["--disable-gpu", "--window-size=1280,720"]
```

**A fill step fails with `Fill value did not stick. Expected "+447881122333" but got
"+44 7881 122333".`** The target field auto-formats as you type (a phone field re-spacing digits, a
card field inserting spaces). The default `verify = "normalized"` (see
[Fill verification](#1a-fill-verification-verify)) already tolerates whitespace/NFKC formatting
differences, so this usually only surfaces on older browser-pilot builds or with an explicit
`verify = "exact"`. If the formatter inserts punctuation instead (dashes, parens, etc. —
`normalized` won't strip those), set `verify = "off"` on that step to skip verification entirely.
Set `verify = "exact"` to restore strict verification once you've confirmed the field's real
behavior.

## AI tiers and planner

L0 lock replay and L1 deterministic DOM resolution are the default path. L2 resolver, L3 vision, L4
advisor, AI assertions, and the L5 path-repair planner need an AI runtime when invoked.

Keep the planner off for deterministic safety proofs:

```toml
[config.plan]
enabled = false
```

For an AI experiment, enable it only with a bounded `max_replans`, a clear flow `goal`, and a separate
run directory. `tier_hint = "vision"` is for icon-only or unlabeled controls after deterministic
resolution has failed. Consecutive vision targets can batch into one request.

## Cloudflare Access auth (`[config.auth]`)

Flows behind Cloudflare Access can authenticate via `[config.auth]`, layered like every other
`[config.*]` block (built-in defaults → global `flightplan.toml` → entry flow → CLI), so an org can
set the `cf_access` block once in a global `flightplan.toml` and have every flow inherit it.
Secrets are always expressed as env var **names**, never values — the same convention as
`[config.ai] api_key_env` / `[config.telemetry.logfire] token_env`:

```toml
# --- sugar for the common case: out-of-band service-token exchange, then a CF_Authorization cookie ---
[config.auth.cf_access]
url = "https://prodej.wikov.app"                # origin to mint against
client_id_env = "CF_ACCESS_CLIENT_ID"           # env var NAME, never a value
client_secret_env = "CF_ACCESS_CLIENT_SECRET"
mode = "cookie"                                 # "cookie" (default) | "headers"

# --- generic escape hatches, each usable standalone without cf_access ---
[config.auth.extra_headers.from_env]            # header name -> env var NAME
"CF-Access-Client-Id" = "CF_ACCESS_CLIENT_ID"
"CF-Access-Client-Secret" = "CF_ACCESS_CLIENT_SECRET"

[[config.auth.cookies]]                         # maps 1:1 onto browser-pilot's SetCookieOptions
name = "CF_Authorization"
value_from_env = "CF_ACCESS_JWT"
domain = "prodej.wikov.app"
```

`mode = "cookie"` (the default, Method B) mints a `CF_Authorization` JWT via an out-of-band
service-token exchange and applies it as a cookie; `mode = "headers"` (Method A) instead sends the
raw `CF-Access-Client-Id`/`CF-Access-Client-Secret` on every request — broader blast radius (every
origin the tab visits gets the headers, not just the Access-protected one), so prefer cookie mode
unless your policy specifically requires headers. `[[config.auth.cookies]]` entries take either a
literal `value` or a `value_from_env` env var name (never both). Auth is applied once, right after
`connect()` and before the setup hook / first `goto`; an unset `*_env` name or a rejected service
token fails the run before any navigation happens. Requires a browser-pilot build that exports
`Page.setExtraHTTPHeaders` and `mintCfAccessJwt`; an older browser-pilot leaves `[config.auth]`
parsed but un-applied (the driver feature-detects the capability).

## Development reference

- [`examples/flows/`](examples/flows/) - deterministic and AI-backed examples.
- [`examples/fixtures/README.md`](examples/fixtures/README.md) - fixture contracts.
- [`docs/BENCHMARK.md`](docs/BENCHMARK.md) - cost, resolution, and validation methodology.
- [`docs/BROWSER_PILOT_INTEGRATION.md`](docs/BROWSER_PILOT_INTEGRATION.md) - browser integration contract.

## Skills

The release includes two Codex skills under [`docs/skills/`](docs/skills):

- [`authoring-flightplan-workflows`](docs/skills/authoring-flightplan-workflows) - write, lint, run,
  debug, and prove Flightplan TOML flows.
- [`building-flightplan-automations`](docs/skills/building-flightplan-automations) - build complete
  browser automations with Flightplan as the workflow and proof layer.

The second skill makes the boundary explicit: use browser-pilot for reconnaissance or narrow driver
diagnosis, then run the final automation through Flightplan.

Flightplan is under active development. Treat the flow, lock, and artifact checks as part of the
workflow, not as optional polish.
