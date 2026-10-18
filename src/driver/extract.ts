/** A finite, declarative DOM projection. Selectors are data; no author script runs. */
export interface ExtractionSpec {
  selector: string;
  max_rows: number;
  fields: Record<
    string,
    {
      selector: string;
      source: "text" | "value" | "attribute";
      attribute?: string;
      type: "string" | "number" | "boolean";
      required: boolean;
      secret?: boolean;
    }
  >;
}
export interface ExtractionCandidate {
  selector: string;
  text: string;
  attributes?: Record<string, string>;
}
export function extractionCandidatesExpression(selector: string): string {
  return `(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    if (!row) return [];
    return [row, ...row.querySelectorAll('[data-testid], [data-test], [data-qa], [id], [name]')].slice(0, 200).flatMap(element => {
      const privateSelector = '[data-secret], [data-sensitive], [data-private], input[type="password"]';
      if (element.closest(privateSelector)) return [];
      const attribute = ['data-testid','data-test','data-qa','id','name'].find(key => element.hasAttribute(key));
      if (!attribute) return [];
      const copy = element.cloneNode(true);
      copy.querySelectorAll(privateSelector).forEach(node => node.remove());
      return [{ selector: element === row ? '.' : '[' + attribute + '=' + JSON.stringify(element.getAttribute(attribute)) + ']', text: (copy.textContent || '').trim().slice(0, 300) }];
    });
  })()`;
}

export function extractionExpression(spec: ExtractionSpec): string {
  return `(() => {
    try {
    const spec = ${JSON.stringify(spec)};
    const rows = [...document.querySelectorAll(spec.selector)];
    if (rows.length > spec.max_rows) throw new Error('extract row limit exceeded');
    return rows.map(row => Object.fromEntries(Object.entries(spec.fields).flatMap(([name, field]) => {
      const matches = field.selector === '.' ? [row] : [...row.querySelectorAll(field.selector)];
      if (matches.length > 1) throw new Error('extract field is ambiguous: ' + name);
      const element = matches[0];
      const raw = !element ? null : field.source === 'text' ? element.textContent : field.source === 'value' ? element.value : element.getAttribute(field.attribute);
      if (raw === null || raw === undefined) {
        if (field.required) throw new Error('extract required field missing: ' + name);
        return [];
      }
      let value = String(raw).trim();
      if (field.type === 'number') {
        if (!/^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new Error('extract invalid number: ' + name);
        value = Number(value);
      } else if (field.type === 'boolean') {
        if (value !== 'true' && value !== 'false') throw new Error('extract invalid boolean: ' + name);
        value = value === 'true';
      }
      return [[name, value]];
    })));
    } catch (error) { return { __flightplanExtractionError: String(error.message) }; }
  })()`;
}

/** Validate even custom/mock driver returns: malformed data never becomes a successful result. */
export function validateExtraction(value: unknown, spec: ExtractionSpec): void {
  if (!Array.isArray(value) || value.length > spec.max_rows)
    throw new Error("extract invalid collection");
  for (const row of value) {
    if (
      row === null ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      (Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null)
    )
      throw new Error("extract invalid row");
    for (const name of Object.keys(row))
      if (!Object.hasOwn(spec.fields, name)) throw new Error("extract unknown field");
    for (const [name, field] of Object.entries(spec.fields)) {
      const actual = Object.hasOwn(row, name) ? (row as Record<string, unknown>)[name] : undefined;
      if (actual === undefined && !field.required) continue;
      if (typeof actual !== field.type || (typeof actual === "number" && !Number.isFinite(actual)))
        throw new Error(`extract invalid field: ${name}`);
    }
  }
}
