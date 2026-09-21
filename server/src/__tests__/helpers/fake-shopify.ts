import { assertResponseMatchesSchema } from "./shopify-schema.js";

/**
 * DUR-3972 S3: a fake Shopify Admin GraphQL server, reached through an
 * injected `fetch`. It answers the engine's operations from an in-memory shop
 * and runs EVERY response it serves through the committed 2026-07 schema
 * (assertResponseMatchesSchema), so a fixture that Shopify could not have sent
 * fails the test instead of passing silently.
 *
 * Fixture ledger shapes (signs, agreement kinds, money-only refunds, order
 * edits, cancellations) follow Shopify's public documentation of the sales
 * model and were cross-checked against real responses captured from Shopify's
 * public demo shop (fixtures/shopify-2026-07/captured-demo-shop.json): an
 * ORDER sale has a positive quantity, a RETURN sale a negative one.
 */

/**
 * Every schema violation any fake served, across the test file. A violation
 * also surfaces as a transport error inside the engine (which would turn into
 * a refusal), so tests must assert this list is empty (see afterEach in the
 * test file) rather than rely on the refusal code alone.
 */
export const fakeShopifySchemaViolations: string[] = [];

export interface FakeProduct {
  id: string;
  productType: string;
}

export interface FakeSale {
  __typename: string; // ProductSale, AdjustmentSale, ShippingLineSale, ...
  actionType: "ORDER" | "RETURN" | "UPDATE" | "UNKNOWN";
  lineType: "PRODUCT" | "TIP" | "GIFT_CARD" | "SHIPPING" | "DUTY" | "ADDITIONAL_FEE" | "FEE" | "UNKNOWN" | "ADJUSTMENT";
  quantity: number | null;
  /** ProductSale only. null product = deleted product. */
  lineItemId?: string;
  product?: FakeProduct | null;
}

export interface FakeAgreement {
  __typename: "OrderAgreement" | "RefundAgreement" | "ReturnAgreement" | "OrderEditAgreement";
  id: string;
  happenedAt: string;
  sales: FakeSale[];
}

export interface FakeRefund {
  id: string;
  createdAt: string | null;
  lines: Array<{ quantity: number; lineItemId: string; product: FakeProduct | null }>;
}

export interface FakeOrder {
  id: string;
  createdAt: string;
  updatedAt: string;
  test: boolean;
  agreements: FakeAgreement[];
  refunds: FakeRefund[];
}

export interface FakeShopOptions {
  name?: string;
  domain?: string;
  timezone?: string;
  orders: FakeOrder[];
  products?: FakeProduct[];
  /** Simulate a shop that ignores `test:false` in the search (belt-and-braces test). */
  ignoreTestFilter?: boolean;
  /**
   * Simulate Shopify's visibility window: orders created before this instant
   * are invisible (what happens without read_all_orders).
   */
  visibleFrom?: string;
  /** Request numbers (1-based) that answer THROTTLED. */
  throttleOnRequests?: number[];
  /** throttleStatus.currentlyAvailable reported on every response. */
  currentlyAvailable?: number;
  requestedQueryCost?: number;
}

export interface FakeRequestLog {
  operation: string;
  variables: Record<string, unknown>;
  headers: Record<string, string>;
  url: string;
  body: string;
}

const cursorOf = (index: number) => Buffer.from(`i:${index}`).toString("base64");
const indexAfter = (cursor: unknown): number => {
  if (cursor === null || cursor === undefined) return 0;
  const decoded = Buffer.from(String(cursor), "base64").toString("utf8");
  const match = /^i:(\d+)$/.exec(decoded);
  if (!match) throw new Error(`fake shopify: bad cursor ${String(cursor)}`);
  return Number(match[1]) + 1;
};

function page<T>(items: T[], first: unknown, after: unknown) {
  const size = Number(first);
  if (!Number.isInteger(size) || size < 1 || size > 250) throw new Error(`fake shopify: bad page size ${String(first)}`);
  const start = indexAfter(after);
  const slice = items.slice(start, start + size);
  return {
    slice,
    startIndex: start,
    pageInfo: {
      hasNextPage: start + size < items.length,
      endCursor: slice.length > 0 ? cursorOf(start + slice.length - 1) : null,
    },
  };
}

function saleJson(sale: FakeSale) {
  const base: Record<string, unknown> = {
    __typename: sale.__typename,
    actionType: sale.actionType,
    lineType: sale.lineType,
    quantity: sale.quantity,
  };
  if (sale.__typename === "ProductSale") {
    base.lineItem = {
      id: sale.lineItemId ?? "gid://shopify/LineItem/1",
      product: sale.product ? { id: sale.product.id, productType: sale.product.productType } : null,
    };
  }
  return base;
}

function salesConnection(sales: FakeSale[], first: unknown, after: unknown) {
  const p = page(sales, first, after);
  return { pageInfo: p.pageInfo, nodes: p.slice.map(saleJson) };
}

function agreementJson(agreement: FakeAgreement, salesFirst: unknown, salesAfter: unknown = null) {
  return {
    __typename: agreement.__typename,
    id: agreement.id,
    happenedAt: agreement.happenedAt,
    sales: salesConnection(agreement.sales, salesFirst, salesAfter),
  };
}

function agreementsConnection(order: FakeOrder, first: unknown, after: unknown, salesFirst: unknown) {
  const p = page(order.agreements, first, after);
  return {
    pageInfo: p.pageInfo,
    edges: p.slice.map((agreement, offset) => ({
      cursor: cursorOf(p.startIndex + offset),
      node: agreementJson(agreement, salesFirst),
    })),
  };
}

function refundLinesConnection(refund: FakeRefund, first: unknown, after: unknown) {
  const p = page(refund.lines, first, after);
  return {
    pageInfo: p.pageInfo,
    nodes: p.slice.map((line) => ({
      quantity: line.quantity,
      lineItem: {
        id: line.lineItemId,
        product: line.product ? { id: line.product.id, productType: line.product.productType } : null,
      },
    })),
  };
}

function refundJson(refund: FakeRefund, refundLinesFirst: unknown) {
  return {
    id: refund.id,
    createdAt: refund.createdAt,
    refundLineItems: refundLinesConnection(refund, refundLinesFirst, null),
  };
}

export function createFakeShopify(options: FakeShopOptions) {
  const requests: FakeRequestLog[] = [];
  const domain = options.domain ?? "demo-butikk.myshopify.com";
  const visibleFrom = options.visibleFrom ? Date.parse(options.visibleFrom) : -Infinity;
  const visibleOrders = () => options.orders.filter((order) => Date.parse(order.createdAt) >= visibleFrom);
  const products = options.products ?? [];

  const findOrder = (id: unknown) => visibleOrders().find((order) => order.id === id) ?? null;

  function answer(operation: string, v: Record<string, unknown>): Record<string, unknown> {
    switch (operation) {
      case "PaperclipShopWindow": {
        const earliest = visibleOrders()
          .filter((order) => !order.test)
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
        return {
          shop: {
            name: options.name ?? "Demo Butikk",
            myshopifyDomain: domain,
            ianaTimezone: options.timezone ?? "Europe/Oslo",
            currencyCode: "NOK",
          },
          orders: { nodes: earliest ? [{ id: earliest.id, createdAt: earliest.createdAt }] : [] },
        };
      }
      case "PaperclipOrdersScan": {
        const match = /^updated_at:>='([^']+)' AND test:false$/.exec(String(v.query));
        if (!match) throw new Error(`fake shopify: unexpected search ${String(v.query)}`);
        const from = Date.parse(match[1]!);
        const matching = visibleOrders()
          .filter((order) => Date.parse(order.updatedAt) >= from)
          .filter((order) => options.ignoreTestFilter || !order.test)
          .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
        const p = page(matching, v.first, v.after);
        return {
          orders: {
            pageInfo: p.pageInfo,
            nodes: p.slice.map((order) => ({
              id: order.id,
              createdAt: order.createdAt,
              updatedAt: order.updatedAt,
              test: order.test,
              agreements: agreementsConnection(order, v.agreementsFirst, null, v.salesFirst),
              refunds: order.refunds
                .slice(0, Number(v.refundsFirst))
                .map((refund) => refundJson(refund, v.refundLinesFirst)),
            })),
          },
        };
      }
      case "PaperclipOrderAgreements": {
        const order = findOrder(v.id);
        return {
          order: order
            ? { id: order.id, agreements: agreementsConnection(order, v.agreementsFirst, v.after, v.salesFirst) }
            : null,
        };
      }
      case "PaperclipAgreementSales": {
        const order = findOrder(v.id);
        if (!order) return { order: null };
        const index = indexAfter(v.agreementAfter);
        const agreement = order.agreements[index];
        return {
          order: {
            id: order.id,
            agreements: {
              edges: agreement
                ? [{ cursor: cursorOf(index), node: agreementJson(agreement, v.salesFirst, v.salesAfter) }]
                : [],
            },
          },
        };
      }
      case "PaperclipOrderRefunds": {
        const order = findOrder(v.id);
        return {
          order: order
            ? { id: order.id, refunds: order.refunds.map((refund) => refundJson(refund, v.refundLinesFirst)) }
            : null,
        };
      }
      case "PaperclipRefundLineItems": {
        const refund = visibleOrders()
          .flatMap((order) => order.refunds)
          .find((entry) => entry.id === v.id);
        return {
          node: refund
            ? { __typename: "Refund", id: refund.id, refundLineItems: refundLinesConnection(refund, v.refundLinesFirst, v.after) }
            : null,
        };
      }
      case "PaperclipProductTypes": {
        const types = [...new Set(products.map((product) => product.productType))].sort();
        const p = page(types, v.first, v.after);
        return { productTypes: { pageInfo: p.pageInfo, nodes: p.slice } };
      }
      case "PaperclipProductsPage": {
        const p = page(products, v.first, v.after);
        return {
          products: {
            pageInfo: p.pageInfo,
            nodes: p.slice.map((product) => ({ id: product.id, productType: product.productType })),
          },
        };
      }
      default:
        throw new Error(`fake shopify: unknown operation ${operation}`);
    }
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const body = String(init?.body ?? "");
    const parsed = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
    const operation = /query\s+(\w+)/.exec(parsed.query)?.[1] ?? "anonymous";
    requests.push({ operation, variables: parsed.variables, headers, url, body });
    const cost = {
      requestedQueryCost: options.requestedQueryCost ?? 100,
      actualQueryCost: options.requestedQueryCost ?? 100,
      throttleStatus: {
        maximumAvailable: 2000,
        currentlyAvailable: options.currentlyAvailable ?? 1900,
        restoreRate: 100,
      },
    };
    if (options.throttleOnRequests?.includes(requests.length)) {
      // Shopify's documented THROTTLED shape: HTTP 200, GraphQL error with
      // extensions.code THROTTLED, actualQueryCost null, bucket nearly empty.
      return new Response(
        JSON.stringify({
          errors: [
            {
              message: "Throttled",
              extensions: {
                code: "THROTTLED",
                documentation: "https://shopify.dev/api/usage/rate-limits",
              },
            },
          ],
          extensions: {
            cost: {
              requestedQueryCost: cost.requestedQueryCost,
              actualQueryCost: null,
              throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 20, restoreRate: 100 },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const data = answer(operation, parsed.variables);
    try {
      assertResponseMatchesSchema(parsed.query, parsed.variables, data);
    } catch (error) {
      fakeShopifySchemaViolations.push(`${operation}: ${(error as Error).message}`);
      throw error;
    }
    return new Response(JSON.stringify({ data, extensions: { cost } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { fetchImpl, requests, domain };
}

// ---------------------------------------------------------------------------
// Small builders so tests read like the business story they check.
// ---------------------------------------------------------------------------

let idCounter = 1000;
export const nextId = (kind: string) => `gid://shopify/${kind}/${(idCounter += 1)}`;

export function product(productType: string): FakeProduct {
  return { id: nextId("Product"), productType };
}

export function productSale(
  actionType: FakeSale["actionType"],
  quantity: number | null,
  prod: FakeProduct | null,
  lineItemId = nextId("LineItem"),
): FakeSale {
  return { __typename: "ProductSale", actionType, lineType: "PRODUCT", quantity, lineItemId, product: prod };
}

export function agreement(
  kind: FakeAgreement["__typename"],
  happenedAt: string,
  sales: FakeSale[],
): FakeAgreement {
  return { __typename: kind, id: nextId("SalesAgreement"), happenedAt, sales };
}

export function order(input: {
  createdAt: string;
  updatedAt?: string;
  test?: boolean;
  agreements: FakeAgreement[];
  refunds?: FakeRefund[];
}): FakeOrder {
  const latest = [input.createdAt, ...input.agreements.map((entry) => entry.happenedAt)]
    .map((value) => Date.parse(value))
    .reduce((a, b) => Math.max(a, b));
  return {
    id: nextId("Order"),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? new Date(latest).toISOString(),
    test: input.test ?? false,
    agreements: input.agreements,
    refunds: input.refunds ?? [],
  };
}

export function refund(createdAt: string, lines: FakeRefund["lines"]): FakeRefund {
  return { id: nextId("Refund"), createdAt, lines };
}

/**
 * A simple placed order: one ORDER agreement with one product sale per line.
 * Returns the order plus its line ids so returns can point at the same lines.
 */
export function placedOrder(createdAt: string, lines: Array<[FakeProduct | null, number]>) {
  const sales = lines.map(([prod, quantity]) => productSale("ORDER", quantity, prod));
  return {
    sales,
    agreement: agreement("OrderAgreement", createdAt, sales),
  };
}
