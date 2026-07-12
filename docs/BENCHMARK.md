# Flightplan benchmark report

Current run date: 2026-07-12. This report replaces the previous contents of this file. It
contains current-run comparisons only; it does not preserve older benchmark claims.

## Results at a glance

| Area | Result |
| --- | --- |
| In-harness checks | `check` OK in 3.40s; lint 1.18s; typecheck 7.76s; test 3.15s |
| Example-flow lint | 0 errors, 0 warnings |
| `benchmark-new` | 5/6 scenarios passed; 34/34 resolving steps at L1; 0 AI calls; $0 |
| Documented 54-run comparison | 51/54 passed: tiered 27/27, AI-only baseline 24/27 |
| `flightplan-benchmarks` cold campaign | 27/54 passed across tiered and baseline arms; $0.124307 |
| `flightplan-benchmarks` warm tiered sweep | 21/27 passed; $0.011193 |
| Lock and drift checks | Zero drift in both benchmark reports; lock stability passed |

The tiered arm in the documented 54-run comparison took 104.177s and cost $0.007702686.
The AI-only baseline took 200.530s and cost $0.044031. On this run, tiered execution was
1.93x faster and 5.72x cheaper. All three baseline failures were `contexts` at
`confirm_in_frame` during the L3-to-L4 path.

## Context and environment

- Date: 2026-07-12, Darwin 24.6.0 arm64 development environment.
- Project: `/Users/jan/Documents/GitHub/flightplan`.
- Runtime: Bun 1.3.12 + TypeScript, using the repository's documented check harness.
- Browser provider in raw run metadata: browser-pilot 0.1.0 from the released npm package.
- `benchmark-new` used a fixture server on port 3001 and ran with
  `OPENROUTER_API_KEY` and `OPENAI_API_KEY` unset. Each scenario used a fresh copied flow,
  isolated cache/home paths, and a fresh lock output path.
- `flightplan-benchmarks` validated a fixture server on port 3100. Its raw run metadata uses
  browser-pilot launch mode with headless Chrome. Cold and warm runs used separate sweep
  directories and reported lock reuse as described below.

## In-harness checks

Commands:

```sh
bun run check
bun run lint
bun run typecheck
bun run test
bun run flightplan lint examples/flows
```

Results:

- `check`: OK, 3.40s
- `lint`: OK, 1.18s
- `typecheck`: OK, 7.76s
- `test`: OK, 3.15s
- Example-flow lint: 0 errors, 0 warnings

## Documented 54-run comparison

This comparison contains 27 tiered runs and 27 AI-only baseline runs over the documented
flows. The tiered arm uses the L0-to-L4 ladder. The baseline starts at the vision tier and
falls through to the advisor.

| Arm | Passes | Shell time | Cost | Relative result |
| --- | ---: | ---: | ---: | --- |
| Tiered | 27/27 | 104.177s | $0.007702686 | 1.93x faster; 5.72x cheaper |
| AI-only baseline | 24/27 | 200.530s | $0.044031 | Comparison arm |
| Total | 51/54 | 304.707s | $0.051733686 | - |

Failure details:

- All three failures were the baseline `contexts` flow at `confirm_in_frame`.
- The baseline reached L3 and then L4 before failing.
- Lock stability passed.
- A warm example sweep passed 8/9. The `gauntlet` result was inconclusive after an advisor
  timeout.
- Variant checks (raw artifact elapsed time): `drift` variant b resolved at L1 in 4.205s;
  variant c resolved at L3 in 12.537s; the changed-signature variant resolved at L1 in
  4.341s.

## `benchmark-new`

Six fresh scenarios were linted and run cold. Shell time is the first value; the measured
flow-run duration is the second value.

| Scenario | Verdict | Shell / run duration | Failure |
| --- | --- | ---: | --- |
| wizard | PASS | 6.90s / 6.691s | - |
| async-dashboard | PASS | 5.30s / 5.126s | - |
| rerender | PASS | 4.38s / 4.217s | - |
| overlays | PASS | 6.22s / 6.022s | - |
| contexts | FAIL | 4.14s / 3.879s | `fill_iframe_input` |
| gauntlet | PASS | 5.92s / 5.573s | - |

Aggregate report:

- 5/6 scenarios passed.
- 34/34 resolving steps were deterministic L1 resolutions.
- Tier share: L0 0, L1 100%, L2 0, L3 0, L4 0.
- Model calls: 0. Cost: $0.
- Step latency p50/p95: 241ms / 2074ms.
- All flow lint runs: 0 errors, 41 warnings.

`contexts` is a known direct-iframe limitation. The parent-mediated iframe step passed, but
the direct `fill_iframe_input` step fails at L1 because the flow has not switched into the
iframe. Shadow steps were not reached because assertions are eager. This is a targeted
limitation result, not evidence that the deterministic resolver regressed: the reachable
parent-mediated steps passed and all 34 resolving steps stayed at L1.

## `flightplan-benchmarks`

The campaign covers nine scenarios with three trials per arm. The cold isolated campaign has
54 runs: 27 tiered and 27 baseline. The warm campaign has 27 tiered runs using the locks
produced by the cold campaign.

### Per-scenario median results

Times are wall-clock medians per three-trial scenario cell.

| Scenario | Cold tiered | Warm tiered | Cold AI-only baseline |
| --- | ---: | ---: | ---: |
| auth-portal.main | 3/3, 5.71s | 3/3, 5.64s | 3/3, 19.11s |
| auth-portal.shared-login | 3/3, 4.71s | 3/3, 4.63s | 3/3, 13.34s |
| admin-crud | 3/3, 5.72s | 3/3, 5.79s | 0/3 inconclusive, 13.40s |
| checkout | 3/3, 11.93s | 3/3, 11.71s | 0/3 inconclusive, 15.32s |
| checkout-loops | 3/3, 11.62s | 3/3, 11.82s | 0/3 inconclusive, 14.90s |
| icon-editor | 0/3 failed, 18.41s | 0/3 failed, 17.86s | 0/3 failed, 14.93s |
| live-dashboard | 3/3, 5.11s | 3/3, 5.40s | 0/3 inconclusive, 7.96s |
| saas-onboarding | 3/3, 7.86s | 3/3, 7.44s | 0/3 inconclusive, 13.03s |
| saas-onboarding-recover | 0/3 failed, 9.01s | 0/3 failed, 9.04s | 0/3 failed, 17.76s |

### Aggregate metrics

| Metric | Cold isolated: tiered + baseline, 54 runs | Warm tiered, 27 runs |
| --- | ---: | ---: |
| Passed / not passed | 27 / 27 | 21 / 6 |
| Shell time | 639.17s | 242.14s |
| Resolving steps / all steps | 390 / 573 | 279 / 384 |
| Tier counts L0 / L1 / L2 / L3 / L4 | 0 / 260 / 0 / 126 / 4 | 273 / 3 / 0 / 3 / 0 |
| Deterministic share | 66.67% | 98.92% |
| Escalation rate | 33.33% | 1.08% |
| Total cost | $0.124307 | $0.011193 |
| Cost per pass | $0.004604 | $0.000533 |
| Step latency p50 / p95 | 238ms / 2254ms | 225ms / 2050ms |
| Drift | 0 | 0 |
| Lock stability | Passed | Passed |

Role-level model usage:

| Campaign | Role | Calls | Cost |
| --- | --- | ---: | ---: |
| Cold isolated | vision | 130 | $0.115226 |
| Cold isolated | judge | 9 | $0.008294 |
| Cold isolated | resolver | 7 | $0.000471 |
| Cold isolated | advisor | 4 | $0.000317 |
| Warm | judge | 9 | $0.008312 |
| Warm | vision | 3 | $0.002664 |
| Warm | resolver | 3 | $0.000218 |

The warm sweep reached L0 on 273/279 resolving steps, or 97.85%. The remaining resolving
steps were three L1 and three L3 steps. No drift or healed steps were recorded in either
report.

## Efficiency findings

| Finding | Evidence |
| --- | --- |
| Tiered vs AI-only | 1.93x faster and 5.72x cheaper in the documented 54-run comparison |
| Lock reuse | Warm tiered resolution was 97.85% L0, with 98.92% deterministic share and $0.000533 cost per pass |
| Vision batching | 8/8 for both batch and singles; $0.000955 vs $0.004669 and 2.77s vs 11.96s |
| Cheap dueling arm | 5/5 at $0.000261 |
| Incremental planning | 2.51x full-plan cost and 4.35x full-plan tokens in the uncached test |

The cold and warm `flightplan-benchmarks` shell totals are not a direct speed ratio because
the cold aggregate contains 54 runs while warm contains 27. The per-scenario table and the
documented 54-run comparison provide the comparable timing results.

## Failures and limitations

These are the observed failure modes and their classification. A failure is not labeled a
regression unless the run provides a before/after result that supports that claim.

| Area | Observed result | Classification |
| --- | --- | --- |
| `benchmark-new` direct iframe | `contexts` fails at `fill_iframe_input`; parent-mediated iframe interaction passes | Known direct-iframe limitation |
| `benchmark-new` shadow path | Shadow steps were not reached because assertions are eager | Test coverage limitation |
| `saas-onboarding-recover` | Post-action `Choose your plan` assertion times out; `on_fail` jump is not taken | Known flow/control-flow limitation |
| `icon-editor` | L3 vision selects the wrong unlabeled toolbar candidate; cold advisor can time out | Known vision/advisor failure mode |
| `icon-editor` baseline | All three cold runs escalated through L3 vision and ended with unresolved L4 attempts; the advisor timed out in runs 1–2 and returned a non-repairing heal recommendation in run 3 | Known baseline vision/advisor failure mode |
| `gauntlet` | Warm example result is inconclusive after advisor timeout | Known advisor timeout |
| Model probes | Two obsolete model IDs return 404; active credentials and models work | Environment/model-registry limitation |
| Official `flightplan-benchmarks` `run.sh` | The official glob lints `*.lock.toml` files and fails before the intended lint pass | Benchmark harness limitation |

Regression status: no regression is established by these results. The current evidence shows
zero drift, stable locks, all 34 `benchmark-new` resolutions at L1, and the expected variant
behavior. The failed scenarios above remain limitations or failure modes of the tested flows,
vision path, advisor path, baseline, or harness. This report is not a historical regression
study.

## Auxiliary learning tests

All 21 auxiliary scripts exited 0. Total auxiliary spend was approximately $0.15.

| Test | Result |
| --- | --- |
| Intent notes vs prescriptive selector | Intent 7/7; selector 5/7 |
| Note on an unlabeled icon | 0% without a note; 100% with a note |
| Batch vision vs eight single calls | Both 8/8; batch $0.000955 vs singles $0.004669; batch 2.77s vs singles 11.96s |
| All-cheap dueling agents | 5/5 at $0.000261 |
| Incremental planning vs full plan | 2.51x the cost and 4.35x the tokens of full planning |

The auxiliary data also found that text-representable disambiguation and routine replanning
did not separate cheap and expensive models in these small tests. The vision tests used a
clean synthetic toolbar and hand-authored snapshots, so they do not establish production
accuracy on dense, low-contrast, or near-duplicate controls. The incremental planning result
is uncached and therefore does not measure prompt-cache savings. These tests are directional,
not statistical estimates.
