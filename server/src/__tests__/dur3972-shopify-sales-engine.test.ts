import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createShopifySalesAdapter,
  nearestValues,
  SHOPIFY_API_VERSION,
  SHOPIFY_ENGINE_DOCUMENTS,
  type ShopifyLookupLimits,
} from "../services/data-sources/shopify-adapter.js";
import {
  createFetchShopifyQueryClient,
  isWriteLikeGraphqlDocument,
} from "../services/data-sources/shopify-query-client.js";
import type { SalesLines, SalesRequest } from "../services/data-sources/contract.js";
import { assertResponseMatchesSchema, validateShopifyDocument } from "./helpers/shopify-schema.js";
import {
  agreement,
  createFakeShopify,
  fakeShopifySchemaViolations,
  order,
  placedOrder,
  product,
  productSale,
  refund,
  type FakeOrder,
  type FakeShopOptions,
} from "./helpers/fake-shopify.js";

/**
 * DUR-3972 S3 acceptance tests: the Shopify sales engine, driven through the
 * real fetch-based client against a fake Shopify whose every response is
 * checked against the committed Admin API 2026-07 schema.
 *
 * "Now" is Monday 21 September 2026, 10:14 in Oslo.
 */

afterEach(() => {
  // A fixture Shopify could not have sent must fail the test, not hide behind a refusal.
  const violations = fakeShopifySchemaViolations.splice(0);
  expect(violations).toEqual([]);
});

const NOW = new Date("2026-09-21T08:14:00.000Z");
const FAKE_TOKEN = "shpat_" + "f".repeat(32); // not a real credential

function makeClock(start = NOW) {
  let t = start.getTime();
  const sleeps: number[] = [];
  return {
    sleeps,
    advance(ms: number) {
      t += ms;
    },
    clock: {
      now: () => new Date(t),
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    },
  };
}

function setup(shop: FakeShopOptions, limits: Partial<ShopifyLookupLimits> = {}, clockStart = NOW) {
  const fake = createFakeShopify(shop);
  const time = makeClock(clockStart);
  const client = createFetchShopifyQueryClient({
    shopDomain: fake.domain,
    apiVersion: SHOPIFY_API_VERSION,
    getAccessToken: async () => FAKE_TOKEN,
    fetchImpl: fake.fetchImpl,
  });
  const adapter = createShopifySalesAdapter({ client, limits, clock: time.clock });
  return { fake, time, adapter };
}

const lines = (sold: number, returnsInPeriod: number, returnsFromEarlierPeriods: number, edits: number): SalesLines => ({
  sold,
  returnsInPeriod,
  returnsFromEarlierPeriods,
  edits,
  net: sold - returnsInPeriod + edits,
});

// Catalog shared by most scenarios.
const SOFA = product("Sofa");
const SOFABORD = product("Sofabord");
const HJORNESOFA = product("Hjørnesofa");
const LENESTOL = product("Lenestol");
const UNTYPED = product("");
const PRODUCTS = [SOFA, SOFABORD, HJORNESOFA, LENESTOL, UNTYPED];

/** An old order so that every 2025/2026 month is inside the visible window. */
function anchorOrder(): FakeOrder {
  return order({
    createdAt: "2024-11-02T10:00:00Z",
    agreements: [placedOrder("2024-11-02T10:00:00Z", [[LENESTOL, 1]]).agreement],
  });
}

async function salesOk(adapter: ReturnType<typeof setup>["adapter"], request: SalesRequest) {
  const outcome = await adapter.sales(request);
  if (!outcome.ok) throw new Error(`expected ok, got refusal ${outcome.refusal.code}: ${outcome.refusal.message}`);
  return outcome;
}

describe("Shopify documents and fixtures follow the committed 2026-07 schema", () => {
  it("every engine document validates against the schema and is read-only", () => {
    for (const [name, document] of Object.entries(SHOPIFY_ENGINE_DOCUMENTS)) {
      expect(validateShopifyDocument(document), name).toEqual([]);
      expect(isWriteLikeGraphqlDocument(document), name).toBe(false);
    }
  });

  it("the schema validator accepts real Shopify responses and rejects doctored ones", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const captured = JSON.parse(
      readFileSync(path.join(here, "fixtures/shopify-2026-07/captured-demo-shop.json"), "utf8"),
    ) as { responses: Array<{ operation: string; variables: Record<string, unknown>; response: { data: unknown } }> };
    const documentFor = (operation: string) =>
      Object.values(SHOPIFY_ENGINE_DOCUMENTS).find((document) => document.includes(`query ${operation}`))!;
    expect(captured.responses.length).toBeGreaterThan(5);
    for (const entry of captured.responses) {
      assertResponseMatchesSchema(documentFor(entry.operation), entry.variables, entry.response.data);
    }
    const scan = captured.responses.find((entry) => entry.operation === "PaperclipOrdersScan")!;
    const doctored = JSON.parse(JSON.stringify(scan.response.data)) as {
      orders: { nodes: Array<Record<string, any>> };
    };
    doctored.orders.nodes[0]!.agreements.edges[0].node.sales.nodes[0].quantity = "1"; // string, not Int
    expect(() => assertResponseMatchesSchema(documentFor("PaperclipOrdersScan"), scan.variables, doctored)).toThrow();
    const extraField = JSON.parse(JSON.stringify(scan.response.data)) as typeof doctored;
    extraField.orders.nodes[0]!.email = "someone@example.com"; // never selected
    expect(() => assertResponseMatchesSchema(documentFor("PaperclipOrdersScan"), scan.variables, extraField)).toThrow();
    const badEnum = JSON.parse(JSON.stringify(scan.response.data)) as typeof doctored;
    badEnum.orders.nodes[0]!.agreements.edges[0].node.sales.nodes[0].actionType = "SOLD";
    expect(() => assertResponseMatchesSchema(documentFor("PaperclipOrdersScan"), scan.variables, badEnum)).toThrow();
  });

  it("counts real ledger data captured from Shopify's public demo shop (Toronto time zone)", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const captured = JSON.parse(
      readFileSync(path.join(here, "fixtures/shopify-2026-07/captured-demo-shop.json"), "utf8"),
    ) as { responses: Array<{ operation: string; response: unknown }> };
    const replay = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const operation = /query\s+(\w+)/.exec(JSON.parse(String(init?.body)).query)?.[1];
      const hit = captured.responses.find((entry) => entry.operation === operation);
      if (!hit) throw new Error(`no captured response for ${operation}`);
      return new Response(JSON.stringify(hit.response), { status: 200 });
    }) as typeof fetch;
    const time = makeClock();
    const adapter = createShopifySalesAdapter({
      client: createFetchShopifyQueryClient({
        shopDomain: "graphql-admin.myshopify.com",
        apiVersion: SHOPIFY_API_VERSION,
        getAccessToken: async () => FAKE_TOKEN,
        fetchImpl: replay,
      }),
      clock: time.clock,
    });
    const outcome = await salesOk(adapter, { periods: ["2020-09"], groupBy: "product_type" });
    const period = outcome.result.periods[0]!;
    expect(outcome.result.timezone).toBe("America/Toronto");
    // Four September 2020 orders: 1 untyped, Belt+Hat, 1 untyped, and a Hat
    // that was cancelled and refunded 25 seconds later.
    expect(period.total).toEqual(lines(5, 1, 0, 0));
    expect(period.byProductType).toEqual([
      { productType: "Belt", lines: lines(1, 0, 0, 0) },
      { productType: "Hat", lines: lines(2, 1, 0, 0) },
    ]);
    expect(period.untyped).toEqual(lines(2, 0, 0, 0));
    expect(outcome.audit.warnings).toEqual([]); // refunds agree with the ledger
  });
});

describe("months are cut in the shop's time zone", () => {
  it("23:30 Oslo on 31 July is July; 22:30 UTC on 31 July is August", async () => {
    const { adapter } = setup({
      products: PRODUCTS,
      orders: [
        anchorOrder(),
        order({
          createdAt: "2026-07-31T21:30:00Z",
          agreements: [placedOrder("2026-07-31T21:30:00Z", [[SOFA, 1]]).agreement],
        }),
        order({
          createdAt: "2026-07-31T22:30:00Z",
          agreements: [placedOrder("2026-07-31T22:30:00Z", [[SOFA, 2]]).agreement],
        }),
      ],
    });
    const outcome = await salesOk(adapter, { periods: ["last_month", "month_before_last"], productTypes: ["Sofa"] });
    const [july, august] = outcome.result.periods;
    expect(july!.key).toBe("2026-07");
    expect(july!.start).toBe("2026-06-30T22:00:00.000Z");
    expect(july!.selection).toEqual(lines(1, 0, 0, 0));
    expect(august!.key).toBe("2026-08");
    expect(august!.selection).toEqual(lines(2, 0, 0, 0));
    expect(outcome.result.comparison).toEqual({
      fromKey: "2026-07",
      toKey: "2026-08",
      basis: "selection",
      netChange: 1,
      netChangePercent: 100,
    });
  });
});

describe("the ledger places every movement in the month it happened", () => {
  it("a January order refunded in December is a December return from an earlier month", async () => {
    const sale = productSale("ORDER", 2, SOFA);
    const { adapter } = setup({
      products: PRODUCTS,
      orders: [
        anchorOrder(),
        order({
          createdAt: "2025-01-15T12:00:00Z",
          agreements: [
            agreement("OrderAgreement", "2025-01-15T12:00:00Z", [sale]),
            agreement("RefundAgreement", "2025-12-10T09:00:00Z", [productSale("RETURN", -1, SOFA, sale.lineItemId)]),
          ],
          refunds: [refund("2025-12-10T09:00:00Z", [{ quantity: 1, lineItemId: sale.lineItemId!, product: SOFA }])],
        }),
      ],
    });
    const outcome = await salesOk(adapter, { periods: ["2025-12", "2025-01"] });
    const [january, december] = outcome.result.periods;
    expect(january!.total).toEqual(lines(2 + 0, 0, 0, 0));
    expect(december!.total).toEqual(lines(0, 1, 1, 0));
    expect(december!.total!.net).toBe(-1);
    expect(december!.status).toBe("avsluttet");
    expect(outcome.audit.warnings).toEqual([]);
  });

  it("handles a partial return, a money-only refund, an order edit, a cancelled paid order, a test order, a deleted product and an empty product type", async () => {
    const partial = placedOrder("2026-08-03T10:00:00Z", [[SOFA, 3]]);
    const cancelled = placedOrder("2026-08-04T10:00:00Z", [[SOFABORD, 2]]);
    const moneyOnly = placedOrder("2026-08-05T10:00:00Z", [[LENESTOL, 1]]);
    const edited = placedOrder("2026-08-06T10:00:00Z", [[LENESTOL, 2]]);
    const deleted = placedOrder("2026-08-07T10:00:00Z", [[null, 1]]);
    const untyped = placedOrder("2026-08-08T10:00:00Z", [[UNTYPED, 4]]);
    const testOrder = placedOrder("2026-08-09T10:00:00Z", [[SOFA, 5]]);
    const orders = [
      anchorOrder(),
      order({
        createdAt: "2026-08-03T10:00:00Z",
        agreements: [
          partial.agreement,
          agreement("RefundAgreement", "2026-08-20T10:00:00Z", [
            productSale("RETURN", -1, SOFA, partial.sales[0]!.lineItemId),
            // Shipping refunded with it: not a product line, never counted.
            { __typename: "ShippingLineSale", actionType: "RETURN", lineType: "SHIPPING", quantity: null },
          ]),
        ],
        refunds: [refund("2026-08-20T10:00:00Z", [{ quantity: 1, lineItemId: partial.sales[0]!.lineItemId!, product: SOFA }])],
      }),
      order({
        createdAt: "2026-08-04T10:00:00Z",
        agreements: [
          cancelled.agreement,
          agreement("RefundAgreement", "2026-08-04T15:00:00Z", [
            productSale("RETURN", -2, SOFABORD, cancelled.sales[0]!.lineItemId),
          ]),
        ],
        refunds: [
          refund("2026-08-04T15:00:00Z", [{ quantity: 2, lineItemId: cancelled.sales[0]!.lineItemId!, product: SOFABORD }]),
        ],
      }),
      order({
        createdAt: "2026-08-05T10:00:00Z",
        agreements: [
          moneyOnly.agreement,
          // "Refund 200 kr as goodwill": money moves, no units come back.
          agreement("RefundAgreement", "2026-08-15T10:00:00Z", [
            { __typename: "AdjustmentSale", actionType: "RETURN", lineType: "ADJUSTMENT", quantity: null },
          ]),
        ],
        refunds: [refund("2026-08-15T10:00:00Z", [])],
      }),
      order({
        createdAt: "2026-08-06T10:00:00Z",
        agreements: [
          edited.agreement,
          agreement("OrderEditAgreement", "2026-08-06T12:00:00Z", [
            productSale("UPDATE", -1, LENESTOL, edited.sales[0]!.lineItemId),
            productSale("UPDATE", 1, SOFA),
          ]),
        ],
      }),
      order({ createdAt: "2026-08-07T10:00:00Z", agreements: [deleted.agreement] }),
      order({ createdAt: "2026-08-08T10:00:00Z", agreements: [untyped.agreement] }),
      order({ createdAt: "2026-08-09T10:00:00Z", test: true, agreements: [testOrder.agreement] }),
    ];

    for (const ignoreTestFilter of [false, true]) {
      const { adapter } = setup({ products: PRODUCTS, orders, ignoreTestFilter });
      const outcome = await salesOk(adapter, { periods: ["last_month"], groupBy: "product_type" });
      const august = outcome.result.periods[0]!;
      expect(august.byProductType).toEqual([
        { productType: "Lenestol", lines: lines(3, 0, 0, -1) },
        { productType: "Sofa", lines: lines(3, 1, 0, 1) },
        { productType: "Sofabord", lines: lines(2, 2, 0, 0) },
      ]);
      expect(august.untyped).toEqual(lines(4, 0, 0, 0));
      expect(august.deletedProduct).toEqual(lines(1, 0, 0, 0));
      expect(august.otherProductTypes).toEqual(lines(0, 0, 0, 0));
      // The test order's 5 sofas are nowhere, whether or not Shopify filtered it.
      expect(august.total).toEqual(lines(13, 3, 0, 0));
      expect(outcome.audit.warnings).toEqual([]);
    }
  });

  it("pages nested agreements and more than 250 line items instead of cutting them off", async () => {
    const bigSales = Array.from({ length: 300 }, () => productSale("ORDER", 1, SOFA));
    const edits = Array.from({ length: 11 }, (_, index) =>
      agreement("OrderEditAgreement", `2026-08-${String(11 + index).padStart(2, "0")}T10:00:00Z`, [
        productSale("UPDATE", 1, SOFABORD),
      ]),
    );
    const { adapter, fake } = setup({
      products: PRODUCTS,
      orders: [
        anchorOrder(),
        order({
          createdAt: "2026-08-10T10:00:00Z",
          agreements: [agreement("OrderAgreement", "2026-08-10T10:00:00Z", bigSales), ...edits],
        }),
      ],
    });
    const outcome = await salesOk(adapter, { periods: ["2026-08"], groupBy: "product_type" });
    const august = outcome.result.periods[0]!;
    expect(august.byProductType).toEqual([
      { productType: "Sofa", lines: lines(300, 0, 0, 0) },
      { productType: "Sofabord", lines: lines(0, 0, 0, 11) },
    ]);
    const operations = fake.requests.map((request) => request.operation);
    expect(operations).toContain("PaperclipAgreementSales");
    expect(operations).toContain("PaperclipOrderAgreements");
    expect(outcome.audit.upstreamRequests).toBe(fake.requests.length);
  });

  it("the refunds-based count agrees with the ledger, and a disagreement is a warning, not a refusal", async () => {
    const plain = placedOrder("2026-08-03T10:00:00Z", [[SOFA, 2]]);
    const { adapter } = setup({
      products: PRODUCTS,
      orders: [
        anchorOrder(),
        order({
          createdAt: "2026-08-03T10:00:00Z",
          updatedAt: "2026-08-25T10:00:00Z",
          agreements: [plain.agreement],
          // A refund record with a returned line but no RETURN in the ledger.
          refunds: [refund("2026-08-25T10:00:00Z", [{ quantity: 1, lineItemId: plain.sales[0]!.lineItemId!, product: SOFA }])],
        }),
      ],
    });
    const outcome = await salesOk(adapter, { periods: ["2026-08"] });
    expect(outcome.result.periods[0]!.total).toEqual(lines(2, 0, 0, 0));
    expect(outcome.audit.warnings).toEqual([
      "refunds_cross_check 2026-08 Sofa: ledger returns 0, refund lines 1",
      "refunds_cross_check 2026-08 total: ledger returns 0, refund lines 1",
    ]);
  });
});

describe("no data is never zero", () => {
  it("a period before the visible order window is refused, not shown as zero", async () => {
    const { adapter, fake } = setup({
      products: PRODUCTS,
      visibleFrom: "2026-07-25T00:00:00Z", // what 60 days without read_all_orders looks like
      orders: [
        anchorOrder(),
        order({
          createdAt: "2026-07-26T10:00:00Z",
          agreements: [placedOrder("2026-07-26T10:00:00Z", [[SOFA, 1]]).agreement],
        }),
      ],
    });
    const outcome = await adapter.sales({ periods: ["month_before_last", "last_month"] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("before_visible_window");
    expect(outcome.refusal.message).toContain("26.07.2026");
    expect(outcome.refusal.message).toContain("juli 2026");
    expect(outcome.refusal.message).toContain("ikke at salget var null");
    expect(fake.requests.map((request) => request.operation)).toEqual(["PaperclipShopWindow"]);
  });

  it("without read_all_orders every month is refused, even one inside the 60-day window", async () => {
    // 21 Sep: Shopify shows orders from 24 Jul, so August passes the window
    // check, but a June order returned on 10 Aug would be invisible and August
    // would come out one return short. Refuse instead of undercounting.
    const juneSale = productSale("ORDER", 1, SOFA);
    const { adapter, fake } = setup({
      products: PRODUCTS,
      accessScopes: ["read_orders", "read_products"],
      visibleFrom: "2026-07-24T00:00:00Z",
      orders: [
        anchorOrder(),
        order({
          createdAt: "2026-06-15T10:00:00Z",
          agreements: [
            agreement("OrderAgreement", "2026-06-15T10:00:00Z", [juneSale]),
            agreement("RefundAgreement", "2026-08-10T10:00:00Z", [productSale("RETURN", -1, SOFA, juneSale.lineItemId)]),
          ],
          refunds: [refund("2026-08-10T10:00:00Z", [{ quantity: 1, lineItemId: juneSale.lineItemId!, product: SOFA }])],
        }),
        order({
          createdAt: "2026-07-26T10:00:00Z",
          agreements: [placedOrder("2026-07-26T10:00:00Z", [[SOFA, 1]]).agreement],
        }),
        order({
          createdAt: "2026-08-05T10:00:00Z",
          agreements: [placedOrder("2026-08-05T10:00:00Z", [[SOFA, 2]]).agreement],
        }),
      ],
    });
    const outcome = await adapter.sales({ periods: ["last_month"] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("missing_order_history_access");
    expect(outcome.refusal.message).toContain("lacks access to older orders");
    expect(outcome.refusal.message).toContain("does not mean sales were zero");
    expect(outcome.audit.refusalCode).toBe("missing_order_history_access");
    expect(fake.requests.map((request) => request.operation)).toEqual(["PaperclipShopWindow"]);
  });

  it("without read_all_orders a future-only request still answers no_data (nothing is scanned)", async () => {
    const { adapter } = setup({
      products: PRODUCTS,
      accessScopes: ["read_orders", "read_products"],
      orders: [anchorOrder()],
    });
    const outcome = await salesOk(adapter, { periods: ["2026-12"] });
    expect(outcome.result.periods[0]!.dataState).toBe("no_data");
  });

  it("a future month is no_data, and the running month is marked as running", async () => {
    const { adapter } = setup({
      products: PRODUCTS,
      orders: [
        anchorOrder(),
        order({
          createdAt: "2026-09-02T10:00:00Z",
          agreements: [placedOrder("2026-09-02T10:00:00Z", [[SOFA, 1]]).agreement],
        }),
      ],
    });
    const outcome = await salesOk(adapter, { periods: ["this_month_to_date", "2026-10"] });
    const [september, october] = outcome.result.periods;
    expect(september!.status).toBe("pågår");
    expect(september!.statusText).toBe("pågår, per 21.09.2026 kl. 10:14");
    expect(september!.total).toEqual(lines(1, 0, 0, 0));
    expect(october!.dataState).toBe("no_data");
    expect(october!.total).toBeNull();
    expect(october!.noDataReason).toBe("Perioden har ikke startet ennå.");
    expect(outcome.result.comparison).toBeNull();
  });

  it("a shop with no visible orders is refused rather than answered with zero", async () => {
    const { adapter } = setup({ products: PRODUCTS, orders: [] });
    const outcome = await adapter.sales({ periods: ["last_month"] });
    expect(outcome.ok ? null : outcome.refusal.code).toBe("no_visible_orders");
  });
});

describe("complete or nothing", () => {
  function manyOrders(count: number): FakeOrder[] {
    return Array.from({ length: count }, (_, index) =>
      order({
        createdAt: `2026-08-${String(1 + (index % 28)).padStart(2, "0")}T10:00:00Z`,
        agreements: [placedOrder(`2026-08-${String(1 + (index % 28)).padStart(2, "0")}T10:00:00Z`, [[SOFA, 1]]).agreement],
      }),
    );
  }

  it("THROTTLED is paced and retried, and the answer is still complete", async () => {
    const { adapter, time, fake } = setup({
      products: PRODUCTS,
      throttleOnRequests: [2],
      requestedQueryCost: 600,
      orders: [anchorOrder(), ...manyOrders(30)],
    });
    const outcome = await salesOk(adapter, { periods: ["2026-08"] });
    expect(outcome.result.periods[0]!.total).toEqual(lines(30, 0, 0, 0));
    expect(outcome.audit.throttleRetries).toBe(1);
    // It waited for the bucket to refill: (600 - 20) / 100 per second = 5.8 s.
    expect(time.sleeps).toContain(5800);
    expect(outcome.audit.upstreamRequests).toBe(fake.requests.length);
  });

  it("gives up after two THROTTLED retries instead of answering with a partial sum", async () => {
    const { adapter } = setup({
      products: PRODUCTS,
      throttleOnRequests: [2, 3, 4],
      orders: [anchorOrder(), ...manyOrders(3)],
    });
    const outcome = await adapter.sales({ periods: ["2026-08"] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("throttled");
    expect(outcome.audit.throttleRetries).toBe(2);
    expect(JSON.stringify(outcome)).not.toContain('"sold"');
  });

  it("an unfinished scan (request budget) is refused", async () => {
    const { adapter, fake } = setup({ products: PRODUCTS, orders: [anchorOrder(), ...manyOrders(80)] }, {
      maxRequests: 3,
      ordersPageSize: 25,
    });
    const outcome = await adapter.sales({ periods: ["2026-08"] });
    expect(outcome.ok ? null : outcome.refusal.code).toBe("request_budget_exceeded");
    expect(fake.requests.length).toBe(3);
    if (!outcome.ok) expect(outcome.refusal.message).toContain("partial figure");
  });

  it("the default budget is 60 requests and 25 seconds", async () => {
    const { adapter, fake } = setup({ products: PRODUCTS, orders: [anchorOrder(), ...manyOrders(61 * 25)] });
    const outcome = await adapter.sales({ periods: ["2026-08"] });
    expect(outcome.ok ? null : outcome.refusal.code).toBe("request_budget_exceeded");
    expect(fake.requests.length).toBe(60);

    const slow = setup({ products: PRODUCTS, orders: [anchorOrder(), ...manyOrders(200)] });
    const slowFetch = slow.fake.fetchImpl;
    const slowAdapter = createShopifySalesAdapter({
      client: createFetchShopifyQueryClient({
        shopDomain: slow.fake.domain,
        apiVersion: SHOPIFY_API_VERSION,
        getAccessToken: async () => FAKE_TOKEN,
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          slow.time.advance(9_000);
          return slowFetch(input, init);
        }) as typeof fetch,
      }),
      clock: slow.time.clock,
    });
    const slowOutcome = await slowAdapter.sales({ periods: ["2026-08"] });
    expect(slowOutcome.ok ? null : slowOutcome.refusal.code).toBe("time_budget_exceeded");
  });
});

describe("requests the engine refuses", () => {
  it("kroner is refused before anything is sent to Shopify", async () => {
    for (const measure of [["kroner"], ["units", "revenue_nok"], []]) {
      const { adapter, fake } = setup({ products: PRODUCTS, orders: [anchorOrder()] });
      const outcome = await adapter.sales({ periods: ["last_month"], measure });
      expect(outcome.ok ? null : outcome.refusal.code).toBe("kroner_not_enabled");
      if (!outcome.ok) expect(outcome.refusal.message).toMatch(/^Amounts in kroner are not switched on yet/);
      expect(fake.requests).toHaveLength(0);
    }
  });

  it("an unknown product type is refused with the nearest catalog values", async () => {
    const { adapter } = setup({ products: PRODUCTS, orders: [anchorOrder()] });
    const outcome = await adapter.sales({ periods: ["last_month"], productTypes: ["Sofaa"] });
    expect(outcome.ok ? null : outcome.refusal.code).toBe("unknown_product_type");
    if (!outcome.ok) expect(outcome.refusal.message).toContain("Nearest: Sofa");
    expect(nearestValues("hjornesofa", ["Hjørnesofa", "Sofa", "Lenestol"], 1)).toEqual(["Hjørnesofa"]);
  });

  it("free dates, more than two periods and the same month twice are refused", async () => {
    const { adapter } = setup({ products: PRODUCTS, orders: [anchorOrder()] });
    const free = await adapter.sales({ periods: ["2026-08-01..2026-08-31" as never] });
    expect(free.ok ? null : free.refusal.code).toBe("invalid_request");
    const three = await adapter.sales({ periods: ["2026-06", "2026-07", "2026-08"] });
    expect(three.ok ? null : three.refusal.code).toBe("invalid_request");
    const same = await adapter.sales({ periods: ["last_month", "2026-08"] });
    expect(same.ok ? null : same.refusal.code).toBe("invalid_request");
  });

  it("an unknown ledger action is refused instead of silently dropped", async () => {
    const { adapter } = setup({
      products: PRODUCTS,
      orders: [
        anchorOrder(),
        order({
          createdAt: "2026-08-03T10:00:00Z",
          agreements: [agreement("OrderAgreement", "2026-08-03T10:00:00Z", [productSale("UNKNOWN", 1, SOFA)])],
        }),
      ],
    });
    const outcome = await adapter.sales({ periods: ["2026-08"] });
    expect(outcome.ok ? null : outcome.refusal.code).toBe("unexpected_shape");
  });
});

describe("the key stays in the header", () => {
  it("sends the token only in X-Shopify-Access-Token, to the pinned version", async () => {
    const { adapter, fake } = setup({ products: PRODUCTS, orders: [anchorOrder()] });
    await salesOk(adapter, { periods: ["2025-01"] });
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(request.url).toBe(`https://${fake.domain}/admin/api/2026-07/graphql.json`);
      expect(request.headers["x-shopify-access-token"]).toBe(FAKE_TOKEN);
      expect(request.body).not.toContain(FAKE_TOKEN);
      expect(request.url).not.toContain(FAKE_TOKEN);
    }
  });

  it("scrubs the token out of transport errors and refusals", async () => {
    const leaky = (async () => {
      throw new Error(`connect failed, header was x-shopify-access-token: ${FAKE_TOKEN}`);
    }) as unknown as typeof fetch;
    const adapter = createShopifySalesAdapter({
      client: createFetchShopifyQueryClient({
        shopDomain: "demo-butikk.myshopify.com",
        apiVersion: SHOPIFY_API_VERSION,
        getAccessToken: async () => FAKE_TOKEN,
        fetchImpl: leaky,
      }),
      clock: makeClock().clock,
    });
    const outcome = await adapter.sales({ periods: ["last_month"] });
    expect(outcome.ok ? null : outcome.refusal.code).toBe("upstream_error");
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(FAKE_TOKEN);
  });

  it("refuses write-like documents before reading the token", async () => {
    let tokenReads = 0;
    const client = createFetchShopifyQueryClient({
      shopDomain: "demo-butikk.myshopify.com",
      apiVersion: SHOPIFY_API_VERSION,
      getAccessToken: async () => {
        tokenReads += 1;
        return FAKE_TOKEN;
      },
      fetchImpl: (async () => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    });
    await expect(client.request("mutation { productDelete(input: {id: \"x\"}) { deletedProductId } }", {})).rejects.toThrow(
      /read-only/,
    );
    expect(tokenReads).toBe(0);
    expect(() =>
      createFetchShopifyQueryClient({
        shopDomain: "evil.example.com",
        apiVersion: SHOPIFY_API_VERSION,
        getAccessToken: async () => FAKE_TOKEN,
        fetchImpl: fetch,
      }),
    ).toThrow(/myshopify/);
  });
});

describe("catalog", () => {
  it("lists every product type with product counts and 12-month units, untyped and deleted stated", async () => {
    const deletedLine = placedOrder("2026-03-01T10:00:00Z", [[null, 2]]);
    const { adapter } = setup({
      products: [...PRODUCTS, product("Sofa"), product("")],
      orders: [
        anchorOrder(), // November 2024: outside the last 12 months
        order({
          createdAt: "2026-02-01T10:00:00Z",
          agreements: [placedOrder("2026-02-01T10:00:00Z", [[SOFA, 4], [UNTYPED, 1]]).agreement],
        }),
        order({ createdAt: "2026-03-01T10:00:00Z", agreements: [deletedLine.agreement] }),
      ],
    });
    const outcome = await adapter.catalog({ includeUnitsSold: true });
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.result.productTypes).toEqual([
      { productType: "Hjørnesofa", productCount: 1, unitsSoldLast12Months: 0 },
      { productType: "Lenestol", productCount: 1, unitsSoldLast12Months: 0 },
      { productType: "Sofa", productCount: 2, unitsSoldLast12Months: 4 },
      { productType: "Sofabord", productCount: 1, unitsSoldLast12Months: 0 },
    ]);
    expect(outcome.result.untypedProductCount).toBe(2);
    expect(outcome.result.untypedUnitsSoldLast12Months).toBe(1);
    expect(outcome.result.deletedProductUnitsSoldLast12Months).toBe(2);
    expect(outcome.result.unitsSoldStatus).toBe("beregnet");
    expect(outcome.result.earliestVisibleOrderAt).toBe("2024-11-02T10:00:00Z".replace("Z", ".000Z"));
  });

  it("does not compute 12-month units without read_all_orders", async () => {
    const { adapter, fake } = setup({
      products: PRODUCTS,
      accessScopes: ["read_orders", "read_products"],
      orders: [
        anchorOrder(),
        order({
          createdAt: "2026-08-01T10:00:00Z",
          agreements: [placedOrder("2026-08-01T10:00:00Z", [[SOFA, 1]]).agreement],
        }),
      ],
    });
    const outcome = await adapter.catalog({ includeUnitsSold: true });
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.result.productTypes.every((entry) => entry.unitsSoldLast12Months === null)).toBe(true);
    expect(outcome.result.unitsSoldStatus).toBe("ikke beregnet: Shopify-tilkoblingen mangler tilgang til eldre ordre");
    expect(fake.requests.map((request) => request.operation)).not.toContain("PaperclipOrdersScan");
  });

  it("does not show partial 12-month units when the scan is too big", async () => {
    const { adapter } = setup(
      {
        products: PRODUCTS,
        orders: [
          anchorOrder(),
          ...Array.from({ length: 30 }, () =>
            order({
              createdAt: "2026-02-01T10:00:00Z",
              agreements: [placedOrder("2026-02-01T10:00:00Z", [[SOFA, 1]]).agreement],
            }),
          ),
        ],
      },
      { maxRequests: 3, ordersPageSize: 10 },
    );
    const outcome = await adapter.catalog({ includeUnitsSold: true });
    if (!outcome.ok) throw new Error(outcome.refusal.message);
    expect(outcome.result.productTypes.every((entry) => entry.unitsSoldLast12Months === null)).toBe(true);
    expect(outcome.result.unitsSoldStatus).toMatch(/^ikke beregnet/);
    expect(outcome.result.productTypes.find((entry) => entry.productType === "Sofa")!.productCount).toBe(1);
  });
});
