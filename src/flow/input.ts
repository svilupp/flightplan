import { z } from "zod";

export type InputValue =
  | string
  | number
  | boolean
  | null
  | InputValue[]
  | { [key: string]: InputValue };
export type InputValues = Record<string, InputValue>;
export const InputDeclarationSchema = z.union([
  z.string(),
  z
    .object({
      type: z.enum(["string", "number", "boolean", "object", "array"]),
      description: z.string().optional(),
      required: z.boolean().optional(),
      default: z.json().optional(),
      secret: z.boolean().optional(),
    })
    .strict(),
]);
export type InputDeclaration = z.infer<typeof InputDeclarationSchema>;
export interface InputIssue {
  code: string;
  input: string;
  message: string;
}
export class InputBindingError extends Error {
  constructor(readonly issues: InputIssue[]) {
    super(issues.map((issue) => `${issue.code}: ${issue.input}: ${issue.message}`).join("\n"));
    this.name = "InputBindingError";
  }
}
export function inputMetadata(value: InputDeclaration) {
  return typeof value === "string" ? { type: "string" as const, default: value } : value;
}
export function isInputJson(value: unknown, seen = new Set<object>()): value is InputValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  seen.add(value);
  const valid =
    !Object.keys(value).includes("__proto__") &&
    Object.values(value).every((child) => isInputJson(child, seen));
  seen.delete(value);
  return valid;
}
/** JSON.parse accepts duplicate keys. Inspect the valid token stream to reject them. */
export function parseInputJson(text: string): InputValues {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("inputs-file must contain valid JSON");
  }
  let position = 0;
  const whitespace = () => {
    while (/\s/.test(text[position] ?? "") && position < text.length) position++;
  };
  const string = (): string => {
    const start = position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === "\\") position++;
      else if (char === '"') return JSON.parse(text.slice(start, position)) as string;
    }
    throw new Error("inputs-file must contain valid JSON");
  };
  const value = (): void => {
    whitespace();
    if (text[position] === "{") {
      position++;
      whitespace();
      const keys = new Set<string>();
      while (text[position] !== "}") {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("inputs-file contains duplicate object keys");
        keys.add(key);
        whitespace();
        position++;
        value();
        whitespace();
        if (text[position] !== ",") break;
        position++;
      }
      position++;
    } else if (text[position] === "[") {
      position++;
      whitespace();
      while (text[position] !== "]") {
        value();
        whitespace();
        if (text[position] !== ",") break;
        position++;
      }
      position++;
    } else if (text[position] === '"') string();
    else while (position < text.length && !/[\s,}\]]/.test(text[position]!)) position++;
  };
  value();
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !isInputJson(parsed)
  )
    throw new Error("inputs-file must contain a finite JSON object");
  return parsed as InputValues;
}
function matches(value: InputValue, type: string): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === type && (type !== "number" || Number.isFinite(value));
}
function envReference(value: InputValue): string | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof value.from_env === "string"
  )
    return value.from_env;
  return undefined;
}
/** Bind caller values without interpreting caller-provided template text. */
export function bindInputs(
  declared: Record<string, InputDeclaration> | undefined,
  supplied: InputValues = {},
  env: Record<string, string | undefined> = {},
  defaultValue: (value: InputValue, prior: InputValues) => InputValue = (value) => value,
  allowUndeclared = false,
  requireInputs = true,
  trustedSecrets: ReadonlySet<string> = new Set(),
): InputValues {
  const out: InputValues = Object.create(null) as InputValues;
  const issues: InputIssue[] = [];
  if (!isInputJson(supplied))
    throw new InputBindingError([
      {
        code: "INPUT_JSON",
        input: "<inputs>",
        message: "Inputs must contain finite, acyclic JSON values.",
      },
    ]);
  for (const name of Object.keys(supplied)) {
    if (!Object.hasOwn(declared ?? {}, name) && !allowUndeclared)
      issues.push({ code: "INPUT_UNKNOWN", input: name, message: "Input is not declared." });
  }
  for (const [name, declaration] of Object.entries(declared ?? {})) {
    const meta = inputMetadata(declaration);
    const provided = Object.hasOwn(supplied, name);
    let value = provided ? supplied[name] : meta.default;
    if (value === undefined) {
      if (meta.required && requireInputs)
        issues.push({ code: "INPUT_REQUIRED", input: name, message: "Required input is missing." });
      continue;
    }
    if (meta.secret && !(provided && trustedSecrets.has(name) && typeof value === "string")) {
      const reference = envReference(value);
      if (!reference) {
        issues.push({
          code: "INPUT_SECRET_REFERENCE",
          input: name,
          message: "Secret input requires a from_env reference.",
        });
        continue;
      }
      const secret = env[reference];
      if (secret === undefined) {
        if (!requireInputs) continue;
        issues.push({
          code: "INPUT_SECRET_UNAVAILABLE",
          input: name,
          message: "Referenced environment variable is not set.",
        });
        continue;
      }
      value = secret;
    } else if (!provided) {
      try {
        value = defaultValue(value, out);
      } catch {
        if (!requireInputs) continue;
        issues.push({
          code: "INPUT_DEFAULT",
          input: name,
          message: "Input default could not be resolved.",
        });
        continue;
      }
    }
    if (!matches(value, meta.type)) {
      issues.push({ code: "INPUT_TYPE", input: name, message: `Expected ${meta.type}.` });
      continue;
    }
    out[name] = value;
  }
  if (allowUndeclared)
    for (const [name, value] of Object.entries(supplied)) {
      if (!Object.hasOwn(declared ?? {}, name)) out[name] = value;
    }
  if (issues.length) throw new InputBindingError(issues);
  return out;
}
export function inputScalar(value: InputValue, name: string): string {
  if (value !== null && typeof value === "object")
    throw new Error(`Input ${name} cannot be embedded in text; use a whole input reference.`);
  return String(value);
}
export function gatherInputSecrets(
  declared: Record<string, InputDeclaration> | undefined,
  values: InputValues,
): string[] {
  return Object.entries(declared ?? {}).flatMap(([name, declaration]) => {
    const value = values[name];
    return inputMetadata(declaration).secret && typeof value === "string" && value.length
      ? [value]
      : [];
  });
}
