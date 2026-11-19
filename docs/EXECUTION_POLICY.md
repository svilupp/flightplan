# Execution policy and migration

Flightplan defaults to deterministic lock replay and DOM resolution. Set `[config.ai] enabled = true`
to permit its built-in AI paths. An API key, injected AI factory, model selection or generous budget
does not grant permission. The CLI's `config <flow> --json` reports the effective policy, conflicts,
deadlines and deadline sources without opening a browser.

## AI permission

With AI disabled, no built-in resolver, judge, planner, extraction mapper or remote guard runs.
Explicit classifiers (including the local heuristic), JEV profiles, AI assertions, `resolve = "ai"`,
vision hints, planner enablement and `--start-tier l3` fail preflight. The runner checks composed
steps and setup/teardown hooks before claiming an invocation key or acquiring a browser. Hooks
execute the source bytes checked during preflight, even if their files change later. An `ai_pick`
may still resolve deterministically. A cached extraction map may replay; a missing map requires
explicit selectors or an authorized AI run to learn it.

A configured `[config.guard]` also requires AI permission, including shadow mode. Conflicting
configuration fails before acquisition: Flightplan never silently removes a guard. A trusted
host-injected `actionGuard` callback remains active. Host callbacks and custom drivers can perform
their own network operations; this policy is not a process network sandbox.

For an existing AI flow, add:

```toml
[config.ai]
enabled = true
```

Then retain the classifier, provider, credentials, model registry and limits appropriate to that
flow. `classifier` selects L2 only; it does not disable deeper AI paths when permission is enabled.
Only the entry flow's configuration governs a composed run.

Planner enablement is rejected when the prepared flow, including child flows and setup/teardown
hooks, contains an `at_most_once` step. Backward failure jumps also cannot cross a protected step
that completed or may have dispatched.

`max_model_calls = 0` and `max_cost_usd = 0` reject remote work before dispatch and before model
image preparation. `max_screenshots = 0` rejects model image capture. Remote guards honor these
global zero limits while keeping their existing separate positive request/cost accounting. An
unavailable enforcing guard blocks actions; shadow mode only observes. Positive cost limits retain
their existing accounting semantics and do not reserve a universal upper bound for every provider.
An injected extraction mapper has its own call counter; positive limits are not aggregated with
a separately injected AI runtime. Local heuristic selection can run with AI permission and zero remote budgets.

A later `[run]` table replaces the whole earlier table. Repeat every required limit when replacing
it; omitted fields do not inherit earlier ceilings. Inspect `flightplan config <flow> --json`.

Recording is independent. Disable it with `[config.browser] record = false`. Frozen replay and
`--no-lock-write` control locks, not AI permission or recording.
Frozen mode permits live fallback when no lock exists. If CI requires a promoted lock, check that
the lock file exists before running.

## Navigation deadlines

| Deadline | Precedence |
| --- | --- |
| Document load | Step `timeout_ms`, then effective explicit `goto_ms`, then effective explicit legacy `nav_ms`, then 30000 ms |
| Optional navigation settle | Effective `nav_ms`, then 2000 ms |
| Assertion polling | Assertion `timeout_ms`, then run assertion timeout |

An explicit `goto_ms` remains authoritative even if a later config layer changes only `nav_ms`.
A step override affects document loading only. Document and settle failures identify their phase
and limit; a timeout does not establish that navigation was never dispatched. Strict
`OwnerActionDriver` hosts enforce their own deadlines and retain option restrictions.
Named-session compatibility borrowers use the driver deadlines.
A timed-out `goto` can recover only when an after assertion proves the requested URL with
`match = "exact"` or `"origin_path"`; content checks alone cannot prove the destination.

## Attached browsers and keyboard input

For unscoped `press` actions, raw attach verifies visibility and `document.hasFocus()` immediately before `press`, including
modified keys and one-action batches. The default never activates a tab. Opt in with:

```toml
[config.connect]
mode = "attach"
foreground = true
```

Activation targets only the acquired tab after guard approval. Flightplan waits briefly for the
focus event and verifies it before sending input. A failed check returns `not_dispatched` and is
safe to retry after restoring focus. This does not guarantee focus cannot change after the check;
assert the actual keyboard effect. Mixed raw-attach batches containing a keypress are rejected
before any action because the driver cannot check focus between their actions without changing
batch receipt semantics. Use separate steps.

Named browser-pilot sessions are the coordinated ownership path. Serialize raw-attach runs
externally and do not overlap them with an owner session sharing that browser profile. Per-tab
cleanup does not isolate cookies or application state. Raw-attach leasing is deferred.
Teardown closes owned tabs and their popup descendants, including failed popup expectations, while preserving reused tabs.

## Cleanup and interruption

After root entry admission, ordinary flow or setup failure permits one teardown-hook attempt on a
usable connection before driver cleanup. Rejected root entry contracts do not execute authored
teardown. Cleanup failures are reported without replacing the original flow verdict. External
cancellation skips flow hooks and uses bounded driver cleanup.

The native CLI forwards SIGINT and SIGTERM through the run cancellation signal, returning 130
and 143 respectively. Sweep stops scheduling new units after cancellation. Interruption reports
retain partial artifacts and distinguish completed, failed, or pending cleanup; cancellation does
not produce a successful run summary.

## Strict lint and sweeps

`flightplan lint <paths> --deny-warnings` returns exit 1 for warnings as well as errors, retaining
their original severities and counts. Without the flag, warnings remain nonfatal.

Sweep accepts run's `--input name=value`, `--input-env name=ENV` and `--inputs-file path` flags.
All flows, imports, hooks and typed bindings are prepared before the first trial. Invalid input
aborts the campaign with exit 2 and no dispatch. Duplicate flow IDs, overlapping flow artifact paths
and flow IDs that collide with campaign manifests are also rejected before trials. An existing
campaign output directory must be empty; a missing directory is created. Prepared source text is
pinned for the campaign. Trials remain sequential. Keep secrets in environment-backed bindings.
Campaigns claim `sweep.json` exclusively before dispatch. Custom sweep filesystems must implement
`createTextFileExclusive`; overlapping sweeps cannot share the same output directory.

`--compare-baseline` requests an L3 arm, so AI-disabled baseline units fail without dispatch or
downgrading; valid tiered units still run. Campaign exit 1 reports any failed unit. `sweep.json`
records every outcome, including preflight denials. `flightplan report` aggregates executed runs
and does not include units that never acquired a browser.

## Authentication checks

Use existing URL assertions with `match = "exact"` or `"origin_path"`, plus a stable authenticated
page marker, to prove the current destination. A broad host or substring match can pass on a login
page. Saved cookies do not guarantee an active server session; renew through the normal sign-in
flow when the authenticated destination check fails. No new expiry or sign-in policy is introduced.

## Composition and invocation replay

Preparation retains every source file and each call site's effective inputs. Secret input values
from child flows and setup/teardown hooks are redacted throughout the shared run artifacts.
Secret extraction fields in any composed step or hook disable recording for the whole run.

Invocation keys bind to the complete source graph and prepared actions, including bound
destinations. A changed child file or destination returns `INVOCATION_CONFLICT`. Execution uses
the source and input snapshots admitted before the claim. Declared secret inputs retain
reference-based credential rotation. Secret-marked raw URLs remain part of the one-way binding
digest; even a credential-only URL change can conservatively conflict. Raw secret URLs are not
stored in the binding.

Bindings include normalized source paths. The CLI stores claims under the current working
directory and uses that directory as the namespace. Relocation normally creates separate storage;
sharing a store and namespace can conflict after relocation. Portable replay identity is deferred.
Stored keys from earlier versions may also conflict after this upgrade. Check the previous outcome
before choosing a new key, which authorizes a new execution.
