# Flightplan compatibility and stress validation

Validated on 2026-10-04 against the current uncommitted browser-pilot/Flightplan
candidate. No release or deployment was performed.

| Lane | Result | Evidence / scope |
| --- | --- | --- |
| Companion checks | pass | Full lint/typecheck: pass; 1,239 tests pass, one opt-in skip; build and packed-package smoke pass |
| Driver/runner focused suite | pass | 314 tests, one opt-in integration skip |
| Borrowed driver stress | pass | 100 acquire/detach cycles; exactly one detach per driver |
| Real Chromium borrowed workflow stress | pass | 25 sequential flows plus one post-cancellation success, one owner connection, constant one target, ten contention rejections, five valid PNGs |
| Acquisition faults | pass | Pre-cancel does not call host; late noncooperative acquisition is bounded by abort/deadline and detached; no reacquisition; late cleanup identity retained |
| Teardown faults | pass | Normal passed/failed workflow retains body result/artifacts and surfaces cleanup failure with exact provider identity |
| Packed local workerd | pass | Portable companion/browser-pilot candidate, no Node compatibility flag; browser responses simulated |
| Real cross-consumer fixture | pass | Direct package, built CLI, just-bash, Flightplan on Chromium; two borrowed flows preserve one owner, child isolation and PNG bytes |
| Public SauceDemo source workflows | pass | Two simulated orders and locked-user rejection through source Flightplan runner, maintained Node transport and disposable profile with credential storage disabled |
| Built Node CLI SauceDemo | pass | 13-step demo checkout with prepared disposable profile; full JSON parses, Finish has one dispatched attempt, password absent from output |
| CLI output backpressure | pass | Native child-process regression: 2,000 JSON rows drain completely; former 8,192-byte truncation fixed |
| Live Cloudflare Chromium SauceDemo | pass | Two 13-step checkouts and one 4-step locked-user flow, independent hosted allocations; all releases confirmed closed; see live follow-up below |
| Live Kitesurf and Cloudflare fault/reconnect stress | unverified | Not exercised by the Chromium checkout follow-up; previous Kitesurf memory/context failures remain open |
| Real card payment | unproven | SauceDemo is a mock shop; Adyen/payment order-confirmation gates remain separate |

The stress review fixed three defects: piped CLI JSON truncation, accepting host acquisition after cancellation
or deadline, and discarding normal-run teardown errors. Acquisition failures keep
late cleanup errors; teardown failures now reject with `cause`, optional
`providerCleanup`, and `runResult`. A passed body summary is not proof that its
provider was released.

The generic real-browser owner's release returned `cleanup_pending` with
`localTerminated: true`. The exact fixture target was removed and owned Chrome
process killed; this is local cleanup evidence, not remote provider release.

## Reproduce

```sh
bun run check
bun run build
bun run test:package
```

The one-off live review scripts were removed after validation. The results below
record those runs; maintained build and package checks remain reproducible with
the commands above. See [the examples README](../examples/README.md#saucedemo-public-demo)
for standalone SauceDemo commands and disposable-profile setup. Public website
availability/content is an external dependency; the example is opt-in.

From sibling browser-pilot after building both candidates:

```sh
bun run test:runtime:flightplan
bun run test:conformance:local
```

The packed Workers lane simulates browser responses. Source stress and public-site
runs establish local Chrome behavior, not hosted Cloudflare conformance. Native
Bun's compressed-socket diagnostic remains unresolved; maintained Node transport
passed the exercised scenarios. Full backend evidence is in browser-pilot's
`docs/cloudflare-validation.md` and `CF_LEARNING.md`.

SauceDemo retained fresh-profile failures before completion: acknowledged input
had correct coordinates and hit target but no Add-to-cart events reached the
document. `--enable-automation` did not fix it; disabling credential saving in a
disposable profile did. Initial runs without profile isolation are retained as
exploration, not the final fixture proof. No dispatched click was retried in a
failed flow. Successful independent runs use the corrected profile setup; this
is a fixture/browser-environment control, not a force-click package workaround.

The built Node CLI also completed the checkout with only a disposable-profile
path added to a temporary copy of the original flow. The original default-profile
negative remains retained. Complete JSON, one dispatched Finish attempt and
password-free stdout/stderr now pass after changing CLI termination to natural
stream draining. An independent 2,000-row backpressure regression proves the
output correction; it failed at 8,192 bytes before the fix.

## Minor-version release preparation

The candidate versions are Flightplan 0.4.0 and browser-pilot 0.7.0.
Both packed candidates and their CLI version
outputs passed verification. Browser-pilot 0.7.0 was not available on npm during
preparation, so the companion's registry lock still resolves 0.6.0 while its
workspace declaration requests the candidate release. Publish browser-pilot first, then regenerate
Flightplan's registry lock before a frozen registry install or Flightplan release.
No checksum was invented for an unpublished registry artifact; local candidate
verification uses the actual packed 0.7.0 tarball. Neither package was published.

## PR readiness review — 2026-10-04

The local review corrected default-runner forwarding of hosted credentials and
cancellation/deadline context, preserved provider cleanup identity after setup
failure and interruption, and added regressions for those paths. The public
config barrel now exports hosted/session schemas and types consistently.
Flightplan includes `ws` for native authenticated connections. The recorded live
review used the installed browser-pilot public API, saved a SauceDemo report, and
attempted every borrowed resource cleanup even if release failed.

Re-run evidence: lint, typecheck, 1,239 tests (one additional opt-in skip), build,
and packed-consumer smoke passed against the installed 0.7.0 candidate. The real
Chromium stress helper passed 25 sequential runs plus one post-cancellation run,
ten contention rejections and five PNG checks. Both source SauceDemo checkouts,
the locked-user scenario and the built Node CLI checkout passed. Password
redaction and complete piped JSON were verified. Historical workerd and
cross-consumer results above were not re-run in this review; live hosted gates
remain unverified.

**Merge blocker:** npm still returns 404 for browser-pilot 0.7.0. The checked-in
lock resolves 0.6.0 despite the newer manifest requirement. An isolated
`bun install --frozen-lockfile --ignore-scripts` succeeded but installed 0.6.0;
its subsequent typecheck failed on missing core exports such as `BorrowedBrowser`,
`BrowserLease` and `normalizeProviderSelector`. Publish browser-pilot 0.7.0,
regenerate `bun.lock` with `bun install`, then run a clean frozen install and the
checks/package smoke before merging or publishing Flightplan.

## Live Cloudflare Chromium follow-up — 2026-10-04

The built Flightplan runner's default hosted driver completed two independent
13-step SauceDemo checkouts and the 4-step locked-user rejection flow against
`cloudflare:chromium`. Both checkouts verified the two products, quantities,
$39.98 subtotal, $3.20 tax, $43.18 total, exact completion heading and empty cart.
Every declared mutation dispatched once, including one Finish per checkout.
Artifact scanning found none of the supplied Cloudflare values or demo password.

Cloudflare confirmed HTTP 200 / `status: closed` on DELETE for each of the three
workflow allocations and the separate public-password discovery allocation.
The discovery browser reported Chrome 128.0.6613.137. No local Chrome or simulated
browser responses participated in this lane. Kitesurf, real payments, frame
conformance and provider fault/reconnect tests remain outside this evidence.

Two setup issues were resolved before the successful run: an inherited shell
credential overrode Node's `--env-file` value, and the older installed 0.7.0
candidate rejected Cloudflare's returned `/browser-rendering/` WebSocket URL.
The review explicitly loaded the project `.env`; the installed dependency
was refreshed from the already-built sibling candidate containing the validated
legacy-endpoint alias. Its release build must include that fix. Both rejected
endpoint allocations were confirmed released; no provider session was left open.

The recorded review created four billable browser allocations and stored a
redacted report plus per-flow artifacts in `.flightplan-runs/cloudflare-chromium-*`.
Cloudflare Access credentials were not needed or sent to the public demo website.
The successful local evidence is
`.flightplan-runs/cloudflare-chromium-1791115862190/report.json`.
For new hosted runs, use the default `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` names documented in [hosted configuration](cloudflare-hosted.md).
