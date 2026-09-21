import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createShopifyClient,
  createShopifyRawTransport,
  getClientCredentialsAccessToken,
  resetShopifyTokenCache,
  ShopifyClientError,
} from "../services/data-sources/shopify-client.js";
import {
  EARLIEST_ORDER_QUERY,
  evaluateShopifyScopes,
  PRODUCT_TYPES_PAGE_QUERY,
  runShopifyConnectionCheck,
  SHOP_AND_SCOPES_QUERY,
} from "../services/data-sources/shopify-connection-check.js";
import { assertValidShopifyQuery, defaultFixture, startFakeShopify, type FakeShopify } from "./helpers/fake-shopify-guarded.js";

/**
 * DUR-3972 S1: the query-only Shopify client and the Test check, against a
 * fake Shopify that validates and executes every query with graphql-js
 * against the committed Shopify Admin 2026-07 schema.
 */

const TOKEN = "shp" + "at_0123456789abcdef0123456789abcdef";
const SHOP = "nordstrand-test.myshopify.com";

describe("DUR-3972 Shopify client", () => {
  let fake: FakeShopify;
  let clock = 1_000_000;
  const sleeps: number[] = [];

  beforeEach(async () => {
    fake = await startFakeShopify({ acceptedTokens: [TOKEN] });
    clock = 1_000_000;
    sleeps.length = 0;
    resetShopifyTokenCache();
  });

  afterEach(async () => {
    await fake.close();
  });

  function client(overrides: Partial<Parameters<typeof createShopifyClient>[0]> = {}) {
    return createShopifyClient({
      shopDomain: SHOP,
      apiVersion: "2026-07",
      getAccessToken: async () => TOKEN,
      fetchImpl: fake.guardedFetch(),
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      ...overrides,
    });
  }

  it("every query the Test check sends is valid Shopify Admin 2026-07 GraphQL", () => {
    for (const query of [SHOP_AND_SCOPES_QUERY, EARLIEST_ORDER_QUERY, PRODUCT_TYPES_PAGE_QUERY]) {
      expect(() => assertValidShopifyQuery(query)).not.toThrow();
    }
    // And the checker itself is not a rubber stamp.
    expect(() => assertValidShopifyQuery("query { shop { notAField } }")).toThrow(/notAField/);
  });

  it("sends the key only in the X-Shopify-Access-Token header, never in the URL or body", async () => {
    const data = await client().query<{ shop: { name: string } }>(SHOP_AND_SCOPES_QUERY);
    expect(data.shop.name).toBe("Nordstrand Møbler");
    expect(fake.schemaErrors).toEqual([]);
    const [request] = fake.requests;
    expect(request!.path).toBe("/admin/api/2026-07/graphql.json");
    expect(request!.path).not.toContain(TOKEN);
    expect(request!.body).not.toContain(TOKEN);
    expect(request!.headers["x-shopify-access-token"]).toBe(TOKEN);
  });

  it("refuses any document containing a mutation or subscription, before sending anything", async () => {
    for (const document of [
      "mutation { productDelete(input: {id: \"gid://shopify/Product/1\"}) { deletedProductId } }",
      "query Q { shop { name } }\nmutation M { x }",
      "subscription { x }",
    ]) {
      await expect(client().query(document)).rejects.toMatchObject({ code: "mutation_refused" });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("retries a THROTTLED answer at most twice, pacing on Shopify's throttle status", async () => {
    fake.throttleNext(2);
    const data = await client().query<{ shop: { name: string } }>(SHOP_AND_SCOPES_QUERY);
    expect(data.shop.name).toBe("Nordstrand Møbler");
    expect(fake.requests).toHaveLength(3);
    // requested cost 12 with 2 available at 100/s restore -> wait 100 ms each time.
    expect(sleeps).toEqual([100, 100]);

    fake.requests.length = 0;
    fake.throttleNext(3);
    await expect(client().query(SHOP_AND_SCOPES_QUERY)).rejects.toMatchObject({ code: "throttled" });
    expect(fake.requests).toHaveLength(3);
  });

  it("stops at the request budget instead of returning a partial result", async () => {
    const c = client({ budget: { maxRequests: 2, deadlineMs: 25_000 } });
    await c.query(SHOP_AND_SCOPES_QUERY);
    await c.query(SHOP_AND_SCOPES_QUERY);
    await expect(c.query(SHOP_AND_SCOPES_QUERY)).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(c.stats().requests).toBe(2);
  });

  it("stops at the deadline", async () => {
    const c = client({ budget: { maxRequests: 60, deadlineMs: 1_000 } });
    await c.query(SHOP_AND_SCOPES_QUERY);
    clock += 1_001;
    await expect(c.query(SHOP_AND_SCOPES_QUERY)).rejects.toMatchObject({ code: "deadline_exceeded" });
  });

  it("scrubs the key out of an error Shopify echoes back", async () => {
    fake.echoTokenInErrorNext(1);
    const error = await client().query(SHOP_AND_SCOPES_QUERY).catch((err: unknown) => err as ShopifyClientError);
    expect(error).toBeInstanceOf(ShopifyClientError);
    expect(error.code).toBe("graphql_error");
    expect(error.message).toContain("ACCESS_DENIED");
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain("0123456789abcdef");
  });

  it("the raw transport (the S3 engine's seam) sends exactly one request, returns THROTTLED bodies as-is, and never retries", async () => {
    const transport = createShopifyRawTransport({
      shopDomain: SHOP,
      apiVersion: "2026-07",
      getAccessToken: async () => TOKEN,
      fetchImpl: fake.guardedFetch(),
    });
    expect(transport.shopDomain).toBe(SHOP);
    fake.throttleNext(1);
    const throttled = await transport.request(SHOP_AND_SCOPES_QUERY, {});
    expect(throttled.errors?.[0]?.extensions?.code).toBe("THROTTLED");
    expect(fake.requests).toHaveLength(1);
    const ok = await transport.request(SHOP_AND_SCOPES_QUERY, {});
    expect((ok.data as { shop: { name: string } }).shop.name).toBe("Nordstrand Møbler");
    expect(ok.extensions?.cost?.throttleStatus?.restoreRate).toBe(100);
    fake.echoTokenInErrorNext(1);
    const echoed = await transport.request(SHOP_AND_SCOPES_QUERY, {});
    expect(JSON.stringify(echoed)).not.toContain(TOKEN);
    await expect(transport.request("mutation { x }", {})).rejects.toMatchObject({ code: "mutation_refused" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(transport.request(SHOP_AND_SCOPES_QUERY, {}, { signal: aborted.signal })).rejects.toMatchObject({
      code: "network",
    });
    expect(fake.requests).toHaveLength(3);
  });

  it("reports a wrong key as a plain sentence", async () => {
    await expect(
      client({ getAccessToken: async () => "shp" + "at_wrongwrongwrongwrongwrongwrong" }).query(SHOP_AND_SCOPES_QUERY),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("DUR-3972 Shopify Test check", () => {
  it("reads shop, scopes, earliest order and product-type coverage from schema-valid answers", async () => {
    const fake = await startFakeShopify({ acceptedTokens: [TOKEN] });
    try {
      const c = createShopifyClient({
        shopDomain: SHOP,
        apiVersion: "2026-07",
        getAccessToken: async () => TOKEN,
        fetchImpl: fake.guardedFetch(),
      });
      const outcome = await runShopifyConnectionCheck(c, { now: () => new Date("2026-09-21T10:00:00Z") });
      expect(fake.schemaErrors).toEqual([]);
      expect(outcome.ok).toBe(true);
      expect(outcome.canActivate).toBe(true);
      expect(outcome.problems).toEqual([]);
      expect(outcome.observed).toMatchObject({
        shopName: "Nordstrand Møbler",
        ianaTimezone: "Europe/Oslo",
        currencyCode: "NOK",
        grantedScopes: ["read_all_orders", "read_orders", "read_products"],
        earliestVisibleOrderAt: "2024-03-02T09:15:00Z",
        productTypeCoverage: {
          complete: true,
          productsScanned: 4,
          productsWithoutType: 1,
          types: [
            { productType: "Sofa", products: 2 },
            { productType: "Hjørnesofa", products: 1 },
          ],
        },
      });
    } finally {
      await fake.close();
    }
  });

  it("pages through more than 250 products", async () => {
    const products = Array.from({ length: 600 }, (_, i) => ({ productType: i % 3 === 0 ? "Sofa" : "Bord" }));
    const fake = await startFakeShopify({ acceptedTokens: [TOKEN], fixture: defaultFixture({ products }) });
    try {
      const c = createShopifyClient({
        shopDomain: SHOP,
        apiVersion: "2026-07",
        getAccessToken: async () => TOKEN,
        fetchImpl: fake.guardedFetch(),
      });
      const outcome = await runShopifyConnectionCheck(c);
      expect(fake.schemaErrors).toEqual([]);
      expect(outcome.observed?.productTypeCoverage).toMatchObject({ complete: true, productsScanned: 600 });
      // shop+scopes, earliest order, then 3 product pages
      expect(fake.requests).toHaveLength(5);
    } finally {
      await fake.close();
    }
  });

  it("blocks activation for any write_* scope, and for a missing read_all_orders", () => {
    expect(evaluateShopifyScopes(["read_orders", "read_all_orders", "read_products"]).canActivate).toBe(true);
    const withWrite = evaluateShopifyScopes(["read_orders", "read_all_orders", "read_products", "write_products"]);
    expect(withWrite.canActivate).toBe(false);
    expect(withWrite.writeScopes).toEqual(["write_products"]);
    expect(withWrite.problems.join(" ")).toContain("write_products");
    const noAll = evaluateShopifyScopes(["read_orders", "read_products"]);
    expect(noAll.canActivate).toBe(false);
    expect(noAll.missingScopes).toEqual(["read_all_orders"]);
    expect(noAll.problems.join(" ")).toContain("60 dagene");
  });
});

describe("DUR-3972 client-credentials tokens", () => {
  it("exchanges once, reuses the token, and refreshes BEFORE it expires", async () => {
    resetShopifyTokenCache();
    const fake = await startFakeShopify({
      clientCredentials: { clientId: "client-id-123456", clientSecret: "shp" + "ss_clientsecret0123456789ab", expiresInSeconds: 600 },
    });
    try {
      let clock = 5_000_000;
      const get = () =>
        getClientCredentialsAccessToken({
          connectionId: "conn-1",
          shopDomain: SHOP,
          clientId: "client-id-123456",
          clientSecret: "shp" + "ss_clientsecret0123456789ab",
          fetchImpl: fake.guardedFetch(),
          now: () => clock,
        });
      const first = await get();
      clock += 200_000;
      expect(await get()).toBe(first);
      expect(fake.issuedTokens).toHaveLength(1);
      // 310 s into a 600 s token: past the refresh point (half the lifetime,
      // at most 5 minutes before expiry) but still valid -- a new one is fetched.
      clock += 110_000;
      const second = await get();
      expect(second).not.toBe(first);
      expect(fake.issuedTokens).toEqual([first, second]);
      const exchange = fake.requests.find((r) => r.path === "/admin/oauth/access_token");
      expect(exchange!.body).toContain("client_credentials");
    } finally {
      await fake.close();
    }
  });

  it("reports a refused client secret without echoing it", async () => {
    resetShopifyTokenCache();
    const fake = await startFakeShopify({
      clientCredentials: { clientId: "client-id-123456", clientSecret: "shp" + "ss_rightsecret0123456789abcd", expiresInSeconds: 600 },
    });
    try {
      const error = await getClientCredentialsAccessToken({
        connectionId: "conn-2",
        shopDomain: SHOP,
        clientId: "client-id-123456",
        clientSecret: "shp" + "ss_wrongsecret0123456789abcd",
        fetchImpl: fake.guardedFetch(),
      }).catch((err: unknown) => err as ShopifyClientError);
      expect(error.code).toBe("unauthorized");
      expect(error.message).not.toContain("shp" + "ss_");
    } finally {
      await fake.close();
    }
  });
});
