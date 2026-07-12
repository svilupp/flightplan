# Flightplan Benchmark Learnings

These notes capture failure modes observed while driving deterministic Shopify and Swap admin fixtures
through browser-pilot and Flightplan.

## Shopify admin

- The Duplicate menu item creates a draft immediately. It has no confirmation boundary. Mark it
  `at_most_once` and prove the new draft ID or ledger entry.
- The page renders a shell before useful controls. Wait for the heading or row control, not only the URL.
- Accessibility names can flatten several Polaris controls. Scope `More actions` to the draft row.
- Fulfillment is two actions: open the fulfillment panel, then confirm. Model both steps. Do not infer
  that opening the panel fulfilled the order.
- `Paid` can appear in a timeline while the badge still says `Unpaid`. Scope an exact `Paid` assertion
  to the payment badge.
- A side-effect response can be lost after the server commits. Observe the exact order/draft state and
  ledger without replaying the click.

## Swap returns and launcher

- The first interactive snapshot can be empty even after navigation. Poll a semantic element or field.
- The requests table is noisy and virtualized. Filter by request ID, require count `1`, then open that
  request. Do not select the first row with a matching label.
- Return details contain unnamed controls and irreversible buttons. Use stable fixture selectors and
  exact seeded markers before opening a mutation boundary.
- A launcher can contain duplicate store rows and unrelated popups. Attach popup expectations to the
  sign-in action and filter by opener, URL, type, title, and creation time.
- A popup may be created at `about:blank` and navigate later. Do not require the final URL at the first
  target-created event.
- Settings has two similar bonus fields. Scope the gift-card field and assert the untouched exchange
  value as a guard against editing the wrong field.
- Save and restore are separate mutations. Count both and assert the original persisted value after
  restoration.

## Failure patterns and repairs

| Failure | Safe repair |
|---|---|
| Click returned success but the app did not look changed | Poll the postcondition; never click again until no effect was possible |
| Post-dispatch context destruction | Mark `dispatched` or `uncertain`; inspect state and ledger |
| Ambiguous candidates after a click | Move resolution and ambiguity veto before dispatch |
| Broad text assertion passed on the wrong region | Add an exact matcher and a selector or landmark |
| Popup timeout after a valid click | Declare popup expectation on the trigger; preserve opener metadata and wait for title/URL updates |
| Flow used stale browser-pilot code | Remove the inspected copied dependency cache, relink source, rebuild `dist`, verify installed and packed APIs |
| Runtime accepted an old lock | Compare `source_hash` before connecting; use frozen mode for proof |
| Flow linted but mutation was unsafe | Add `effect = "at_most_once"`, natural-language anchor, and a deterministic postcondition |
| Assertion timed out after a committed mutation | Fix selector/text scope or readiness; do not make the mutation retryable |

## Proof checklist

1. Reset fixture state.
2. Verify the Flightplan browser-pilot symlink and build freshness.
3. Lint the flow and review `migrate-effects` output.
4. Run with `--frozen --no-lock-write --json` into a dedicated output directory.
5. Check `summary.json`, `run.jsonl`, and `trace.jsonl`.
6. Check the server ledger and final business state.
7. Repeat the run from reset when proving at-most-once behavior.

The local admin harness exposes reset, state, and ledger endpoints and fault injection. Those are test
contracts. Do not copy fixture seed markers, fault query parameters, or local tenant IDs into live flows.
