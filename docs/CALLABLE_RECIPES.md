# Callable recipes

Recipes accept typed inputs, check entry and outcome conditions, and return named JSON outputs. Hosts keep business loops and decisions outside TOML.

## Run the local product example

```sh
bun run fixtures
# Open http://127.0.0.1:3000/recipes in the session selected by your host.
bun run flightplan lint examples/flows/recipes --json
bun run flightplan describe examples/flows/recipes/inspect-products.toml --json
```

The runnable recipe is [`inspect-products.toml`](../examples/flows/recipes/inspect-products.toml). It requires the product page as its starting state; it does not open that page itself.

For an embedding host, pass `inputs` to `runFlow`. The example accepts `base_url` and numeric `min_price`. Successful runs publish `summary.outputs.products`; failed required conditions publish no outputs.

## Inputs and discovery

`list` and `describe` return recipe metadata without a browser or model request. `check` inspects
entry conditions and targets on the current page. Targets after a state-changing step are reported
as unchecked.

```sh
flightplan list ./flows --json
flightplan describe ./flows/open-order.toml --json
flightplan run ./flows/open-order.toml --input order_id=D123 --inputs-file params.json --json
flightplan check ./flows/open-order.toml --session work --json
```

String defaults under `[inputs]` remain supported. Typed declarations accept `string`, `number`,
`boolean`, `object`, and `array`:

```toml
[inputs.order_id]
type = "string"
required = true
description = "Order identity in the selected store."

[inputs.min_price]
type = "number"
default = 100

[inputs.token]
type = "string"
secret = true
required = true
```

CLI scalar overrides take precedence over an inputs file, then declaration defaults. Structured
values use a JSON inputs file. Whole `${inputs.name}` references preserve JSON types; embedding
an object or array inside text fails. Caller values are literal data, including text that resembles
a template. Duplicate CLI assignments, duplicate JSON keys, missing required values, unknown names,
and invalid types fail before browser acquisition. With `--json`, binding errors return structured
diagnostics.

Declared secrets accept an environment reference, never a literal caller value:

```sh
flightplan run ./flows/open-order.toml --input order_id=D123 --input-env token=ORDER_TOKEN --json
```

The equivalent JSON value is `{"token":{"from_env":"ORDER_TOKEN"}}`.

## Conditions and results

`[[before]]` and `[[after]]` use the existing assertion vocabulary. Entry checks run before setup. Every nested `run` checks its child's contracts. Required contracts block even when optional step assertions use deferred evaluation or `fail_on_assertion = false`.

```toml
[[before]]
type = "url"
url = "https://admin.example.com/products"
match = "origin_path"

[[after]]
type = "result"
step = "products"
path = "0.price"
gt = "${inputs.min_price}"

[outputs.products]
step = "products"
path = "."
```

Result predicates support `equals`, `exists`, `gt`, `gte`, `lt`, and `lte`, with one predicate per assertion. Numeric predicates require finite numbers and preserve typed whole-input references. Flow outcomes name their source step explicitly. Dot paths can address array indexes. Debugging slices are rejected when they would skip required invocation boundaries.

Step captures remain strings and become available after that step's assertions. Child captures and result sources are scoped by call-site ID. Outputs require available finite JSON values and publish after all required outcome checks pass. A failed entry reports `invocation_status = "not_started"`; later failure preserves dispatch receipts.

## Structured extraction

```toml
[[steps]]
id = "products"
do = "extract"
effect = "observe"
selector = ".product"
max_rows = 100

[steps.fields.price]
selector = "[data-testid='price']"
source = "attribute"
attribute = "data-amount"
type = "number"
required = true
```

The reader projects rows in one DOM evaluation. `source` accepts `text`, `value`, or `attribute`; field types are `string`, `number`, and `boolean`. `selector = "."` reads the row itself. Optional missing fields are omitted. Empty collections return `[]`. Missing required values, duplicate field matches, row overflow, malformed numbers, and changed document identity fail the step. Formatted currency text is not coerced to a number.

Omitting a field selector requests bounded field-map learning. Supply `description` when the field name is insufficient. The default mapper uses JEV with environment credentials, finite durable candidates, one independent choice per field, shared model budgets, and conservative confidence/probability gates. Hosts can inject `RunOptions.extractionMapper`.

Validated maps are stored under `[[extractions]]` in the normal lock file after the step's assertions pass. They contain selectors and schema/page/frame gates, never extracted records. Warm runs read current rows. Frozen stale maps fail; `--no-lock-write` preserves lock bytes. Document identity and candidate evidence are rechecked after model latency.

Declare `secret = true` on sensitive fields. Such rows require explicit selectors before candidate acquisition. Sensitive DOM markers are excluded from learned evidence. Result captures and outputs inherit secret taint; recording is disabled for recipes declaring secret extraction fields.

## Fresh semantic choices

```toml
[[steps]]
id = "choose_product"
do = "click"
target = "Open an available product priced above 100 USD"
resolve = "ai"
effect = "idempotent"
```

`resolve = "ai"` uses fresh candidates and skips target-lock reads, writes, and learned target memory. `ai_pick` shares the same policy when the option is supplied; its omitted-option behavior remains compatible. Frozen and no-write modes still perform the declared fresh choice. Missing AI, abstention, or unavailable evidence stops before dispatch. Prove product price, currency, availability, and identity with deterministic extraction conditions afterward.

## Read-only inspection and diagnostics

`checkFlow` and `flightplan check` inspect the current entry state without actions, page tools, arbitrary eval, repairs, or lock writes. The report marks later states `unchecked`. A successful inspection does not validate later pages or outcomes.

Diagnostics retain `ruleId` and add stable `code`, root-cause grouping, safe suggestions, and source positions where the physical key or parser location is known. Missing inputs, independent schema errors, import errors, and capture-before-definition errors are reported together where their evidence is available.

## Invocation idempotency

```sh
flightplan run ./flows/pay-order.toml --input order_id=D123 \
  --idempotency-key pay-D123-attempt-1 --json
```

The native CLI atomically claims keys in `.flightplan-runs/.invocations`, independent of `-o`.
A completed duplicate returns its original summary and run ID without reconnecting or dispatching.
A changed recipe, dependency, or effective nonsecret input conflicts with the original claim.
Secret input identity uses its reference rather than a hash of the secret value.

An active or interrupted claim blocks repetition. The journal records pending state before driver
mutators, including direct methods used by host dispatchers. A process crash cannot authorize a
retry. Claims that need reconciliation remain blocked; this release has no CLI reset or automatic
expiry. Reconcile the business outcome through your trusted host before choosing a new invocation.
Different keys do not deduplicate the same business resource.

Embedding hosts supply `invocationStore` and `idempotencyKey` to `runFlow`. `MemoryInvocationStore`
is for tests or a single process. Persistent hosts implement the atomic `InvocationStore` contract
and set `invocationNamespace` when sharing one store between callers. The native
`NodeInvocationStore` uses exclusive creation and durable atomic updates.

