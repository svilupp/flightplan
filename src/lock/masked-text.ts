// Flightplan — the masked-text page-signature component (L0 cache-hit quality, Layer 1 + 2).
//
// The COMPOSITE `match.sig` has two components (see `signature.ts`):
//   - TEXT   — historically browser-pilot's raw visible-text hash (`"{url}|{hash}"`), which
//              masked NOTHING, so any live counter/clock/feed thrashed it → an L0 miss.
//   - STRUCT — a pure role-tree hash that already masks dynamic ARIA roles.
//
// This module computes a VOLATILE-TEXT-MASKED replacement for the raw text component, straight
// from the accessibility tree the ladder already snapshots (no extra driver round-trip). It walks
// the a11y tree and hashes the accessible names/values of the remaining nodes, EXCLUDING subtrees
// that are volatile the same way struct already does:
//
//   - ARIA role in the dynamic mask set (status/alert/log/timer/progressbar/marquee) — the same
//     `DEFAULT_MASK_ROLES` browser-pilot's structure signature collapses;
//   - `[aria-live]` (polite/assertive) live regions;
//   - `[data-live]` regions;
//   - `hidden` / `aria-hidden` subtrees;
//   - any subtree matched by a caller-supplied `ignore_regions` selector (Layer 2 `[cache]`).
//
// The hard requirement (see the CHANGELOG entry): on a re-run the composite signature MUST still
// match when the ONLY changes are inside masked/volatile regions, and must NOT match when a
// non-masked region changes. Because a real browser-pilot `SnapshotNode` only carries
// `role`/`name`/`value` (its `properties` map is not populated by the live snapshot builder — see
// `browser-pilot/src/browser/page.ts`), role-based masking always applies, and the attribute-based
// masks (`aria-live`/`data-live`/`hidden`/`aria-hidden`) apply whenever `node.properties` DOES
// carry them (tests, or a future browser-pilot that populates them). No `Date`/`Math.random`: the
// hash is a pure, deterministic function of the (masked) tree, mirroring browser-pilot's own
// `signature.ts` FNV-1a discipline so the output is stable for the committed lock.

import type { PageSnapshot, SnapshotNode } from "../driver/index.ts";

/**
 * Dynamic accessibility roles whose subtrees are collapsed out of the MASKED-TEXT signature by
 * default — the same live-region / ephemeral roles browser-pilot's structure signature masks
 * (`browser-pilot/src/browser/signature.ts` `DEFAULT_MASK_ROLES`). Kept in sync deliberately so
 * the text and struct components agree on what "volatile" means.
 */
export const DEFAULT_MASK_ROLES = [
  "status",
  "alert",
  "log",
  "timer",
  "progressbar",
  "marquee",
] as const;

/** Options for {@link computeMaskedTextHash} (Layer 2 `[cache] ignore_regions` threads in here). */
export interface MaskedTextOptions {
  /**
   * CSS selectors whose subtrees are excluded from the hash (Layer 2). Accessibility nodes carry
   * no CSS selector, so — mirroring browser-pilot's `maskSelectors` — each entry is matched against
   * a node's `role`, `name`, `ref`, `role/name`, OR any of its DOM `properties`/attribute values.
   * A leading `#`/`.`/`[` is tolerated (stripped) so common id/class/attr selectors still match a
   * node's `id`/`class`/attribute where the snapshot exposes it.
   */
  ignoreRegions?: readonly string[];
}

/**
 * Compute the masked-text hash component for a snapshot: `"{url}|{hash}"` where `hash` is a pure
 * FNV-1a over the accessible names/values of the NON-volatile a11y subtrees (see the module
 * header for what is masked). The `{url}` prefix mirrors browser-pilot's raw text signature shape
 * (`"{url}|{hash}"`) so the composite format is unchanged; only the hash basis is now masked.
 */
export function computeMaskedTextHash(
  snapshot: PageSnapshot,
  opts: MaskedTextOptions = {},
): string {
  const ignore = normalizeSelectors(opts.ignoreRegions);
  const tokens: string[] = [];

  const walk = (nodes: SnapshotNode[] | undefined): void => {
    if (!nodes) return;
    for (const node of nodes) {
      if (isVolatile(node, ignore)) continue; // drop the node AND its subtree
      // Emit the accessible name/value as the content basis (role prefix keeps a name that moves
      // between roles distinguishable, mirroring how struct keys on role).
      const role = (node.role ?? "").toLowerCase();
      const name = (node.name ?? "").trim();
      const value = (node.value ?? "").trim();
      if (name.length > 0 || value.length > 0) {
        tokens.push(`${role}|${name}|${value}`);
      }
      walk(node.children);
    }
  };

  walk(snapshot.accessibilityTree);
  return `${snapshot.url}|${fnv1a(tokens.join("\n"))}`;
}

/** Roles masked by default, lower-cased for comparison. */
const MASK_ROLE_SET = new Set<string>(DEFAULT_MASK_ROLES.map((r) => r.toLowerCase()));

/**
 * Is this node volatile (masked)? True when its role is a dynamic mask role, when its
 * `properties` mark it as a live/hidden region, or when a caller `ignore_regions` selector
 * matches it. A volatile node is dropped together with its whole subtree.
 */
function isVolatile(node: SnapshotNode, ignore: Set<string>): boolean {
  const role = (node.role ?? "").toLowerCase();
  if (MASK_ROLE_SET.has(role)) return true;

  const props = node.properties;
  if (props) {
    // `[aria-live]` polite/assertive live regions.
    const live = strProp(props["aria-live"]) ?? strProp(props.live);
    if (live && live !== "off") return true;
    // `[data-live]` opt-in volatile regions.
    if (props["data-live"] !== undefined) return true;
    // `hidden` / `aria-hidden` subtrees.
    if (isTruthyProp(props.hidden) || isTruthyProp(props["aria-hidden"])) return true;
  }

  if (ignore.size > 0 && matchesIgnore(node, role, ignore)) return true;
  return false;
}

/** True when any normalized ignore selector matches this node's role/name/ref/role-name/attrs. */
function matchesIgnore(node: SnapshotNode, role: string, ignore: Set<string>): boolean {
  const name = node.name ?? "";
  if (
    ignore.has(role) ||
    ignore.has(name) ||
    ignore.has(node.ref) ||
    ignore.has(`${role}/${name}`)
  ) {
    return true;
  }
  // Also match against DOM attribute VALUES the snapshot happens to expose (id/class/testid/…),
  // so a `#feed` / `.ticker` / `[data-live]` ignore selector prunes the right subtree.
  const props = node.properties;
  if (props) {
    for (const key of ["id", "class", "className", "data-testid", "name"]) {
      const v = strProp(props[key]);
      if (v === undefined) continue;
      // class attributes are space-separated — match any single class token too.
      if (ignore.has(v)) return true;
      for (const token of v.split(/\s+/)) {
        if (token.length > 0 && ignore.has(token)) return true;
      }
    }
    // A raw attribute-presence selector like `[data-live]` (normalized to `data-live`).
    for (const attr of ignore) {
      if (attr in props) return true;
    }
  }
  return false;
}

/**
 * Normalize caller selectors into a plain match set: trim, strip a single leading CSS sigil
 * (`#`/`.`) and surrounding `[ ]` (so `#feed` → `feed`, `.ticker` → `ticker`, `[data-live]` →
 * `data-live`, `[data-testid='x']` → the attr name AND its quoted value). Empty entries dropped.
 */
function normalizeSelectors(selectors: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  if (!selectors) return out;
  for (const raw of selectors) {
    const s = raw.trim();
    if (s.length === 0) continue;
    out.add(s); // keep the verbatim form too (matches role/name/ref exactly)
    if (s.startsWith("#") || s.startsWith(".")) {
      out.add(s.slice(1));
    } else if (s.startsWith("[") && s.endsWith("]")) {
      const inner = s.slice(1, -1);
      const eq = inner.indexOf("=");
      if (eq < 0) {
        out.add(inner.trim()); // `[data-live]` → attr name presence
      } else {
        out.add(inner.slice(0, eq).trim()); // attr name
        const val = inner
          .slice(eq + 1)
          .trim()
          .replace(/^['"]|['"]$/g, "");
        if (val.length > 0) out.add(val); // attr value
      }
    }
  }
  return out;
}

/** Coerce a `properties` entry to a string (numbers/booleans stringify; else undefined). */
function strProp(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** True when a `properties` entry represents a truthy flag (`true`, `"true"`, `""` presence). */
function isTruthyProp(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "string") return v === "" || v.toLowerCase() === "true";
  return false;
}

/** Pure FNV-1a 32-bit hash, base36 — identical discipline to browser-pilot's `signature.ts`. */
function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
