import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { buildSchema, execute, parse, validate, type GraphQLSchema } from "graphql";
import {
  createSafeOutboundFetch,
  SHOPIFY_OUTBOUND_POLICY,
  type OutboundFetch,
} from "../../services/safe-outbound-fetch.js";

/**
 * DUR-3972: a fake Shopify that answers in Shopify's real response shape.
 *
 * It does not hand-write JSON responses. Every GraphQL request is parsed,
 * VALIDATED against the committed Shopify Admin schema for the pinned API
 * version (services/data-sources/shopify-schema/admin-2026-07.graphql), and
 * EXECUTED against that schema with the fixture as root value by graphql-js.
 * So a query Shopify would reject is rejected here, and a fixture that does
 * not fit Shopify's types produces an error instead of a plausible answer.
 *
 * It listens on 127.0.0.1. The code under test still goes through the real
 * outbound guard (host allow-list, https-only, DNS check with an injected
 * public answer, no redirects); only the final socket is pointed here, via
 * the guard's test-only dial override.
 */

const SCHEMA_PATH = fileURLToPath(
  new URL("../../services/data-sources/shopify-schema/admin-2026-07.graphql", import.meta.url),
);

let cachedSchema: GraphQLSchema | null = null;
export function loadShopifyAdminSchema(): GraphQLSchema {
  cachedSchema ??= buildSchema(readFileSync(SCHEMA_PATH, "utf8"));
  return cachedSchema;
}

/** Throws with Shopify-schema validation messages if `document` is not valid 2026-07 Admin GraphQL. */
export function assertValidShopifyQuery(document: string) {
  const errors = validate(loadShopifyAdminSchema(), parse(document));
  if (errors.length > 0) {
    throw new Error(`Not valid against Shopify Admin 2026-07: ${errors.map((e) => e.message).join("; ")}`);
  }
}

export interface FakeShopifyFixture {
  shop: { name: string; myshopifyDomain: string; ianaTimezone: string; currencyCode: string };
  scopes: string[];
  /** Oldest first is not required; the fake sorts by createdAt. */
  orders: Array<{ createdAt: string }>;
  products: Array<{ productType: string }>;
}

export interface FakeShopifyRequest {
  path: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeShopify {
  port: number;
  requests: FakeShopifyRequest[];
  /** Every access token this fake has issued through the client-credentials grant. */
  issuedTokens: string[];
  /** GraphQL validation/execution errors seen (should stay empty). */
  schemaErrors: string[];
  fixture: FakeShopifyFixture;
  /** Next GraphQL answers become THROTTLED errors, this many times. */
  throttleNext(times: number): void;
  /** Next GraphQL answers carry an error whose message echoes the token sent. */
  echoTokenInErrorNext(times: number): void;
  close(): Promise<void>;
  /** A fetch that goes through the real guard and ends at this fake. */
  guardedFetch(): OutboundFetch;
}

export function defaultFixture(overrides: Partial<FakeShopifyFixture> = {}): FakeShopifyFixture {
  return {
    shop: {
      name: "Nordstrand Møbler",
      myshopifyDomain: "nordstrand-test.myshopify.com",
      ianaTimezone: "Europe/Oslo",
      currencyCode: "NOK",
    },
    scopes: ["read_orders", "read_all_orders", "read_products"],
    orders: [{ createdAt: "2024-03-02T09:15:00Z" }, { createdAt: "2026-08-01T10:00:00Z" }],
    products: [
      { productType: "Sofa" },
      { productType: "Sofa" },
      { productType: "Hjørnesofa" },
      { productType: "" },
    ],
    ...overrides,
  };
}

function connection<T>(items: T[], args: { first?: number | null; after?: string | null }) {
  const start = args.after ? Number.parseInt(Buffer.from(args.after, "base64").toString("utf8"), 10) + 1 : 0;
  const first = args.first ?? 50;
  const slice = items.slice(start, start + first);
  const cursorOf = (index: number) => Buffer.from(String(index)).toString("base64");
  return {
    nodes: slice,
    edges: slice.map((node, i) => ({ node, cursor: cursorOf(start + i) })),
    pageInfo: {
      hasNextPage: start + first < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length ? cursorOf(start) : null,
      endCursor: slice.length ? cursorOf(start + slice.length - 1) : null,
    },
  };
}

export async function startFakeShopify(options: {
  fixture?: FakeShopifyFixture;
  /** Tokens accepted as-is (admin access token mode). */
  acceptedTokens?: string[];
  /** Client-credentials pair this fake accepts, and the lifetime it grants. */
  clientCredentials?: { clientId: string; clientSecret: string; expiresInSeconds: number };
}): Promise<FakeShopify> {
  const schema = loadShopifyAdminSchema();
  const fixture = options.fixture ?? defaultFixture();
  const accepted = new Set(options.acceptedTokens ?? []);
  const requests: FakeShopifyRequest[] = [];
  const issuedTokens: string[] = [];
  const schemaErrors: string[] = [];
  let throttleRemaining = 0;
  let echoRemaining = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ path: req.url ?? "", method: req.method ?? "", headers: req.headers, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (req.method === "POST" && req.url === "/admin/oauth/access_token") {
        const parsed = JSON.parse(body || "{}") as Record<string, string>;
        const cc = options.clientCredentials;
        if (
          !cc ||
          parsed.grant_type !== "client_credentials" ||
          parsed.client_id !== cc.clientId ||
          parsed.client_secret !== cc.clientSecret
        ) {
          send(401, { error: "invalid_client" });
          return;
        }
        const token = `shpat_cc${randomBytes(16).toString("hex")}`;
        issuedTokens.push(token);
        accepted.add(token);
        send(200, { access_token: token, scope: fixture.scopes.join(","), expires_in: cc.expiresInSeconds });
        return;
      }

      if (req.method === "POST" && req.url === "/admin/api/2026-07/graphql.json") {
        const token = req.headers["x-shopify-access-token"];
        if (typeof token !== "string" || !accepted.has(token)) {
          send(401, { errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" });
          return;
        }
        const cost = {
          requestedQueryCost: 12,
          actualQueryCost: 6,
          throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1988, restoreRate: 100 },
        };
        if (throttleRemaining > 0) {
          throttleRemaining -= 1;
          send(200, {
            errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
            extensions: { cost: { ...cost, throttleStatus: { ...cost.throttleStatus, currentlyAvailable: 2 } } },
          });
          return;
        }
        if (echoRemaining > 0) {
          echoRemaining -= 1;
          send(200, {
            errors: [{ message: `Access denied for token ${token}`, extensions: { code: "ACCESS_DENIED" } }],
            extensions: { cost },
          });
          return;
        }
        const { query, variables } = JSON.parse(body) as { query: string; variables?: Record<string, unknown> };
        let document;
        try {
          document = parse(query);
        } catch (error) {
          schemaErrors.push(String(error));
          send(200, { errors: [{ message: String(error) }] });
          return;
        }
        const validationErrors = validate(schema, document);
        if (validationErrors.length > 0) {
          schemaErrors.push(...validationErrors.map((e) => e.message));
          send(200, { errors: validationErrors.map((e) => ({ message: e.message })) });
          return;
        }
        const sortedOrders = [...fixture.orders].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const rootValue = {
          shop: fixture.shop,
          currentAppInstallation: {
            accessScopes: fixture.scopes.map((handle) => ({ handle, description: handle })),
          },
          orders: (args: { first?: number; after?: string; reverse?: boolean }) =>
            connection(args.reverse ? [...sortedOrders].reverse() : sortedOrders, args),
          products: (args: { first?: number; after?: string }) => connection(fixture.products, args),
        };
        Promise.resolve(execute({ schema, document, rootValue, variableValues: variables }))
          .then((result) => {
            if (result.errors?.length) schemaErrors.push(...result.errors.map((e) => e.message));
            send(200, { ...result, extensions: { cost } });
          })
          .catch((error) => {
            schemaErrors.push(String(error));
            send(500, { errors: [{ message: "internal" }] });
          });
        return;
      }

      send(404, { errors: "Not Found" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    requests,
    issuedTokens,
    schemaErrors,
    fixture,
    throttleNext(times: number) {
      throttleRemaining = times;
    },
    echoTokenInErrorNext(times: number) {
      echoRemaining = times;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    guardedFetch: () =>
      createSafeOutboundFetch(SHOPIFY_OUTBOUND_POLICY, {
        // A real public Shopify edge address, so the guard's address rule is
        // exercised exactly as in production; the socket then goes to the fake.
        lookup: async () => [{ address: "23.227.38.65", family: 4 }],
        testOnlyDial: { host: "127.0.0.1", port },
      }),
  };
}
