import {
  DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND,
  DATA_CONNECTION_KIND_LABELS,
  SHOPIFY_API_VERSION,
  shopifyConnectionConfigSchema,
} from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";
import { SHOPIFY_OUTBOUND_POLICY } from "../safe-outbound-fetch.js";
import type { ShopifyReadContext } from "./connection-kind.js";
import type { DataSourceKindDefinition, OpenReadContextInput } from "./registry.js";
import { createShopifySalesAdapter, PRODUCT_TYPES_QUERY } from "./shopify-adapter.js";
import {
  createShopifyClient,
  createShopifyRawTransport,
  forgetShopifyTokensForConnection,
  getClientCredentialsAccessToken,
  type ShopifyGraphQLClient,
} from "./shopify-client.js";
import { evaluateShopifyScopes, runShopifyConnectionCheck } from "./shopify-connection-check.js";

/**
 * DUR-3997 slice 3: the Shopify entry of the source-kind registry. Behaviour
 * is exactly what data-connections.ts, business-data.ts and data-trial.ts
 * did inline before: the same transport, the same paced client, the same
 * Test, the same sales engine, the same product-type read.
 */

/**
 * A query-only Shopify client for one connection, carrying the key and the
 * budget. The key is resolved lazily, once per context, and for
 * client-credentials connections exchanged for a short-lived token that is
 * kept in memory only.
 */
function openShopifyContext(input: OpenReadContextInput): ShopifyReadContext {
  const { connection, deps } = input;
  if (connection.kind !== "shopify" || !connection.shopDomain || !connection.apiVersion) {
    throw unprocessable("This connection has no shop address and cannot be used.", { code: "data_connection_incomplete" });
  }
  const shopDomain = connection.shopDomain;
  const apiVersion = connection.apiVersion;
  const now = deps.now ?? Date.now;
  const transport = createShopifyRawTransport({
    shopDomain,
    apiVersion,
    fetchImpl: deps.fetchImpl,
    extraSecrets: input.knownSecrets,
    getAccessToken: async () => {
      const value = await input.loadCredential();
      if (value.kind === "admin_access_token") return value.accessToken;
      if (value.kind !== "client_credentials") {
        throw unprocessable("The stored key does not fit a Shopify connection. Paste it in again.", {
          code: "credential_kind_mismatch",
        });
      }
      const token = await getClientCredentialsAccessToken({
        connectionId: connection.id,
        shopDomain,
        clientId: value.clientId,
        clientSecret: value.clientSecret,
        fetchImpl: deps.fetchImpl,
        now,
      });
      input.registerSecret(token);
      return token;
    },
  });
  const client: ShopifyGraphQLClient = createShopifyClient({
    shopDomain,
    apiVersion,
    getAccessToken: async () => "",
    transport,
    budget: input.budget,
    now,
    sleep: deps.sleep,
  });
  return {
    kind: "shopify",
    connection,
    shopify: client,
    shopifyTransport: transport,
    now: () => new Date(now()),
    stats: () => {
      const stats = client.stats();
      return { requests: stats.requests, costPoints: stats.costPoints };
    },
  };
}

function assertShopify(context: { kind: string }): asserts context is ShopifyReadContext {
  if (context.kind !== "shopify") {
    throw unprocessable("The Shopify adapter was given a connection of another kind.", { code: "data_source_kind_mismatch" });
  }
}

/** The exact product types in the shop, for matching a person's words on the server. */
async function readProductTypes(client: ShopifyGraphQLClient): Promise<string[]> {
  const types = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 8; page += 1) {
    const data: { productTypes: { nodes: string[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null } =
      await client.query(PRODUCT_TYPES_QUERY, { first: 250, after });
    if (!data.productTypes) return [...types];
    for (const value of data.productTypes.nodes) {
      const type = typeof value === "string" ? value.trim() : "";
      if (type) types.add(type);
    }
    if (!data.productTypes.pageInfo.hasNextPage) return [...types];
    after = data.productTypes.pageInfo.endCursor;
  }
  // More product types than we read: a match against a partial list could be wrong.
  throw new Error("product type list longer than the read limit");
}

export const shopifyDataSource: DataSourceKindDefinition = {
  kind: "shopify",
  label: DATA_CONNECTION_KIND_LABELS.shopify,
  supported: true,
  credentialKinds: DATA_CONNECTION_CREDENTIAL_KINDS_BY_KIND.shopify,
  datasets: ["sales"],
  configSchema: shopifyConnectionConfigSchema,
  storedShape(input) {
    if (input.kind !== "shopify") throw unprocessable("Wrong kind of connection for Shopify.");
    return { shopDomain: input.shopDomain, apiVersion: SHOPIFY_API_VERSION, config: {} };
  },
  describeTarget(connection) {
    return connection.shopDomain ?? "";
  },
  outboundPolicy() {
    return SHOPIFY_OUTBOUND_POLICY;
  },
  canActivate(observed) {
    const scopes = evaluateShopifyScopes(observed?.grantedScopes ?? []);
    return { ok: scopes.canActivate, problems: scopes.problems };
  },
  openReadContext: openShopifyContext,
  async check(input) {
    const context = openShopifyContext(input);
    const outcome = await runShopifyConnectionCheck(context.shopify, {
      now: context.now,
      maxProductPages: input.deps.maxProductPages,
    });
    return { ...outcome, stats: context.stats() };
  },
  forgetCachedTokens: forgetShopifyTokensForConnection,
  adapters: {
    sales(context, options = {}) {
      assertShopify(context);
      return createShopifySalesAdapter({
        client: context.shopifyTransport,
        ...(options.limits?.maxDurationMs ? { limits: { maxDurationMs: options.limits.maxDurationMs } } : {}),
        clock: { now: context.now, ...(options.sleep ? { sleep: options.sleep } : {}) },
      });
    },
    async productTypes(context) {
      assertShopify(context);
      return readProductTypes(context.shopify);
    },
  },
};
