import { describe, expect, it } from "vitest";
import {
  API_TOOL_MAX_ACTIONS,
  agentApiToolSelectionSchema,
  apiToolActionInputJsonSchema,
  apiToolActionSchema,
  apiToolAuthSchema,
  apiToolBodySchema,
  normalizeApiToolBaseUrl,
  runApiToolActionSchema,
} from "./api-tool.js";

/**
 * DUR-4004: the shapes the Tools form sends for an "API with a key" tool.
 * The key itself is never part of any of them -- only the secret's id.
 */

const SECRET = "11111111-1111-4111-8111-111111111111";

describe("normalizeApiToolBaseUrl", () => {
  it("keeps an https address with a path prefix, without the trailing slash", () => {
    expect(normalizeApiToolBaseUrl(" https://Api.Fiken.no/api/v2/ ")).toEqual({ ok: true, url: "https://api.fiken.no/api/v2", host: "api.fiken.no" });
    expect(normalizeApiToolBaseUrl("https://fal.run")).toEqual({ ok: true, url: "https://fal.run", host: "fal.run" });
  });

  it("refuses plain http, credentials, a query string, another port, an IP and an internal name, each with a plain sentence", () => {
    const cases: Array<[string, string]> = [
      ["http://fal.run", "must start with https://"],
      ["https://user:pw@fal.run", "cannot contain a username or password"],
      ["https://fal.run/?key=abc", "cannot contain a query string"],
      ["https://fal.run:8443", "default https port"],
      ["https://10.0.0.5/api", "public host name"],
      ["https://box.internal/api", "public host name"],
      ["https://localhost/api", "public host name"],
      ["not a url", "not a valid web address"],
      ["", "Enter the base address"],
    ];
    for (const [input, fragment] of cases) {
      const result = normalizeApiToolBaseUrl(input);
      expect(result.ok, input).toBe(false);
      if (!result.ok) expect(result.message, input).toContain(fragment);
    }
  });
});

describe("apiToolAuthSchema", () => {
  it("accepts bearer, a named header with a prefix (Fal.ai), and a named query parameter", () => {
    expect(apiToolAuthSchema.parse({ kind: "bearer", secretId: SECRET })).toEqual({ kind: "bearer", secretId: SECRET });
    expect(apiToolAuthSchema.parse({ kind: "header", name: "Authorization", prefix: "Key ", secretId: SECRET })).toMatchObject({ prefix: "Key " });
    expect(apiToolAuthSchema.parse({ kind: "query", name: "api_key", secretId: SECRET })).toMatchObject({ kind: "query" });
  });

  it("refuses a header or query kind without a name, a prefix on bearer/query, and a bad secret id", () => {
    expect(apiToolAuthSchema.safeParse({ kind: "header", secretId: SECRET }).success).toBe(false);
    expect(apiToolAuthSchema.safeParse({ kind: "query", secretId: SECRET }).success).toBe(false);
    expect(apiToolAuthSchema.safeParse({ kind: "bearer", prefix: "Key ", secretId: SECRET }).success).toBe(false);
    expect(apiToolAuthSchema.safeParse({ kind: "query", name: "k", prefix: "Key ", secretId: SECRET }).success).toBe(false);
    expect(apiToolAuthSchema.safeParse({ kind: "header", name: "bad header", secretId: SECRET }).success).toBe(false);
    expect(apiToolAuthSchema.safeParse({ kind: "bearer", secretId: "not-a-uuid" }).success).toBe(false);
    // The value never travels here: an unknown field is refused outright.
    expect(apiToolAuthSchema.safeParse({ kind: "bearer", secretId: SECRET, value: "sk-abc" }).success).toBe(false);
  });
});

describe("apiToolActionSchema", () => {
  it("accepts an action whose path placeholders are all declared inputs", () => {
    const action = apiToolActionSchema.parse({
      name: "get_invoice",
      method: "GET",
      path: "/companies/{slug}/invoices/{id}",
      description: "Fetch one invoice",
      inputs: [
        { name: "slug", type: "string", required: true },
        { name: "id", type: "integer", required: true },
      ],
    });
    expect(action.inputs).toHaveLength(2);
    expect(apiToolActionInputJsonSchema(action)).toEqual({
      type: "object",
      properties: { slug: { type: "string" }, id: { type: "integer" } },
      required: ["slug", "id"],
      additionalProperties: false,
    });
  });

  it("refuses an undeclared placeholder, a duplicate input, a bad name, and a path without a leading slash", () => {
    const base = { name: "run", method: "POST", path: "/run", description: "", inputs: [] };
    expect(apiToolActionSchema.safeParse({ ...base, path: "/run/{id}" }).success).toBe(false);
    expect(apiToolActionSchema.safeParse({ ...base, inputs: [{ name: "a" }, { name: "a" }] }).success).toBe(false);
    expect(apiToolActionSchema.safeParse({ ...base, name: "Run Image" }).success).toBe(false);
    expect(apiToolActionSchema.safeParse({ ...base, path: "run" }).success).toBe(false);
    expect(apiToolActionSchema.safeParse({ ...base, path: "/run?x=1" }).success).toBe(false);
    expect(apiToolActionSchema.safeParse({ ...base, method: "HEAD" }).success).toBe(false);
    // A "." or ".." part would climb out of the base address.
    const dotted = apiToolActionSchema.safeParse({ ...base, path: "/v1/../admin" });
    expect(dotted.success).toBe(false);
    if (!dotted.success) expect(dotted.error.issues[0]!.message).toBe('The path cannot contain a "." or ".." part.');
    expect(apiToolActionSchema.safeParse({ ...base, path: "/./run" }).success).toBe(false);
    expect(apiToolActionSchema.safeParse({ ...base, path: "/v1.2/run..all" }).success).toBe(true);
  });
});

describe("apiToolBodySchema", () => {
  const body = {
    name: "Fal.ai",
    description: "Makes images",
    baseUrl: "https://fal.run/",
    auth: { kind: "header", name: "Authorization", prefix: "Key ", secretId: SECRET },
    actions: [{ name: "flux", method: "POST", path: "/fal-ai/flux/dev", description: "Make an image", inputs: [{ name: "prompt", type: "string", required: true }] }],
  };

  it("fills the defaults: 300 calls a day, active, no OpenAPI address", () => {
    const parsed = apiToolBodySchema.parse(body);
    expect(parsed.dailyCap).toBe(300);
    expect(parsed.status).toBe("active");
    expect(parsed.openapiUrl).toBeUndefined();
  });

  it("refuses two actions with the same name, more than the action cap, a plain-http base and an unknown field", () => {
    expect(apiToolBodySchema.safeParse({ ...body, actions: [body.actions[0], body.actions[0]] }).success).toBe(false);
    const many = Array.from({ length: API_TOOL_MAX_ACTIONS + 1 }, (_, i) => ({ ...body.actions[0], name: `a${i}` }));
    expect(apiToolBodySchema.safeParse({ ...body, actions: many }).success).toBe(false);
    expect(apiToolBodySchema.safeParse({ ...body, baseUrl: "http://fal.run" }).success).toBe(false);
    expect(apiToolBodySchema.safeParse({ ...body, apiKey: "sk-abc" }).success).toBe(false);
    expect(apiToolBodySchema.safeParse({ ...body, dailyCap: 0 }).success).toBe(false);
  });
});

describe("selection and run bodies", () => {
  it("take a list of tool ids and a free-form input object", () => {
    expect(agentApiToolSelectionSchema.parse({ desiredToolIds: [SECRET] }).desiredToolIds).toEqual([SECRET]);
    expect(agentApiToolSelectionSchema.safeParse({ desiredToolIds: ["x"] }).success).toBe(false);
    expect(runApiToolActionSchema.parse({}).input).toEqual({});
    expect(runApiToolActionSchema.parse({ input: { prompt: "a cat" } }).input).toEqual({ prompt: "a cat" });
    expect(runApiToolActionSchema.safeParse({ input: "prompt" }).success).toBe(false);
  });
});
