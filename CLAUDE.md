# CLAUDE.md

flightplan — a TOML-defined browser-automation flow runner. A flow file describes a browser task
as ordered steps with attached assertions; flightplan executes it, self-heals selector drift
through a layered cost ladder (L0→L4), and validates outcomes with deterministic + AI assertions.
Bun + TypeScript + AI SDK v6 + browser-pilot. See `README.md` and `docs/` for the full design.

## Dev harness — quiet on success

One runner drives every check: `scripts/check.ts`. Success is silence — each leg prints a single
`<Label>: OK`; on failure it prints `<Label>: FAIL` and the tool's full output, then exits non-zero.

```sh
bun run check        # all legs: lint + typecheck + test
bun run lint         # Lint:      OK   (biome check + oxlint --type-aware)
bun run typecheck    # Typecheck: OK   (tsc --noEmit)
bun run test         # Tests:     OK   (bun test)
bun run format       # biome format --write .   (mutates; verbose)
bun run lint:fix     # biome check --write . && oxlint --type-aware --fix   (auto-fix; verbose)
```

`check` runs every requested leg even if an earlier one fails, so one command surfaces all
failures at once. Pass a subset directly: `bun run scripts/check.ts lint typecheck`.

## Tooling

- **Biome** (`biome.json`) — formatter + linter. Format: 2-space indent, 100 col, double quotes,
  organize-imports on. Recommended lint rules.
- **oxlint** (`.oxlintrc.json`) — fast linter, run with `--type-aware` so the **tsgolint** engine
  (`oxlint-tsgolint`) applies type-aware TypeScript rules. `correctness` = error (fails the leg),
  `suspicious` = warn (advisory; the runner hides it on success).
- **tsc** (`tsconfig.json`) — `--noEmit` typecheck, strict, `noUncheckedIndexedAccess` on.
- **bun test** — unit tests (`*.test.ts`), all against `MockDriver` (no Chrome, no network).

Biome and oxlint warnings/infos do **not** fail a leg — only errors do. Keep the error count at
zero. Deliberately relaxed rules (don't "fix" them without reason):

- biome `style/noNonNullAssertion` — off. The codebase uses `!` deliberately; strict tsconfig backs it.
- biome `suspicious/noTemplateCurlyInString` — off. Flow TOML + prompts carry `${...}` placeholder
  syntax, so string literals containing `${}` are intentional.
- oxlint `typescript/await-thenable` — off in `**/*.test.ts` only. Bun's `expect().rejects/.resolves`
  matchers are typed as non-thenable, but the `await` is runtime-required — removing it breaks the
  assertion. Kept on for production code.

## Git policy — NEVER run git operations on your own

- NEVER run ANY git write/state-changing operation unless the user EXPLICITLY requests it in that
  message: `git commit`, `git add`/staging, `git push`, `git pull`, `git merge`, `git rebase`,
  `git reset`, `git checkout`/`git switch` (branch changes), `git stash`, `git tag`, `git branch`,
  `git cherry-pick`, creating PRs (`gh pr create`), or anything that mutates the repo, index, refs,
  or remote.
- "Explicitly requests" means the user names the action ("commit this", "push", "open a PR").
  Finishing a task or a green check run is NOT a request to commit. When in doubt, STOP and ask.
- Read-only git commands (`git status`, `git diff`, `git log`, `git show`) are fine for inspection.
- Do not work around this by scripting git through other tools, hooks, or aliases.

## Project conventions

- **Lock files are tracked, intentionally.** `bun.lock` (deps) and per-flow `*.lock.toml` (learned
  selector recipes) are committed source artifacts — never gitignore them.
- **Run output** lands in `.flightplan-runs/<run-id>/` (gitignored); override with `-o <dir>`.
- **Example flows** (`examples/flows/*.toml`) resolve deterministically (L0/L1) and need no API key.
  The AI tiers (L2 resolver / L3 vision / L4 advisor, `ai_judge` / `ai_pick`) require
  `OPENROUTER_API_KEY` — see `.env.example` and `docs/`.
- **`spikes/`** is a gitignored throwaway sub-package excluded from the harness; don't rely on it.
