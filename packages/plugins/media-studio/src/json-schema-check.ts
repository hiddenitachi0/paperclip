// A small checker for the part of JSON Schema that Sogni's published tool
// schemas use (vendor/sogni/...): type, enum, properties, required,
// additionalProperties, items, minimum/maximum, minLength/maxLength and
// minItems/maxItems. Anything else is refused up front by
// assertSupportedSchema, so a newer schema that needs more cannot be checked
// half-way without anyone noticing (the tests run it on every vendored file).
//
// Answers are plain sentences for the agent (and, through it, the person).

export type JsonSchema = Record<string, unknown>;

/** Keywords the checker enforces. */
const CHECKED = new Set([
  "type",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);
/** Keywords that only describe (no rule to enforce). */
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "schemaVersion", "default", "examples", "$comment"]);

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function asSchema(value: unknown): JsonSchema | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonSchema) : null;
}

/** Throws when the schema uses a keyword or a type this checker does not understand. */
export function assertSupportedSchema(schema: unknown, where = "schema"): void {
  const s = asSchema(schema);
  if (!s) throw new Error(`${where} is not a JSON schema object.`);
  for (const key of Object.keys(s)) {
    if (!CHECKED.has(key) && !ANNOTATIONS.has(key)) throw new Error(`${where} uses "${key}", which the checker does not support.`);
  }
  const types = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type];
  for (const t of types) if (typeof t !== "string" || !TYPES.has(t)) throw new Error(`${where} has an unknown type ${JSON.stringify(t)}.`);
  if (s.enum !== undefined && !Array.isArray(s.enum)) throw new Error(`${where} has an enum that is not a list.`);
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean") {
    throw new Error(`${where} has additionalProperties that is a schema; only true/false is supported.`);
  }
  if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((r) => typeof r !== "string"))) {
    throw new Error(`${where} has a required list that is not a list of names.`);
  }
  const props = s.properties === undefined ? {} : asSchema(s.properties);
  if (!props) throw new Error(`${where} has properties that are not an object.`);
  for (const [name, child] of Object.entries(props)) assertSupportedSchema(child, `${where}.${name}`);
  if (s.items !== undefined) assertSupportedSchema(s.items, `${where}[]`);
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    if (s[key] !== undefined && typeof s[key] !== "number") throw new Error(`${where} has a ${key} that is not a number.`);
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

const TYPE_WORDS: Record<string, string> = {
  object: "a set of named values",
  array: "a list",
  string: "text",
  number: "a number",
  integer: "a whole number",
  boolean: "true or false",
  null: "empty",
};

function show(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

function listWords(values: unknown[]): string {
  return values.map(show).join(", ");
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

/** "points item 2 label" from "points item 2" and "label"; a top-level name stands alone. */
function childLabel(parent: string, name: string): string {
  return parent ? `${parent} ${name}` : name;
}

/**
 * Check a value against a schema. Returns null when it fits, else one plain
 * sentence about the first problem. `label` names the value in that sentence
 * ("scale", "points item 2", ...; empty for the top level). `unknownKey`
 * words the sentence for a name the schema does not allow (the caller knows
 * the tool's name).
 */
export function checkJsonSchema(
  schema: JsonSchema,
  value: unknown,
  label = "",
  unknownKey: (key: string, allowed: string[], where: string) => string = (key, allowed, where) =>
    `${where || "This"} does not take "${key}". It takes: ${allowed.join(", ") || "nothing"}.`,
): string | null {
  const subject = label || "The arguments";
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : typeof schema.type === "string" ? [schema.type] : [];
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    return `${subject} must be ${types.map((t) => TYPE_WORDS[t] ?? t).join(" or ")}, not ${TYPE_WORDS[typeOf(value)] ?? typeOf(value)}.`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return `${subject} must be a number.`;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    return `${subject} must be one of ${listWords(schema.enum)}, not ${show(value)}.`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${subject} must be at least ${schema.minimum}.`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${subject} must be at most ${schema.maximum}.`;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      return `${subject} must be more than ${schema.exclusiveMinimum}.`;
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      return `${subject} must be less than ${schema.exclusiveMaximum}.`;
    }
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      return schema.minLength === 1 ? `${subject} must not be empty.` : `${subject} must be at least ${schema.minLength} characters long.`;
    }
    if (typeof schema.maxLength === "number" && length > schema.maxLength) return `${subject} must be at most ${schema.maxLength} characters long.`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${subject} must have at least ${schema.minItems} items.`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${subject} can have at most ${schema.maxItems} items.`;
    const items = asSchema(schema.items);
    if (items) {
      for (const [index, item] of value.entries()) {
        const problem = checkJsonSchema(items, item, childLabel(label, `item ${index + 1}`), unknownKey);
        if (problem) return problem;
      }
    }
  }
  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    const properties = asSchema(schema.properties) ?? {};
    const allowed = Object.keys(properties);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) return unknownKey(key, allowed, label);
      }
    }
    for (const name of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (record[name] === undefined) return `${childLabel(label, name)} is required.`;
    }
    for (const [name, child] of Object.entries(properties)) {
      if (record[name] === undefined) continue;
      const childSchema = asSchema(child);
      if (!childSchema) continue;
      const problem = checkJsonSchema(childSchema, record[name], childLabel(label, name), unknownKey);
      if (problem) return problem;
    }
  }
  return null;
}
