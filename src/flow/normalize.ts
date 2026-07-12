// Flightplan — flow normalization: `for_each` loop expansion (load-time).
//
// A `for_each` step is a LOAD-TIME macro: one step with `for_each = [...]` expands into N
// concrete steps, one per item, with `${item}` / `${item.key}` / `${loop.index}` /
// `${loop.index1}` substituted into `target` (string or list), `value`, and `url`. Expansion runs on the
// RAW parsed TOML doc — BEFORE zod validation and BEFORE the linter's per-step rules — so
// everything downstream (schema, lint, runner, locks) only ever sees concrete steps. The
// `for_each` key itself is consumed here and never reaches the schema.
//
// Id stability: each expanded step gets `"<base-id>#<index1>"` (1-based). Stable + unique ids
// matter so lock keys map correctly across runs (a reordered/edited list keeps `add_item#1`
// pointing at "the first added item").
//
// Token scoping: only for_each-expanded steps may use `${item}` / `${loop.*}`. Those tokens are
// resolved HERE (against the iteration) and stripped; `${inputs.*}` / `${env.*}` are left intact
// for the normal templating pass. A `${item}` / `${loop.*}` token on a NON-for_each step is a
// hard error (the linter surfaces it; the loader throws) — otherwise it would silently survive to
// the runner and fail obscurely.
//
// Canonical reference: task spec Feature C.

import {
  applyLoopTemplatingDeep,
  hasLoopToken,
  type LoopContext,
  TemplateError,
} from "./template.ts";

/** Raised when a `for_each` step (or a stray loop token) is malformed. */
export class ForEachError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ForEachError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True if `v` is a valid `for_each` items array (all strings OR all string-valued tables). */
function normalizeItems(v: unknown, path: string): LoopContext["item"][] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new ForEachError(
      `\`for_each\` must be a non-empty array of strings (or tables), got ${JSON.stringify(v)}.`,
      path,
    );
  }
  const items: LoopContext["item"][] = [];
  for (const entry of v) {
    if (typeof entry === "string") {
      items.push(entry);
    } else if (isRecord(entry)) {
      // Array-of-tables: keep only string values (exposed as `${item.key}`).
      const rec: Record<string, string> = {};
      for (const [k, val] of Object.entries(entry)) {
        if (typeof val !== "string") {
          throw new ForEachError(
            `\`for_each\` table item field \`${k}\` must be a string, got ${JSON.stringify(val)}.`,
            path,
          );
        }
        rec[k] = val;
      }
      items.push(rec);
    } else {
      throw new ForEachError(
        `\`for_each\` items must all be strings or all be tables; found ${JSON.stringify(entry)}.`,
        path,
      );
    }
  }
  return items;
}

/**
 * Recursively assert no `${item}` / `${loop.*}` token survives on a NON-for_each step. Used to
 * enforce that loop tokens are only ever used inside a `for_each` step.
 */
function assertNoLoopTokens(step: Record<string, unknown>, id: string, path: string): void {
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (hasLoopToken(value)) {
        throw new ForEachError(
          `Step \`${id}\` uses a loop token (\`\${item}\`/\`\${loop.*}\`) in ${JSON.stringify(
            value,
          )} but has no \`for_each\`. Loop tokens are only valid inside a \`for_each\` step.`,
          path,
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (isRecord(value)) {
      for (const v of Object.values(value)) walk(v);
    }
  };
  walk(step);
}

/**
 * Expand every `for_each` step in a raw steps array into concrete steps. Returns a NEW array
 * (input not mutated). Non-`for_each` steps pass through unchanged (but are checked for stray
 * loop tokens). Throws {@link ForEachError} on a malformed `for_each` or a misused loop token.
 */
export function expandForEachSteps(
  steps: Record<string, unknown>[],
  path: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  steps.forEach((step, i) => {
    if (!("for_each" in step)) {
      assertNoLoopTokens(step, typeof step.id === "string" ? step.id : `#${i}`, path);
      out.push(step);
      return;
    }
    const baseId = typeof step.id === "string" && step.id.length > 0 ? step.id : `#${i}`;
    const items = normalizeItems(step.for_each, path);
    // Strip `for_each` from the template body; every other field is templated per iteration.
    const { for_each: _dropped, ...body } = step;
    items.forEach((item, idx) => {
      const loop: LoopContext = { item, index: idx };
      let expanded: Record<string, unknown>;
      try {
        expanded = applyLoopTemplatingDeep(body, loop);
      } catch (err) {
        // Re-wrap the template engine's error as a ForEachError so the loader/linter handle every
        // for_each failure through one path.
        if (err instanceof TemplateError) {
          throw new ForEachError(`Step \`${baseId}\`: ${err.message}`, path);
        }
        throw err;
      }
      // Stable, unique per-iteration id: `<base>#<1-based-index>`.
      expanded.id = `${baseId}#${idx + 1}`;
      out.push(expanded);
    });
  });
  return out;
}

/**
 * Expand `for_each` steps in a raw parsed-TOML flow doc. Returns the SAME object when there is
 * nothing to expand (byte-identical behaviour for flows without `for_each`), else a shallow copy
 * with a fresh `steps` array. Non-flow docs / docs without a `steps` array pass through.
 */
export function expandForEachInDoc(
  doc: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const steps = doc.steps;
  if (!Array.isArray(steps)) return doc;
  const anyForEach = steps.some((s) => isRecord(s) && "for_each" in s);
  const anyLoopToken = steps.some((s) => isRecord(s) && !("for_each" in s) && stepHasLoopToken(s));
  if (!anyForEach && !anyLoopToken) return doc;
  const rawSteps = steps.filter(isRecord);
  return { ...doc, steps: expandForEachSteps(rawSteps, path) };
}

/** Shallow check: does any string leaf of a step carry a loop token? */
function stepHasLoopToken(step: Record<string, unknown>): boolean {
  let found = false;
  const walk = (value: unknown): void => {
    if (found) return;
    if (typeof value === "string") {
      if (hasLoopToken(value)) found = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (isRecord(value)) {
      for (const v of Object.values(value)) walk(v);
    }
  };
  walk(step);
  return found;
}
