import { expect, test } from "bun:test";
import { type ExtractionSpec, validateExtraction } from "./extract.ts";

const spec: ExtractionSpec = {
  selector: ".row",
  max_rows: 2,
  fields: {
    id: { selector: ".id", source: "text", type: "string", required: true },
    count: { selector: ".count", source: "text", type: "number", required: false },
  },
};

test("extract accepts own JSON fields and absent optional fields", () => {
  expect(() => validateExtraction([{ id: "one", count: 0 }, { id: "two" }], spec)).not.toThrow();
});

test("extract accepts records with a null prototype", () => {
  const row: Record<string, unknown> = Object.create(null);
  row.id = "one";
  expect(() => validateExtraction([row], spec)).not.toThrow();
});

for (const key of ["toString", "constructor", "__proto__"]) {
  test(`extract rejects undeclared own ${key} field`, () => {
    const row: unknown = JSON.parse(`{"id":"one","${key}":"unexpected"}`);
    expect(() => validateExtraction([row], spec)).toThrow("extract unknown field");
  });
}

test("extract rejects inherited required fields", () => {
  const row: unknown = Object.create({ id: "inherited" });
  expect(() => validateExtraction([row], spec)).toThrow("extract invalid row");
});

test("extract rejects class instances even with valid own fields", () => {
  class Row {
    id = "one";
  }
  expect(() => validateExtraction([new Row()], spec)).toThrow("extract invalid row");
});

test("extract checks declared prototype-like names as own fields", () => {
  const field: ExtractionSpec["fields"][string] = {
    selector: ".id",
    source: "text",
    type: "string",
    required: true,
  };
  const namedSpec: ExtractionSpec = {
    ...spec,
    fields: { toString: field },
  };
  expect(() => validateExtraction([{}], namedSpec)).toThrow("extract invalid field");
  expect(() => validateExtraction([{ toString: "one" }], namedSpec)).not.toThrow();
});
