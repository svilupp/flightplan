// Flightplan — ladder page-signature capture (Phase 3 L0 validation + lock write-back).
//
// Computes the COMPOSITE page signature (`match.sig`) for the page a tier resolves against,
// via TWO `driver.captureStateSignature()` calls (both read the same pre-action page):
//
//   - TEXT component   — `driver.captureStateSignature()` → `"{url}|{hash}"` (browser-pilot's
//                        visible-text hash; FINDINGS_browser-pilot §5). Content-sensitive.
//   - STRUCT component — `driver.captureStateSignature({ mode: 'structure' })` → browser-pilot's
//                        native `captureStructureSignature` (`"{urlPath}|{hash}"`, a pure
//                        role-tree hash). Content-insensitive, structure-sensitive.
//
// The two are combined via `computeMatchSignature` into the value the lock stores in `match.sig`
// and L0 validates. Calling both `captureStateSignature` reads BEFORE the action is what keeps
// the basis faithful to the page the recipe was learned on — a navigating click would otherwise
// mutate the page before we could read it. `snapshot` supplies the page URL for the return value.
//
// This is the `ladder → lock` dependency PLAN.md §2 sanctions ("ladder/ depends on … lock/").
// lock/signature.ts imports only driver TYPES, so there is NO runtime import cycle.

import type { Driver, PageSnapshot } from "../driver/index.ts";
import { computeMatchSignature } from "../lock/signature.ts";

/**
 * Capture the composite page-signature basis for `snapshot` (the pre-action page). Returns the
 * composite `match.sig` and the page URL — exactly the inputs the lock `match` gate needs. The
 * `snapshot` MUST be the one the tier resolved against (taken before any action), and this is
 * called before the action so both `captureStateSignature` reads see the same page.
 */
export async function capturePageSignature(
  driver: Driver,
  snapshot: PageSnapshot,
): Promise<{ sig: string; url: string }> {
  const textSig = await driver.captureStateSignature();
  const structSig = await driver.captureStateSignature({ mode: "structure" });
  return { sig: computeMatchSignature(textSig, structSig), url: snapshot.url };
}
