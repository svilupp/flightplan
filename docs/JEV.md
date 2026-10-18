# Bounded JEV profiles

JEV selects supplied candidates or checks an explicit predicate. Browser dispatch, effect policy, independent assertions and lock promotion remain in the runner.

```sh
bun run flightplan config examples/flows/jev/baseline.toml --json
bun run flightplan lint examples/flows/jev --json
bun run examples/fixtures/server.ts
# In another terminal, with TYPESAFE_API_KEY set:
bun run flightplan run examples/flows/jev/baseline.toml
# Inspect the resulting lock before replay:
bun run flightplan run examples/flows/jev/baseline.toml --frozen --no-lock-write
```

The examples cover one flow per profile: `baseline.toml` (text), `icons.toml` (visual),
and `shadow.toml` (comparison after heuristic selection). For contextual disambiguation among
identical buttons, use the existing [gauntlet flow](../examples/flows/gauntlet.toml) with the
text profile configuration below.

## Configuration

```toml
[config.ai]
classifier = "jev"

[config.ai.jev]
profile = "text"
model = "jev-1.14.0"
images = "deny"
max_calls_per_step = 2
max_requests_per_run = 16

[config.run]
max_model_calls = 16
max_screenshots = 0
max_cost_usd = 0.02
```

| Profile | Stages | Image permission |
| --- | --- | --- |
| `text` | Text Choice, conditional verification with fresh context | Denied by default |
| `visual` | Text Choice, then image Choice on abstention | Requires `images = "allow"` |
| `shadow` | Text comparison after successful authoritative L2 action | Denied by default; never dispatches |

Active profiles require classifier `jev` or `auto`. Shadow also permits `llm` or `heuristic`. Without `[config.ai.jev]`, legacy classifier behavior remains unchanged. Text verification requires new disambiguating evidence and remaining request capacity. Shadow compares the original candidate packet after a successful authoritative L2 action and uses only the remaining budget. It skips comparison when L2 abstains or the action fails, preserving the allowance for fallback.

The key defaults to `TYPESAFE_API_KEY`, with `JEV_API_KEY` as the legacy alias. Store only the environment variable name in `[config.ai] jev_api_key_env`; setting it explicitly disables the alias. Config inspection emits availability booleans, never key values. Lint and config inspection need no credentials or network.

`max_calls_per_step` counts reserved HTTP attempts across JEV stages and assertions attached to that step, including failed requests. It defaults to two for active profiles and one for shadow; `max_requests_per_run` defaults to 16. The only accepted model is the pinned `jev-1.14.0` (also the default). Both request caps accept positive integers. New profiles use no transport retries. The shared eight-second step deadline starts before evidence acquisition and does not reset between stages or assertions; `timeouts.ai_call_ms` also bounds each request (default 3000 ms). Run model-call, screenshot and dollar ceilings remain outer limits. Each request reserves the cost of 64,000 input tokens before sending and reconciles known usage afterward; failures retain the reservation, and unpriced models are refused under a dollar ceiling. A supplied `[run]` or `[config.run]` replaces the lower layer's entire run table: repeat every ceiling you need.

Images require both explicit permission and a safe, current capture with known geometry. Unknown transforms, secrets, opaque media or stale evidence can cause refusal. Captures expire after one second, so a response within the three-second request timeout can still abstain if its evidence is too old. A valid model reply cannot authorize a covered, disabled, stale or ambiguous target. The policy gates are experimental, not calibrated reliability claims.

Generated configuration reference: [config.schema.json](schemas/config.schema.json).

## Authoring

Use a durable selector first, concise intent as fallback, an explicit mutation effect, and exact deterministic result assertions. Start with the [fixture flows](../examples/flows/jev/). Inspect effective config, lint, run cold, review the learned lock, then replay with `--frozen --no-lock-write`. A valid warm lock should need no JEV resolution calls; explicit JEV assertions still run.

An `ai_judge` assertion uses JEV only when it explicitly sets `backend = "jev"` and a profile is configured. Existing assertions retain their default backend. Low confidence or unavailable evidence fails closed. Keep deterministic assertions alongside visual predicates.

```toml
[[steps.assert]]
type = "ai_judge"
backend = "jev"
prompt = "The selected row is highlighted blue"
inputs = ["screenshot"]
```

This screenshot assertion requires `images = "allow"` and remaining screenshot capacity. For text evidence, use `inputs = ["text"]`; omitted inputs default to text. Assertions share the step's request cap, so selection can exhaust capacity before a predicate runs. No authored confidence threshold is supported.

The visual profile replaces the configured generative L3 resolver. JEV abstention or capture failure escalates to an available L4 advisor without a generative L3 attempt.

Active profiles can add a bounded JEV diagnosis before an existing generative L4 advisor call. It requires room for both calls and is skipped under a dollar cap. Diagnosis is advisory: it cannot change selectors, retry a mutation, rewrite assertions or enable the planner.

Image policy gates remain experimental; browser fixtures and fake model responses do not
establish live model accuracy.
