# Browser-pilot integration

Flightplan uses browser-pilot for live browser access. Browser-pilot records and inspects a
manual workflow; Flightplan owns the reusable TOML flow, assertions, resolution ladder, and
learned lock.

## Package boundary

### Consumers

Install a released `browser-pilot` package in the consumer project and pin the resolved version in
that project's lockfile:

```sh
bun add browser-pilot
# or
npm install browser-pilot
```

Do not use a `file:` path, a workspace reference, or a sibling checkout in a consumer install.
Flightplan itself pins the released `browser-pilot@0.1.0` package.

## Canonical authoring flow

Use browser-pilot to discover the workflow, then translate it into Flightplan TOML:

```sh
mkdir -p artifacts
bp record -s flightplan-dev --profile automation -f artifacts/order.recording.json
# Perform the workflow manually, then stop with Ctrl+C.
bp record summary artifacts/order.recording.json
bp record inspect artifacts/order.recording.json
bp record derive artifacts/order.recording.json -o artifacts/order.workflow.json
```

Treat the recording as the browser-side source of truth and the derived JSON as an inspection and
mapping aid. Do not feed the derived workflow directly to Flightplan. Translate the actions and
assertions manually so the flow has stable intent, Flightplan-compatible selectors, and explicit
postconditions:

```toml
version = 1
kind = "flow"
id = "orders.create"
description = "Create an order and verify the confirmation"

[inputs]
base_url = "${env.ORDERS_BASE_URL}"
customer_name = "Ada Lovelace"

[[steps]]
id = "open_orders"
do = "goto"
url = "${inputs.base_url}/orders"

[[steps]]
id = "customer_name"
do = "fill"
effect = "at_most_once"
target = ["css:input[name='customer']", "role:textbox:Customer", "the customer name field"]
value = "${inputs.customer_name}"

[[steps]]
id = "submit_order"
do = "click"
effect = "at_most_once"
target = ["[data-testid='submit-order']", "role:button:Submit order", "the submit order button"]

[[steps.assert]]
type = "text"
selector = "[data-testid='order-created']"
text = "Order created"
```

Then lint, learn locally, and replay against the reviewed lock. Replace the clearly marked example
path below with the flow you authored:

```sh
bun run flightplan lint path/to/your-flow.toml
bun run flightplan run path/to/your-flow.toml
bun run flightplan run path/to/your-flow.toml --frozen
```

The first unlocked run can create or update the collocated `<your-flow>.lock.toml`. Inspect the run
result and the lock diff. Promote the flow and its matching lock together only after the
assertions prove that each action reached the intended state. Use `--frozen` in CI or shared replay
to make the promoted lock read-only. A required heal is reported as drift and fails the frozen run
without writing the lock; rerun unlocked locally, review the new lock, then promote the pair.

## Selector translation

Flightplan targets are ordered locator lists: durable selectors first and one natural-language
intent last. Only the natural-language entry is used as the fuzzy or AI intent; selectors feed the
deterministic tier.

| Browser-pilot value | Flightplan value | Rule |
| --- | --- | --- |
| `ref:e5` | `css:...`, `[data-testid='...']`, `role:...`, `text:...`, or intent | Refs are session-scoped and must not enter a lock. |
| `#submit`, `.primary`, `button.primary` | `css:#submit`, `css:.primary`, `css:button.primary` | Prefix bare CSS with `css:`. |
| `[data-testid='submit-order']` | `[data-testid='submit-order']` | Attribute selectors beginning with `[` are recognized as CSS. |
| `role:button:Save` | `role:button:Save` | Pass through unchanged. |
| `text:Save` | `text:Save` | Pass through unchanged for interactive text. |
| `the Save button in Billing address` | Same string, preferably last | Unprefixed text is natural-language intent. |
| `label:Email` | `[aria-label='Email']` or intent | `label:` is not a browser-pilot selector or Flightplan authoring prefix. |

Flightplan strips its authoring-only `css:` prefix before sending the selector to browser-pilot.
`fingerprint:`, `fp:`, and `structure:` are internal lock identity tokens, not author-facing target
prefixes. Keep a stable natural-language intent even when a selector is available; the intent is
used when the recorded selector drifts.

## API-key conditions

No key is needed when a run resolves at L0/L1 and performs no AI-backed assertion or step. A warm
lock replay is also keyless when it stays at L0. Set `OPENROUTER_API_KEY` before a run that can
invoke L2 resolver, L3 vision, L4 advisor, L5 planner, `ai_pick`, or `ai_judge`:

```sh
export OPENROUTER_API_KEY=...
bun run flightplan run path/to/your-flow.toml
```

`--frozen` controls lock writes, not model availability. A frozen run still needs the key if the
current page misses the lock and its configured ladder or assertions require AI.

## Lock promotion checklist

- The flow passes `flightplan lint`.
- The first unlocked run passes its assertions.
- Every learned target has a durable selector or a reviewed intent.
- The generated `<flow>.lock.toml` is reviewed with the flow.
- CI or shared replay uses `--frozen`.
- A later heal is regenerated and reviewed before the lock is promoted again.
