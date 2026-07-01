// Flightplan — the L0 `LockHook` implementation.
//
// `createLockHook(composedLock)` returns a `LockHook` (the ladder's L0 cache interface,
// `src/ladder/types.ts`) backed by a runtime-composed lock view (`./compose.ts`). On
// `lookup(step, ctx)` it finds the target keyed by the step's id, converts it to the ladder's
// in-memory `CachedRecipe` (via `lockTargetToRecipe`), and returns it INCLUDING its `match`
// gate so L0 can validate `match.url_glob` + `match.sig` against the current page before trusting
// the recipe. Returns `undefined` on a miss (no target, or no replayable recipe).
//
// SEPARATION OF CONCERNS. The hook's job is the lookup + shape conversion. The actual trust
// decision (does the current URL match `url_glob`? does the current page `sig` match?) is L0's,
// using the `match` carried on the returned `CachedRecipe` and the matchers in `./signature.ts`
// (`urlGlobMatches`, `signatureMatches`). We OPTIONALLY pre-filter on `url_glob` when the context
// already knows `currentUrl` (a cheap early miss that saves L0 a sig computation) — but we never
// suppress the `match` field, so L0 still does the authoritative check.
//
// Canonical references: PLAN.md §5 Phase 3 (L0 validates url_glob + sig before replay),
// `src/ladder/types.ts` (`LockHook`, `CachedRecipe`, `ResolveContext`).

import type { CachedRecipe, LockHook, ResolveContext } from "../ladder/index.ts";
import type { Step } from "../flow/index.ts";
import type { ComposedEntry, ComposedLock } from "./compose.ts";
import { lookupComposed } from "./compose.ts";
import { lockTargetToRecipe } from "./recipe.ts";
import { urlGlobMatches } from "./signature.ts";

/** Options for {@link createLockHook}. */
export interface CreateLockHookOptions {
  /**
   * When `true` (default), and the `ResolveContext` carries `currentUrl`, the hook returns
   * `undefined` early if the target's `url_glob` does not match the current URL — a cheap miss
   * that spares L0 a signature computation. The authoritative `url_glob` + `sig` validation still
   * happens in L0 against the returned `match`. Set `false` to always return the recipe and leave
   * ALL validation to L0.
   */
  prefilterUrl?: boolean;
  /**
   * Resolve the compose namespace for a step (for imported-module steps). When provided and the
   * bare step id misses, the hook retries with `lookupComposed(composed, step.id, namespace)`.
   * Defaults to "no namespace" (root-flow steps only).
   */
  namespaceFor?: (step: Step) => string | undefined;
}

/**
 * Build an L0 {@link LockHook} over a runtime-composed lock view. `lookup` is synchronous
 * (no I/O — the composed view is already in memory); it satisfies the hook's
 * `Promise<CachedRecipe|undefined> | CachedRecipe | undefined` return contract by returning the
 * value directly.
 */
export function createLockHook(
  composed: ComposedLock,
  options: CreateLockHookOptions = {},
): LockHook {
  const prefilterUrl = options.prefilterUrl ?? true;
  const namespaceFor = options.namespaceFor;

  return {
    lookup(step: Step, ctx: ResolveContext): CachedRecipe | undefined {
      const entry: ComposedEntry | undefined = lookupComposed(
        composed,
        step.id,
        namespaceFor?.(step),
      );
      if (!entry) return undefined;

      // Cheap early miss: if we already know the URL and the glob can't match, don't bother
      // building/validating the recipe. (L0 still validates authoritatively when we do return.)
      if (prefilterUrl && ctx.currentUrl !== undefined) {
        if (!urlGlobMatches(entry.target.match.url_glob, ctx.currentUrl)) {
          return undefined;
        }
      }

      // Convert to the ladder's in-memory recipe, carrying `match` so L0 validates url_glob + sig.
      return lockTargetToRecipe(entry.target);
    },
  };
}
