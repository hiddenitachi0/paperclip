import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildSchema,
  execute,
  getNamedType,
  parse,
  validate,
  type GraphQLFieldResolver,
  type GraphQLSchema,
} from "graphql";

/**
 * DUR-3972 S3: every Shopify fixture must be in Shopify's REAL response format.
 *
 * The committed schema (server/src/services/data-sources/shopify-schema/
 * admin-2026-07.graphql) was fetched without credentials from Shopify's public
 * documentation endpoint. `assertResponseMatchesSchema` proves a fixture
 * response is exactly what Shopify could send for a document:
 *
 *  - the document itself validates against the schema;
 *  - the response is re-executed through graphql-js with the fixture as the
 *    data source, so every value is serialised by the schema's own types
 *    (Int must be a whole number, enums must be real enum values, non-null
 *    fields must be present, abstract types resolve by __typename);
 *  - the re-executed result must be DEEP-EQUAL to the fixture, which catches
 *    missing nullable fields, extra fields that were never selected, and
 *    strings where numbers belong;
 *  - DateTime values must be ISO-8601 instants.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const SHOPIFY_SCHEMA_PATH = path.resolve(
  here,
  "../../services/data-sources/shopify-schema/admin-2026-07.graphql",
);

let cachedSchema: GraphQLSchema | null = null;

export function shopifyAdminSchema(): GraphQLSchema {
  if (!cachedSchema) {
    cachedSchema = buildSchema(readFileSync(SHOPIFY_SCHEMA_PATH, "utf8"), { assumeValidSDL: true });
  }
  return cachedSchema;
}

export function validateShopifyDocument(document: string): string[] {
  return validate(shopifyAdminSchema(), parse(document)).map((error) => error.message);
}

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function responseSchemaProblems(
  document: string,
  variables: Record<string, unknown>,
  data: unknown,
): string[] {
  const problems: string[] = [];
  const documentProblems = validateShopifyDocument(document);
  if (documentProblems.length > 0) return documentProblems.map((message) => `document: ${message}`);
  const fieldResolver: GraphQLFieldResolver<unknown, unknown> = (source, _args, _context, info) => {
    const value = (source as Record<string, unknown> | null)?.[info.path.key as string];
    const named = getNamedType(info.returnType);
    if (named.name === "DateTime" && value !== null && value !== undefined) {
      if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) {
        problems.push(`${pathOf(info.path)}: DateTime value ${JSON.stringify(value)} is not an ISO instant`);
      }
    }
    return value;
  };
  const result = execute({
    schema: shopifyAdminSchema(),
    document: parse(document),
    rootValue: data,
    variableValues: variables,
    fieldResolver,
    typeResolver: (value) => (value as { __typename?: string } | null)?.__typename,
  });
  if (result instanceof Promise) throw new Error("unexpected async execution");
  for (const error of result.errors ?? []) problems.push(`${error.path?.join(".") ?? "?"}: ${error.message}`);
  if (!isDeepStrictEqual(normalize(result.data), normalize(data))) {
    problems.push(`response differs from what the schema would produce: ${firstDifference(result.data, data)}`);
  }
  return problems;
}

export function assertResponseMatchesSchema(
  document: string,
  variables: Record<string, unknown>,
  data: unknown,
): void {
  const problems = responseSchemaProblems(document, variables, data);
  if (problems.length > 0) {
    throw new Error(`Shopify fixture is not schema-valid:\n  ${problems.slice(0, 10).join("\n  ")}`);
  }
}

function pathOf(p: { prev: unknown; key: string | number } | undefined): string {
  const parts: Array<string | number> = [];
  let cursor = p as { prev: unknown; key: string | number } | undefined;
  while (cursor) {
    parts.unshift(cursor.key);
    cursor = cursor.prev as typeof cursor;
  }
  return parts.join(".");
}

function normalize(value: unknown): unknown {
  // graphql-js builds result objects with a null prototype.
  return JSON.parse(JSON.stringify(value ?? null));
}

function firstDifference(actual: unknown, expected: unknown, at = "data"): string {
  const a = normalize(actual);
  const e = normalize(expected);
  if (isDeepStrictEqual(a, e)) return "(none)";
  if (a && e && typeof a === "object" && typeof e === "object") {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(e as object)]);
    for (const key of keys) {
      const av = (a as Record<string, unknown>)[key];
      const ev = (e as Record<string, unknown>)[key];
      if (!isDeepStrictEqual(av, ev)) return firstDifference(av, ev, `${at}.${key}`);
    }
  }
  return `${at}: schema gives ${JSON.stringify(a)?.slice(0, 120)}, fixture has ${JSON.stringify(e)?.slice(0, 120)}`;
}
