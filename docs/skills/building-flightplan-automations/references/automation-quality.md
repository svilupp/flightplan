# Browser Automation Quality Reference

## Benchmark-derived defects

| Defect | Required design response |
|---|---|
| Click navigates, then a destroyed context triggers a stale retry | Treat post-dispatch context loss as `dispatched` or `uncertain`; never rerun the click |
| Broad input catch falls back to JavaScript click after mouse input | Allow fallback only before an effectful input event |
| Missing target falls back to another tab | Fail closed on explicit target constraints |
| URL commit arrives before SPA hydration | Add semantic readiness assertions |
| `pointer-events:none` control appears actionable | Check hit target and pointer-event chain |
| Repeated role/name controls resolve by first match | Require scoped selectors, fingerprints, and ambiguity vetoes |
| Popup target is observed after the click | Arm popup observation on the triggering Flightplan step |
| Popup starts at `about:blank` | Wait for target metadata and later URL/title updates |
| Recording actions reuse `action-1` | Require unique action IDs and valid screenshot associations |
| Stale lock replays a changed recipe | Compare `source_hash` before browser connection; use frozen mode for proof |
| Assertion says `Paid` while the page still shows `Unpaid` | Scope exact text to the status badge |
| Status text passes after mutation but state is wrong | Verify field/state value and server ledger |

## Shopify pattern

The seeded Shopify flow has four committed effects: duplicate draft, pay draft, create order, fulfill
order. Fulfillment is a two-step UI boundary: open the panel, then confirm. Use one `at_most_once` step
per committed effect and verify the exact badge or resource ID after each step.

## Swap pattern

The seeded Swap flows cover read-only return review, one approval, settings save/restore, and popup
isolation. Filter the request by ID before opening it. Scope the settings field because gift-card and
exchange bonuses look alike. Declare popup URL/title/type and verify opener provenance.

## Proof commands

Assume `flightplan` is available on `PATH`. The same commands can be launched as
`npx flightplan ...` or `bunx flightplan ...`; from this checkout use `bun run flightplan ...`.

```sh
flightplan lint path/to/flow.toml
flightplan migrate-effects path/to/flow.toml
flightplan run path/to/flow.toml --frozen --no-lock-write --json -o /tmp/flightplan-proof
flightplan explain /tmp/flightplan-proof/<run-id>
```

For local fixtures, reset state before each lane and compare state/ledger before and after. Store all
three run artifacts: `summary.json`, `run.jsonl`, and `trace.jsonl`.
