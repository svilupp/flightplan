// Flightplan — ladder page-signature capture (Phase 3 L0 validation + lock write-back).
//
// Computes the COMPOSITE page signature (`match.sig`) for the page a tier resolves against, from
// the ONE snapshot the tier already took plus one driver call for the structural component:
//
//   - TEXT component   — a VOLATILE-TEXT-MASKED hash computed INSIDE flightplan straight from the
//                        snapshot's accessibility tree (`lock/masked-text.ts`). It excludes
//                        volatile subtrees (dynamic ARIA roles / `[aria-live]` / `[data-live]` /
//                        `hidden` / `aria-hidden` / caller `ignore_regions`) so a live
//                        counter/clock/feed no longer thrashes the signature (L0 cache-hit
//                        quality, Layer 1 + 2). Historically this was browser-pilot's RAW
//                        visible-text hash, which masked nothing.
//   - STRUCT component — `driver.captureStateSignature({ mode: 'structure', maskSelectors })` →
//                        browser-pilot's native `captureStructureSignature` (`"{urlPath}|{hash}"`,
//                        a pure role-tree hash). Content-insensitive, structure-sensitive; the
//                        `ignore_regions` are threaded in so a masked subtree is excluded from
//                        BOTH components (Layer 2).
//
// The two are combined via `computeMatchSignature` into the value the lock stores in `match.sig`
// and L0 validates. The masked-text hash is computed from the SAME pre-action snapshot the tier
// resolved against (no extra snapshot round-trip — single-snapshot discipline).
//
// This is the `ladder → lock` dependency PLAN.md §2 sanctions ("ladder/ depends on … lock/").
// lock/signature.ts + lock/masked-text.ts import only driver TYPES, so there is NO runtime cycle.

import type { Driver, PageSnapshot } from "../driver/index.ts";
import { computeMaskedTextHash } from "../lock/masked-text.ts";
import { type CacheOptions, computeMatchSignature } from "../lock/signature.ts";

/**
 * Capture the composite page-signature basis for `snapshot` (the pre-action page). Returns the
 * composite `match.sig` and the page URL — exactly the inputs the lock `match` gate needs. The
 * `snapshot` MUST be the one the tier resolved against (taken before any action).
 *
 * `cache` (optional, from `[cache]` config) supplies `ignore_regions` that are excluded from BOTH
 * the masked-text hash and the structural hash (Layer 2). The masked-text component is computed
 * from `snapshot` directly; the structural component still goes through the driver (browser-pilot
 * native), with `ignore_regions` passed as its `maskSelectors`.
 */
export async function capturePageSignature(
  driver: Driver,
  snapshot: PageSnapshot,
  cache?: CacheOptions,
): Promise<{ sig: string; url: string }> {
  const ignoreRegions = cache?.ignoreRegions;
  const textSig = computeMaskedTextHash(snapshot, ignoreRegions ? { ignoreRegions } : {});
  const structSig = await driver.captureStateSignature({
    mode: "structure",
    ...(ignoreRegions && ignoreRegions.length > 0 ? { maskSelectors: [...ignoreRegions] } : {}),
  });
  return { sig: computeMatchSignature(textSig, structSig), url: snapshot.url };
}
