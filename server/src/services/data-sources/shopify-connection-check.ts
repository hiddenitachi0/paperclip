import type { DataConnectionObservedSummary } from "@paperclipai/shared";
import { UNTYPED_BUCKET_LABEL } from "./contract.js";
import { ShopifyClientError, type ShopifyGraphQLClient } from "./shopify-client.js";

/**
 * DUR-3972 S1: the "Test" button for a Shopify connection.
 *
 * Reads who the shop is, which permissions the key really has, how far back
 * it can see orders, and which product types exist -- and decides whether the
 * connection may be switched on. It may not when:
 *   - the key has ANY write_* permission (Paperclip must only be able to read),
 *   - read_all_orders is missing (without it Shopify shows only the last 60
 *     days, and "the month before last" is always further back than that),
 *   - read_orders or read_products is missing (nothing could be answered).
 *
 * Every query here is checked against the committed Shopify Admin schema in
 * the tests (shopify-schema/admin-2026-07.graphql).
 */

export const SHOPIFY_REQUIRED_SCOPES = ["read_orders", "read_all_orders", "read_products"] as const;

const SCOPE_EXPLANATIONS: Record<(typeof SHOPIFY_REQUIRED_SCOPES)[number], string> = {
  read_orders: "read orders",
  read_all_orders: "read all orders, not only the last 60 days",
  read_products: "read products",
};

/** Kept small on purpose: product types are the only product field read. */
export const SHOP_AND_SCOPES_QUERY = `query PaperclipConnectionCheck {
  shop { name myshopifyDomain ianaTimezone currencyCode }
  currentAppInstallation { accessScopes { handle } }
}`;

export const EARLIEST_ORDER_QUERY = `query PaperclipEarliestOrder {
  orders(first: 1, sortKey: CREATED_AT, reverse: false) { nodes { createdAt } }
}`;

export const PRODUCT_TYPES_PAGE_QUERY = `query PaperclipProductTypes($after: String) {
  products(first: 250, after: $after) {
    nodes { productType }
    pageInfo { hasNextPage endCursor }
  }
}`;

type ShopAndScopes = {
  shop: { name: string; myshopifyDomain: string; ianaTimezone: string; currencyCode: string };
  currentAppInstallation: { accessScopes: Array<{ handle: string }> };
};
type EarliestOrder = { orders: { nodes: Array<{ createdAt: string }> } };
type ProductTypesPage = {
  products: {
    nodes: Array<{ productType: string }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export interface ScopeEvaluation {
  canActivate: boolean;
  writeScopes: string[];
  missingScopes: string[];
  problems: string[];
}

/** Pure: decides from a list of granted scopes alone. Also used when switching a connection on. */
export function evaluateShopifyScopes(granted: string[]): ScopeEvaluation {
  const writeScopes = granted.filter((scope) => /^(unauthenticated_)?write_/.test(scope)).sort();
  const missingScopes = SHOPIFY_REQUIRED_SCOPES.filter((scope) => !granted.includes(scope));
  const problems: string[] = [];
  if (writeScopes.length > 0) {
    problems.push(
      `The key has write access (${writeScopes.join(", ")}). Paperclip must only be able to read. ` +
        `Remove all write permissions from the app in Shopify, and press Test again.`,
    );
  }
  for (const scope of missingScopes) {
    problems.push(
      `The app is missing the ${scope} permission (${SCOPE_EXPLANATIONS[scope]}). ` +
        `Add it to the app in Shopify, and press Test again.`,
    );
  }
  return { canActivate: problems.length === 0, writeScopes, missingScopes, problems };
}

export interface ShopifyCheckOutcome {
  /** Shopify answered and the shop could be read. */
  ok: boolean;
  canActivate: boolean;
  problems: string[];
  notes: string[];
  observed: DataConnectionObservedSummary | null;
}

function describeError(error: unknown): string {
  if (error instanceof ShopifyClientError) return error.message;
  return "Something unexpected went wrong during the test. Try again in a moment.";
}

export async function runShopifyConnectionCheck(
  client: ShopifyGraphQLClient,
  options: { now?: () => Date; maxProductPages?: number } = {},
): Promise<ShopifyCheckOutcome> {
  const now = options.now ?? (() => new Date());
  const maxProductPages = options.maxProductPages ?? 40;
  const notes: string[] = [];

  let shopAndScopes: ShopAndScopes;
  try {
    shopAndScopes = await client.query<ShopAndScopes>(SHOP_AND_SCOPES_QUERY);
  } catch (error) {
    return { ok: false, canActivate: false, problems: [describeError(error)], notes, observed: null };
  }

  const grantedScopes = shopAndScopes.currentAppInstallation.accessScopes.map((entry) => entry.handle).sort();
  const scopes = evaluateShopifyScopes(grantedScopes);
  const problems = [...scopes.problems];
  if (grantedScopes.some((scope) => /customer/.test(scope))) {
    notes.push(
      "The app has access to customer data. Paperclip never uses it, and you can remove it in Shopify without anything breaking.",
    );
  }

  const observed: DataConnectionObservedSummary = {
    shopName: shopAndScopes.shop.name,
    shopDomain: shopAndScopes.shop.myshopifyDomain,
    ianaTimezone: shopAndScopes.shop.ianaTimezone,
    currencyCode: shopAndScopes.shop.currencyCode,
    grantedScopes,
    earliestVisibleOrderAt: null,
    productTypeCoverage: null,
    fileServer: null,
    checkedAt: now().toISOString(),
  };

  if (!grantedScopes.includes("read_orders")) {
    return { ok: true, canActivate: false, problems, notes, observed };
  }

  try {
    const earliest = await client.query<EarliestOrder>(EARLIEST_ORDER_QUERY);
    observed.earliestVisibleOrderAt = earliest.orders.nodes[0]?.createdAt ?? null;
    if (!observed.earliestVisibleOrderAt) {
      notes.push("The key sees no orders in the shop.");
    }
  } catch (error) {
    problems.push(`Could not read orders: ${describeError(error)}`);
    return { ok: true, canActivate: false, problems, notes, observed };
  }

  if (grantedScopes.includes("read_products")) {
    const counts = new Map<string, number>();
    let productsScanned = 0;
    let productsWithoutType = 0;
    let complete = false;
    let after: string | null = null;
    try {
      for (let page = 0; page < maxProductPages; page += 1) {
        const result: ProductTypesPage = await client.query<ProductTypesPage>(
          PRODUCT_TYPES_PAGE_QUERY,
          after ? { after } : undefined,
        );
        for (const node of result.products.nodes) {
          productsScanned += 1;
          const type = node.productType.trim();
          if (!type) productsWithoutType += 1;
          else counts.set(type, (counts.get(type) ?? 0) + 1);
        }
        if (!result.products.pageInfo.hasNextPage || !result.products.pageInfo.endCursor) {
          complete = true;
          break;
        }
        after = result.products.pageInfo.endCursor;
      }
    } catch (error) {
      if (!(error instanceof ShopifyClientError) || !["budget_exhausted", "deadline_exceeded", "throttled"].includes(error.code)) {
        problems.push(`Could not read products: ${describeError(error)}`);
        return { ok: true, canActivate: false, problems, notes, observed };
      }
    }
    observed.productTypeCoverage = {
      complete,
      productsScanned,
      productsWithoutType,
      types: [...counts.entries()]
        .map(([productType, products]) => ({ productType, products }))
        .sort((a, b) => b.products - a.products || a.productType.localeCompare(b.productType, "nb")),
    };
    if (!complete) {
      notes.push(
        `Product types were counted for the first ${productsScanned} products. The shop has more, so the list is not complete.`,
      );
    }
    if (productsWithoutType > 0) {
      notes.push(`${productsWithoutType} products have no product type. They are shown as ${UNTYPED_BUCKET_LABEL} in answers.`);
    }
  }

  return { ok: true, canActivate: problems.length === 0, problems, notes, observed };
}
