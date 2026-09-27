import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_TOOL_MAX_ACTIONS } from "@paperclipai/shared/validators/api-tool";
import { HttpError } from "../errors.js";
import { importOpenApiActions, openApiToActions } from "../services/api-tools-openapi.js";

/**
 * DUR-4004: "Import from OpenAPI address". A small fixture spec becomes the
 * simple action list the Tools form edits (name from operationId or
 * method+path, description from summary, inputs from parameters and the JSON
 * request body, bounded to API_TOOL_MAX_ACTIONS), and the fetch goes through
 * the outbound guard: JSON only, no redirects, public https only.
 */

const FIXTURE = {
  openapi: "3.0.3",
  info: { title: "Fiken API", version: "2" },
  servers: [{ url: "https://api.fiken.no/api/v2" }],
  components: {
    parameters: {
      companySlug: { name: "companySlug", in: "path", required: true, schema: { type: "string" }, description: "The company's slug" },
    },
    schemas: {
      NewInvoice: {
        type: "object",
        required: ["customerId", "issueDate"],
        properties: {
          customerId: { type: "integer", description: "Customer id" },
          issueDate: { type: "string" },
          lines: { type: "array", items: { type: "object" } },
          draft: { type: "boolean" },
        },
      },
    },
  },
  paths: {
    "/companies/{companySlug}/invoices": {
      parameters: [{ $ref: "#/components/parameters/companySlug" }],
      get: {
        operationId: "getInvoices",
        summary: "List invoices",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer" } },
          { name: "X-Trace", in: "header", schema: { type: "string" } },
          { name: "issueDateGe", in: "query", required: false, schema: { type: "string", format: "date" }, description: "From date" },
        ],
      },
      post: {
        summary: "Create an invoice",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewInvoice" } } } },
      },
    },
    "/companies/{companySlug}/invoices/{invoiceId}": {
      get: { operationId: "get-Invoice", description: "One invoice.", parameters: [{ name: "invoiceId", in: "path", required: true, schema: { type: "integer" } }] },
      delete: { operationId: "deleteInvoice" },
    },
    "/whoAmI": {
      get: { summary: "Who am I" },
      put: { summary: "Replace me", requestBody: { content: { "application/json": { schema: { type: "array", items: { type: "string" } } } } } },
    },
  },
};

describe("openApiToActions (fixture)", () => {
  const result = openApiToActions(FIXTURE as unknown as Record<string, unknown>);

  it("reads the title and the first https server as the base address", () => {
    expect(result.title).toBe("Fiken API");
    expect(result.baseUrl).toBe("https://api.fiken.no/api/v2");
    expect(result.skipped).toBe(0);
  });

  it("names actions from operationId, else method + path, and describes them from summary or description", () => {
    expect(result.actions.map((action) => [action.name, action.method, action.path])).toEqual([
      ["get_invoices", "GET", "/companies/{companySlug}/invoices"],
      ["post_companies_by_company_slug_invoices", "POST", "/companies/{companySlug}/invoices"],
      ["get_invoice", "GET", "/companies/{companySlug}/invoices/{invoiceId}"],
      ["delete_invoice", "DELETE", "/companies/{companySlug}/invoices/{invoiceId}"],
      ["get_who_am_i", "GET", "/whoAmI"],
      ["put_who_am_i", "PUT", "/whoAmI"],
    ]);
    expect(result.actions[0]!.description).toBe("List invoices");
    expect(result.actions[2]!.description).toBe("One invoice.");
  });

  it("turns path and query parameters into inputs (path ones required, header ones dropped), resolving $ref", () => {
    const list = result.actions[0]!;
    expect(list.inputs).toEqual([
      { name: "companySlug", type: "string", required: true, description: "The company's slug" },
      { name: "page", type: "integer", required: false },
      { name: "issueDateGe", type: "string", required: false, description: "From date" },
    ]);
    // Declared parameters first, then any placeholder nothing declared
    // (this path has no path-level parameters, so companySlug comes last).
    const one = result.actions[2]!;
    expect(one.inputs.map((input) => [input.name, input.type, input.required])).toEqual([
      ["invoiceId", "integer", true],
      ["companySlug", "string", true],
    ]);
  });

  it("flattens a JSON request body's top-level properties into inputs; a non-object body becomes one json input called body", () => {
    const create = result.actions[1]!;
    expect(create.inputs.map((input) => [input.name, input.type, input.required])).toEqual([
      ["companySlug", "string", true],
      ["customerId", "integer", true],
      ["issueDate", "string", true],
      ["lines", "json", false],
      ["draft", "boolean", false],
    ]);
    expect(create.inputs[1]!.description).toBe("Customer id");
    const replace = result.actions[5]!;
    expect(replace.inputs).toEqual([{ name: "body", type: "json", required: false, description: "The request body as JSON." }]);
  });

  it("still declares an input for a path placeholder no parameter mentions", () => {
    const remove = result.actions[3]!;
    expect(remove.inputs.map((input) => input.name)).toEqual(["companySlug", "invoiceId"]);
  });

  it("stops at the action cap and counts the rest as skipped; refuses a document without paths", () => {
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < API_TOOL_MAX_ACTIONS + 5; index += 1) {
      paths[`/thing${index}`] = { get: { operationId: `thing${index}` } };
    }
    const many = openApiToActions({ openapi: "3.0.0", paths });
    expect(many.actions).toHaveLength(API_TOOL_MAX_ACTIONS);
    expect(many.skipped).toBe(5);
    expect(() => openApiToActions({ openapi: "3.0.0" })).toThrow(/has no "paths" section/);
  });
});

describe("importOpenApiActions (through the guard)", () => {
  let server: http.Server;
  let port = 0;
  const hits: string[] = [];
  const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/openapi.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(FIXTURE));
        return;
      }
      if (req.url === "/openapi.yaml") {
        res.writeHead(200, { "content-type": "application/yaml" });
        res.end("openapi: 3.0.0\npaths: {}\n");
        return;
      }
      if (req.url === "/moved") {
        res.writeHead(302, { location: "https://evil.example.com/openapi.json" });
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const deps = (lookup = PUBLIC) => ({ lookup, testOnlyDial: { host: "127.0.0.1", port } });

  async function refusal(promise: Promise<unknown>): Promise<HttpError> {
    const error = await promise.then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }

  it("fetches a JSON document and converts it", async () => {
    const result = await importOpenApiActions("https://api.fiken.no/openapi.json", deps());
    expect(result.title).toBe("Fiken API");
    expect(result.actions).toHaveLength(6);
    expect(hits).toContain("/openapi.json");
  });

  it("says plainly that YAML is not supported, that a 404 came back, and refuses a redirect, plain http and a private address", async () => {
    expect((await refusal(importOpenApiActions("https://api.fiken.no/openapi.yaml", deps()))).message).toContain("must be JSON");
    expect((await refusal(importOpenApiActions("https://api.fiken.no/missing.json", deps()))).message).toBe("api.fiken.no answered 404 for the OpenAPI address.");
    expect((await refusal(importOpenApiActions("https://api.fiken.no/moved", deps()))).message).toContain("tried to redirect");
    expect(hits.filter((hit) => hit.includes("evil"))).toHaveLength(0);
    expect((await refusal(importOpenApiActions("http://api.fiken.no/openapi.json", deps()))).message).toContain("must start with https://");
    const before = hits.length;
    expect((await refusal(importOpenApiActions("https://api.fiken.no/openapi.json", deps(async () => [{ address: "10.0.0.9", family: 4 }])))).message).toContain("internal address");
    expect(hits.length).toBe(before);
  });
});
