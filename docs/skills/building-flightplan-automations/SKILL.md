---
name: building-flightplan-automations
description: Builds, hardens, runs, diagnoses, and proves production-quality browser automations as Flightplan workflows backed by browser-pilot. Use when implementing end-to-end browser tasks, adding fixture or live automation lanes, debugging flaky UI actions, or reviewing safety and evidence. Final workflow execution must use Flightplan; direct browser-pilot is for low-level diagnosis and contract probes only.
---

# Building Flightplan Automations

Use this skill when the deliverable is a reliable browser automation, not a one-off click script.

## Non-negotiable architecture

Flightplan is the workflow, policy, retry, lock, assertion, artifact, and proof layer. Browser-pilot is
the CDP driver underneath it.

```text
fixture or application
  -> Flightplan TOML flow
  -> Flightplan runner and safety policy
  -> browser-pilot driver
  -> browser and server-side effects
```

- Write the final automation as a Flightplan flow.
- Use browser-pilot CLI commands only to inspect a page, isolate a CDP/browser defect, or validate a
  driver contract before expressing the behavior in Flightplan.
- Do not ship a shell script of direct `bp exec` calls when the task needs retries, locks, effects,
  popup ownership, assertions, mutation budgets, or evidence.

Read [references/automation-quality.md](references/automation-quality.md) for benchmark-derived failure
patterns and the release checklist. For TOML syntax, read the `authoring-flightplan-workflows` skill.

## Build lifecycle

### 1. Define the contract before touching the browser

Write down:

- the business goal and final state;
- read-only, idempotent, and at-most-once steps;
- preconditions and exact postconditions;
- target identity and ambiguity rules;
- server-side mutation ledger or equivalent oracle;
- cleanup, restoration, tenant allowlist, and mutation budget;
- artifacts required for audit.

If the effect cannot be observed deterministically, stop and add an oracle or fixture contract before
authoring the flow.

### 2. Establish a fresh driver boundary

From the Flightplan checkout:

```sh
bun run dev:link-browser-pilot
bun run verify:browser-pilot
bun run verify:browser-pilot:packed
```

If the installed package is a stale copy, inspect the resolved path and remove only the stale copied
browser-pilot package or generated cache. Rebuild the linked browser-pilot `dist`, relink, and rerun
both verification commands. Do not delete all dependencies or silently fall back to a global package.

Record version, source hash, build hash, resolved package path, and worktree state in the run notes.

### 3. Discover the application, then express it in Flightplan

Use browser-pilot inspection for reconnaissance:

```sh
bp connect --name discovery
bp page -s discovery
bp snapshot -s discovery -i
bp forms -s discovery --json
bp review -s discovery --json
```

After discovery, close the browser-pilot session and write the behavior as TOML. Preserve the useful
selectors, landmarks, readiness conditions, and popup identity in the flow. Do not make the discovery
session the automation.

### 4. Author the flow as a state machine

Every flow should include:

```toml
version = 1
kind = "flow"
id = "domain.operation"
description = "Short business goal"
goal = "Exact final state"

[config.connect]
mode = "launch"
headless = true

[config.plan]
enabled = false

[run]
max_steps = 20
assertions = "eager"
assert_timeout_ms = 6000
```

Use ordered targets with stable selectors first and one concise natural-language anchor last. Mark
every action with `effect`. Add a semantic readiness assertion after navigation or delayed hydration.

### 5. Harden each effect

For `at_most_once` steps:

- resolve and veto ambiguity before dispatch;
- add `retry = { policy = "never" }` when re-entry is unsafe;
- omit `on_fail.self` and any post-dispatch action retry;
- attach an exact, scoped postcondition;
- preserve the original before-state when observing a retry boundary;
- use a fixture/server ledger to count committed effects;
- add fault injection after commit and prove observation rescues the result without redispatch.

For read-only flows, prove non-mutation with both unchanged business state and a zero-entry ledger.

### 6. Model SPA and popup behavior

Do not use URL change as the only readiness signal. Assert a hydrated heading, row, form field, status,
or loading-overlay removal. For a popup, attach `[steps.popup]` to the triggering step with URL, title,
type, and timeout. Flightplan must arm observation before the click, filter by opener, tolerate
`about:blank`, attach the matched page, and retain popup provenance.

Never choose a popup by tab index, first target, or active-tab side effect.

### 7. Run in layers

Run in this order:

```sh
bun run flightplan lint path/to/flow.toml
bun run flightplan migrate-effects path/to/flow.toml
bun run flightplan run path/to/flow.toml \
  --frozen --no-lock-write --json -o /tmp/flightplan-run
```

Then run the flow from a clean fixture reset. For local seeded mutations, set `ALLOW_MUTATIONS=1`
only for the specific mutation flow. Never use that local gate as proof of live authorization.

### 8. Prove, do not infer

A flow passes only when all relevant evidence agrees:

- `summary.json` has the expected verdict and provenance;
- `run.jsonl` and `trace.jsonl` exist and have valid associations;
- each effectful step reports `dispatchState`, `retrySafe`, attempts, and matched conditions;
- server ledger counts equal the expected counts;
- final business state is exact;
- reversible state is restored;
- popup artifacts contain the matched target and opener;
- repeated clean runs do not add duplicate effects.

An exit code or a successful click is not a mutation proof.

## Failure handling

Use `flightplan explain <run-dir>` before changing a selector. Classify the result:

| Observation | Response |
|---|---|
| `not_dispatched` | Repair readiness, resolution, or actionability; retry only with explicit safe policy |
| `dispatched` | Observe the postcondition; never resend the effect |
| `uncertain` | Poll state and ledger; never resend the effect |
| Assertion timeout after a ledger commit | Fix oracle scope or timing, not mutation retry |
| Ambiguity after dispatch | Treat as a safety defect; move resolution before dispatch |
| Stale lock or dependency | Fail closed, inspect source/build hash, refresh intentionally |
| Popup timeout | Inspect opener/target events and title/URL updates; do not repeat the trigger |

Use direct browser-pilot tools only to answer a narrow driver question. Once the cause is known, add a
Flightplan regression or fixture contract and rerun the Flightplan flow.

## Live automation gate

Do not run scheduled live mutations until deterministic fixtures pass repeatedly. A live mutation also
requires:

- exact tenant and store allowlists;
- authenticated session checks;
- seeded disposable resource;
- mutation budget, normally one per logical effect;
- precondition and exact postcondition;
- cleanup or restoration;
- artifact retention with redaction;
- serial execution when resources overlap.

Keep the planner disabled for safety proofs. Enable AI tiers only in a separate, bounded experiment with
a clear goal and explicit cost budget.

## Completion checklist

- [ ] Final behavior is a Flightplan TOML flow.
- [ ] Direct browser-pilot usage is limited to discovery or driver diagnosis.
- [ ] Dependency symlink, source hash, and build freshness are verified.
- [ ] Effects, retry policy, anchors, readiness, and exact postconditions are explicit.
- [ ] Popup expectations are attached before the trigger dispatch.
- [ ] Frozen/no-lock-write run passes from reset.
- [ ] Fault injection covers response loss or context destruction after commit.
- [ ] Ledger, final state, and artifacts prove the result.
- [ ] Live lane is gated or explicitly skipped when configuration is absent.
