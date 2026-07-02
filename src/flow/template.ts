// Flightplan — templating: ${inputs.*} and ${env.*} substitution.
//
// v0 supports exactly two sources (PROPOSAL "Data flow and templating"):
//   ${inputs.<name>} — values declared in [inputs] (plus `with` overrides from imports)
//   ${env.<NAME>}    — process environment variables
//
// Unknown ${inputs.x} where x is not declared → throw (resolves nothing silently). Unknown
// ${env.X} → throw as well (an undefined env var is almost always a misconfiguration; the
// linter can downgrade env refs to warnings via `collectRefs`). A linter hook
// (`collectRefs`) lets the separate linter validate declared-inputs usage without
// performing substitution.
//
// Canonical reference: PLAN.md §5 (Phase 1) and PROPOSAL "Data flow and templating".

/** Raised when templating references something that cannot be resolved. */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** Substitution context. `inputs` are the declared inputs (+ `with` overrides). */
export interface TemplateContext {
  inputs: Record<string, string>;
  /** Defaults to `process.env`. Override for hermetic tests. */
  env?: Record<string, string | undefined>;
}

/** A single `${...}` reference found in a template string. */
export interface TemplateRef {
  /** `'inputs'` or `'env'`. */
  source: "inputs" | "env";
  /** The dotted name after the source, e.g. `base_url` in `${inputs.base_url}`. */
  name: string;
  /** The full matched token, e.g. `${inputs.base_url}`. */
  raw: string;
}

// `${ <source>.<name> }` — source is `inputs` or `env`; name allows letters/digits/_/.,-.
// Whitespace inside the braces is tolerated. Anything else is left untouched (and, if it
// looks like a `${...}` token with an unknown source, reported by applyTemplating).
const TOKEN_RE = /\$\{\s*([a-zA-Z_][\w]*)\s*\.\s*([a-zA-Z_][\w.-]*)\s*\}/g;

/**
 * Find every `${inputs.*}` / `${env.*}` reference in a string. Pure (no resolution); used by
 * the linter hook and internally by {@link applyTemplating}.
 */
export function collectRefs(value: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  for (const m of value.matchAll(TOKEN_RE)) {
    const source = m[1];
    const name = m[2];
    if ((source === "inputs" || source === "env") && name !== undefined) {
      refs.push({ source, name, raw: m[0] });
    }
  }
  return refs;
}

/**
 * Substitute `${inputs.*}` and `${env.*}` in a single string. Throws {@link TemplateError}
 * for an undeclared input or an undefined env var. Tokens with an unknown source
 * (e.g. `${steps.x}`, deferred to v1) throw as well — they are not valid in v0.
 */
export function applyTemplating(value: string, ctx: TemplateContext): string {
  const env = ctx.env ?? process.env;
  return value.replace(TOKEN_RE, (raw, source: string, name: string) => {
    if (source === "inputs") {
      const v = ctx.inputs[name];
      if (v === undefined) {
        throw new TemplateError(
          `Undeclared input \`${name}\` referenced by \`${raw}\`. ` +
            `Declare it under [inputs] or pass it via an import's \`with\` clause.`,
        );
      }
      return v;
    }
    if (source === "env") {
      const v = env[name];
      if (v === undefined) {
        throw new TemplateError(
          `Environment variable \`${name}\` referenced by \`${raw}\` is not set.`,
        );
      }
      return v;
    }
    // Unknown source — not a valid v0 template source.
    throw new TemplateError(
      `Unsupported template source \`${source}\` in \`${raw}\`. ` +
        `v0 supports only \${inputs.*} and \${env.*}.`,
    );
  });
}

// ---------------------------------------------------------------------------
// for_each loop templating (`${item}`, `${item.key}`, `${loop.index}`, `${loop.index1}`).
//
// This is SCOPED: it runs ONLY while expanding a `for_each` step at load-time, and resolves
// exactly the loop tokens for the current iteration. It intentionally does NOT touch
// `${inputs.*}` / `${env.*}` (those are resolved later by applyTemplating with the run's inputs),
// so a loop token can never mask a missing input and vice-versa. Unknown loop tokens (e.g.
// `${item.missing}`, `${loop.bogus}`) throw {@link TemplateError} so a typo fails loud rather
// than silently expanding to nothing.
// ---------------------------------------------------------------------------

/** The per-iteration loop scope for a `for_each` expansion. */
export interface LoopContext {
  /** The current item — a bare string, or a record (array-of-tables entry) exposing `${item.key}`. */
  item: string | Record<string, string>;
  /** 0-based iteration index (`${loop.index}`). */
  index: number;
}

// `${ item }`, `${ item.key }`, `${ loop.index }`, `${ loop.index1 }`. Whitespace tolerated.
const LOOP_TOKEN_RE = /\$\{\s*(item|loop)(?:\s*\.\s*([a-zA-Z_][\w.-]*))?\s*\}/g;

/**
 * Substitute the loop tokens (`${item}`, `${item.key}`, `${loop.index}`, `${loop.index1}`) in a
 * single string against `loop`. Leaves `${inputs.*}` / `${env.*}` and everything else untouched.
 */
export function applyLoopTemplating(value: string, loop: LoopContext): string {
  return value.replace(LOOP_TOKEN_RE, (raw, source: string, key: string | undefined) => {
    if (source === "item") {
      if (key === undefined) {
        if (typeof loop.item !== "string") {
          throw new TemplateError(
            `\`${raw}\` refers to the whole item, but this \`for_each\` item is a table — ` +
              `use \`\${item.<key>}\` to reference one of its fields.`,
          );
        }
        return loop.item;
      }
      if (typeof loop.item === "string") {
        throw new TemplateError(
          `\`${raw}\` references field \`${key}\`, but this \`for_each\` item is a plain string. ` +
            `Use \`\${item}\` for a string item, or make the item a table with a \`${key}\` key.`,
        );
      }
      const v = loop.item[key];
      if (v === undefined) {
        throw new TemplateError(
          `\`${raw}\` references unknown item field \`${key}\` ` +
            `(available: ${Object.keys(loop.item).join(", ") || "<none>"}).`,
        );
      }
      return v;
    }
    // source === "loop"
    if (key === "index") return String(loop.index);
    if (key === "index1") return String(loop.index + 1);
    throw new TemplateError(
      `Unknown loop token \`${raw}\`. Supported: \${loop.index} (0-based), \${loop.index1} (1-based).`,
    );
  });
}

/**
 * Recursively apply loop templating to every string leaf (objects, arrays, scalars). Mirrors
 * {@link applyTemplatingDeep} but for the `for_each` loop scope. Returns a new structure.
 */
export function applyLoopTemplatingDeep<T>(value: T, loop: LoopContext): T {
  if (typeof value === "string") {
    return applyLoopTemplating(value, loop) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => applyLoopTemplatingDeep(v, loop)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = applyLoopTemplatingDeep(v, loop);
    }
    return out as T;
  }
  return value;
}

/** True if the string contains any `${item}` / `${item.*}` / `${loop.*}` token. */
export function hasLoopToken(value: string): boolean {
  LOOP_TOKEN_RE.lastIndex = 0;
  return LOOP_TOKEN_RE.test(value);
}

// `${ inputs.<name> }` only — used by the `run` flatten pass (./run.ts), which resolves a
// child's `${inputs.*}` against its effective (with-overridden) inputs at LOAD time while
// deliberately leaving `${env.*}` for the runner's normal templating pass.
const INPUTS_TOKEN_RE = /\$\{\s*inputs\s*\.\s*([a-zA-Z_][\w.-]*)\s*\}/g;

/**
 * Substitute ONLY `${inputs.*}` tokens against `inputs`, leaving `${env.*}` (and anything
 * else) untouched. Throws {@link TemplateError} for an undeclared input — a child step must
 * not carry an unresolvable input reference past the flatten pass.
 */
export function applyInputsTemplating(value: string, inputs: Record<string, string>): string {
  return value.replace(INPUTS_TOKEN_RE, (raw, name: string) => {
    const v = inputs[name];
    if (v === undefined) {
      throw new TemplateError(
        `Undeclared input \`${name}\` referenced by \`${raw}\`. ` +
          `Declare it under the flow's [inputs] or pass it via the \`run\` step's \`with\`.`,
      );
    }
    return v;
  });
}

/** Recursively apply {@link applyInputsTemplating} to every string leaf. Returns a new structure. */
export function applyInputsTemplatingDeep<T>(value: T, inputs: Record<string, string>): T {
  if (typeof value === "string") {
    return applyInputsTemplating(value, inputs) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => applyInputsTemplatingDeep(v, inputs)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = applyInputsTemplatingDeep(v, inputs);
    }
    return out as T;
  }
  return value;
}

/**
 * Recursively apply templating to every string in a value (objects, arrays, scalars).
 * Non-string leaves pass through unchanged. Used to template a flow's inputs/steps before
 * execution. Returns a new structure; the input is not mutated.
 */
export function applyTemplatingDeep<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === "string") {
    return applyTemplating(value, ctx) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => applyTemplatingDeep(v, ctx)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = applyTemplatingDeep(v, ctx);
    }
    return out as T;
  }
  return value;
}

/**
 * Resolve a flow's declared inputs into a concrete `Record<string,string>`, applying any
 * `with` overrides (from an importing flow) and templating each value (so an input like
 * `base_url = "${env.ADMIN_BASE_URL}"` is resolved). `with` overrides win over declarations.
 *
 * `with` values are themselves templated against `env` (and any already-resolved inputs the
 * caller supplies via `parentInputs`), matching PROPOSAL "Composition" where `with` carries
 * `${env.*}` / `${inputs.*}` references from the parent.
 */
export function resolveInputs(
  declared: Record<string, string> | undefined,
  withOverrides: Record<string, string> | undefined,
  env?: Record<string, string | undefined>,
  parentInputs?: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  const baseEnv = env ?? process.env;

  // First resolve `with` overrides against the parent's scope (env + parent inputs).
  const resolvedWith: Record<string, string> = {};
  if (withOverrides) {
    const parentCtx: TemplateContext = { inputs: parentInputs ?? {}, env: baseEnv };
    for (const [k, v] of Object.entries(withOverrides)) {
      resolvedWith[k] = applyTemplating(v, parentCtx);
    }
  }

  // Then resolve the module's own declared inputs against env (and itself, progressively).
  if (declared) {
    for (const [k, v] of Object.entries(declared)) {
      if (k in resolvedWith) {
        // `with` override wins — skip templating the declaration's default.
        continue;
      }
      resolved[k] = applyTemplating(v, { inputs: resolved, env: baseEnv });
    }
  }

  return { ...resolved, ...resolvedWith };
}
