# Hosted Cloudflare and borrowed sessions

`[config.connect] mode = "hosted"` accepts `provider = "cloudflare"`,
`"cloudflare:chromium"` or `"cloudflare:kitesurf"`. `account_id_env` and
`api_token_env` are credential names, defaulting to `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`. Literal credential fields are rejected. Native token mode
owns its browser and closes it at teardown. The default runner resolves these
names from `RunOptions.env`, falling back to the process environment when omitted.
It forwards the run signal and deadline into acquisition.

These two values authenticate browser allocation. Cloudflare Access service-token
client IDs and secrets authenticate a protected target website instead; configure
those separately under `[config.auth.cf_access]` only when the website requires
Access. A local browser visiting an Access-protected site needs the Access pair
but no hosted-browser credentials. A hosted browser visiting a public site needs
only the account ID and API token. Both pairs are needed when combining hosted
Cloudflare browsing with Access service-token authentication.

For an existing owner-held browser, use `mode = "session"`, `session_ref`, and
an explicit `target_policy = "selected"` or `"exact"`. Exact selection also
requires `target_id`. The host resolves session_ref; a URL does not establish
identity.

```ts
import { BrowserPilotDriver, acquireDriverLease } from '@svilupp/flightplan/worker';

const driverFactory = (_config, context) => new BrowserPilotDriver({
  acquisitionContext: context,
  acquire: async (config, scope) => {
    if (config.mode !== "session") throw new Error("This acquirer only borrows sessions");
    const handle = handles.get(config.session_ref);
    if (!handle) throw new Error("Unknown session reference");
    const deadline = scope?.deadline === undefined ? hostContext.deadline
      : hostContext.deadline === undefined ? scope.deadline
      : Math.min(scope.deadline, hostContext.deadline);
    const lease = await owner.acquire(handle, {
      ...hostContext,
      signal: scope?.signal
        ? AbortSignal.any([hostContext.signal, scope.signal])
        : hostContext.signal,
      deadline,
    });
    return acquireDriverLease(lease, config.target_id);
  },
});
```

The synchronous factory constructs a driver. Acquisition occurs during
`connect()` after run admission. Teardown detaches a borrowed lease and leaves
the owner's socket/provider allocation alive. Keep the host generation stable
across runs. Workers inject their binding through the acquirer; bindings and
Browser objects do not appear in TOML or flow JSON. Inject binary-capable
FileSystemPort/ArtifactSink implementations for PNG output.

Static imports use browser-pilot/core. Native attach/launch/JWT behavior is
loaded only on native paths; Worker hosts must provide the acquirer. Local
workerd validation uses explicit bundled modules, with no nodejs_compat.
The local responses are simulated; live browser and checkout gates are separate.

Owned hosted teardown reports `cleanup_pending` as a cleanup failure and preserves
its exact allocation in the error's `providerCleanup` property. A closed local
socket does not establish provider release. The host must retain/reconcile that
cleanup identity; do not allocate another browser as a cleanup retry.

## Flow configuration

Owned hosted acquisition (native Node/Bun host; Flightplan includes the `ws`
transport dependency for authenticated Node sockets):

```toml
# Browser allocation credentials only. Public target websites need no Access pair.
# For an Access-protected target, also configure [config.auth.cf_access]
# with client_id_env and client_secret_env (see the README auth example).
[config.connect]
mode = "hosted"
provider = "cloudflare:chromium"
account_id_env = "CLOUDFLARE_ACCOUNT_ID"
api_token_env = "CLOUDFLARE_API_TOKEN"
```

A host-resolved borrowed target:

```toml
[config.connect]
mode = "session"
session_ref = "checkout-owner"
target_policy = "exact"
target_id = "host-selected-target-id"
```

`session_ref` is an opaque host registry reference, not a WebSocket URL. The
normal CLI does not supply an arbitrary custom host registry; inject a driver
factory/acquirer when using this mode. Scope signal/deadline to each run and
preserve the host generation across leases.

## Validation boundaries

Packed Node and local workerd borrowed flows passed; the workerd lane uses
simulated browser responses. Real Chromium shared-owner runs validate target,
connection, child-frame and PNG behavior locally. Live Cloudflare Chromium SauceDemo checkout and locked-user flows now pass with
provider-confirmed release; see the validation report. Loss/reconnect and
Kitesurf conformance remain unverified. A previous
Kitesurf checkout exhausted memory and child-context probes returned wrong
or blank documents; do not infer support from successful configuration parsing.
Native Bun has an unresolved compressed-socket diagnostic failure; the maintained
Node transport passes that scenario. Public SauceDemo demo completion is a
separate site fixture and does not prove Adyen or real payment support.

## Acquisition and cleanup failures

Host acquisition is bounded by the run signal/deadline, including a custom host
that ignores cancellation. A lease arriving late is detached rather than
admitted; retain the original error because asynchronous late-detach failure is
attached as `acquisitionCleanupError` (and `providerCleanup` when available).
There is no automatic second acquisition.

A normal run with failed teardown rejects with `Flightplan driver cleanup failed`.
Its `cause` retains the cleanup error, `providerCleanup` retains exact provider
identity when present, and `runResult` preserves the workflow verdict and artifact
paths. A successful body/summary does not establish successful cleanup. Persist
these error fields and reconcile before another allocation. Interruption errors
retain their separate `cleanup` status contract.

## Recorded stress validation

The bounded real-Chromium control completed 25 borrowed flows and one successful
post-cancellation flow on one owner connection, with a constant single target;
ten competing acquisitions rejected before browser work. Five screenshots had
valid PNG signatures/dimensions. The target, local Chrome, HTTP server and profile
were removed. Generic provider release reported `cleanup_pending` with
`localTerminated: true`; exact local process termination is recorded separately
and is not remote release confirmation.

Seven adversarial regressions cover 100 driver borrow/detach cycles, pre-cancel
admission, noncooperative acquisition cancellation/deadline, late detach failure,
and cleanup errors after passed and failed flow bodies.
