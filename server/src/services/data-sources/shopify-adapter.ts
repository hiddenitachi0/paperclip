import {
  addLines,
  checkSalesInvariants,
  computeChangePercent,
  DELETED_PRODUCT_BUCKET_LABEL,
  emptyLines,
  isKronerOnlyRefusal,
  KRONER_NOT_ENABLED_MESSAGE,
  SALES_DEFINITIONS_NB,
  salesRequestSchema,
  salesResultSchema,
  catalogResultSchema,
  UNTYPED_BUCKET_LABEL,
  type CatalogEntry,
  type CatalogResult,
  type DataLookupAudit,
  type DataLookupOutcome,
  type DataRefusal,
  type DataRefusalCode,
  type ProductTypeBucket,
  type SalesComparison,
  type SalesLines,
  type SalesPeriod,
  type SalesRequest,
  type SalesResult,
} from "./contract.js";
import {
  isWriteLikeGraphqlDocument,
  type ShopifyCostExtension,
  type ShopifyGraphqlResponse,
  type ShopifyQueryClient,
} from "./shopify-query-client.js";
import {
  addMonths,
  assertValidTimeZone,
  formatZonedDate,
  formatZonedDateTime,
  monthKey,
  NORWEGIAN_MONTHS,
  parseMonthKey,
  zonedMonthKey,
  zonedMonthStart,
  zonedParts,
} from "./zoned-time.js";
import { redactKnownLeakedSecretPatterns } from "../../redaction.js";

/**
 * DUR-3972 S3: Shopify sales engine and catalog, based on Shopify's own sales
 * LEDGER (Order.agreements -> sales), the same data Shopify Analytics uses.
 *
 * How a lookup works:
 *  1. Read the shop (name, time zone) and the earliest order Shopify lets us
 *     see. Months are cut in the shop's zone. A period starting before the
 *     earliest visible order is REFUSED, never shown as zero.
 *  2. Scan orders with `updated_at >= <first period start> AND test:false`,
 *     sorted by UPDATED_AT, with cursor pagination. A refund or edit of an old
 *     order also moves its `updated_at`, so one scan finds new sales AND
 *     returns/edits on older orders.
 *  3. Every PRODUCT sale is placed in the month of its agreement's
 *     `happenedAt`: ORDER = sold, RETURN = returns, UPDATE = edits. A return
 *     whose order was created in an earlier month is "fra tidligere måneder".
 *     Nested `agreements` and `sales` lists are paged with follow-up queries.
 *  4. Complete or nothing: at most `maxRequests` upstream requests and
 *     `maxDurationMs` per lookup. Hitting either is a refusal, never a partial
 *     sum. Unknown ledger shapes are refused too.
 *  5. The consistency checks (contract.checkSalesInvariants) run on every
 *     result; a failure is a refusal with the violations in the audit.
 *  6. A second count of returns from `refunds { createdAt refundLineItems }`
 *     runs in the same scan. A difference is an audit WARNING, not a refusal,
 *     so it can be explained at reconciliation.
 *
 * Units only. Any other measure is refused with KRONER_NOT_ENABLED_MESSAGE.
 */

/** The pinned Admin API version. The committed schema in ./shopify-schema matches it. */
export const SHOPIFY_API_VERSION = "2026-07";

export interface ShopifyLookupLimits {
  /** Upstream requests per lookup, THROTTLED retries included. */
  maxRequests: number;
  /** Wall-clock budget per lookup, waiting for Shopify's throttle included. */
  maxDurationMs: number;
  /** THROTTLED retries per request. */
  maxThrottleRetries: number;
  ordersPageSize: number;
  agreementsPageSize: number;
  salesPageSize: number;
  /** Page size for the follow-up query that pages ONE agreement's sales. */
  salesFollowUpPageSize: number;
  refundsPerOrder: number;
  refundLinesPageSize: number;
  productsPageSize: number;
  productTypesPageSize: number;
}

export const DEFAULT_SHOPIFY_LOOKUP_LIMITS: ShopifyLookupLimits = {
  maxRequests: 60,
  maxDurationMs: 25_000,
  maxThrottleRetries: 2,
  ordersPageSize: 25,
  agreementsPageSize: 10,
  salesPageSize: 25,
  salesFollowUpPageSize: 250,
  refundsPerOrder: 10,
  refundLinesPageSize: 25,
  productsPageSize: 250,
  productTypesPageSize: 250,
};

// ---------------------------------------------------------------------------
// GraphQL documents. Read-only by construction; the tests validate every one of
// them, and every fixture response, against the committed 2026-07 schema.
// ---------------------------------------------------------------------------

export const SHOP_WINDOW_QUERY = `query PaperclipShopWindow {
  shop {
    name
    myshopifyDomain
    ianaTimezone
    currencyCode
  }
  currentAppInstallation {
    accessScopes {
      handle
    }
  }
  orders(first: 1, sortKey: CREATED_AT, query: "test:false") {
    nodes {
      id
      createdAt
    }
  }
}`;

const SALE_FRAGMENT = `fragment PaperclipSaleFields on Sale {
  __typename
  actionType
  lineType
  quantity
  ... on ProductSale {
    lineItem {
      id
      product {
        id
        productType
      }
    }
  }
}`;

const AGREEMENT_FRAGMENT = `fragment PaperclipAgreementFields on SalesAgreement {
  __typename
  id
  happenedAt
  sales(first: $salesFirst) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ...PaperclipSaleFields
    }
  }
}`;

const REFUND_LINE_FIELDS = `quantity
      lineItem {
        id
        product {
          id
          productType
        }
      }`;

const REFUND_FRAGMENT = `fragment PaperclipRefundFields on Refund {
  id
  createdAt
  refundLineItems(first: $refundLinesFirst) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ${REFUND_LINE_FIELDS}
    }
  }
}`;

export const ORDERS_SCAN_QUERY = `query PaperclipOrdersScan($first: Int!, $after: String, $query: String!, $agreementsFirst: Int!, $salesFirst: Int!, $refundsFirst: Int!, $refundLinesFirst: Int!) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      createdAt
      updatedAt
      test
      agreements(first: $agreementsFirst) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          cursor
          node {
            ...PaperclipAgreementFields
          }
        }
      }
      refunds(first: $refundsFirst) {
        ...PaperclipRefundFields
      }
    }
  }
}

${AGREEMENT_FRAGMENT}

${SALE_FRAGMENT}

${REFUND_FRAGMENT}`;

export const ORDER_AGREEMENTS_QUERY = `query PaperclipOrderAgreements($id: ID!, $after: String, $agreementsFirst: Int!, $salesFirst: Int!) {
  order(id: $id) {
    id
    agreements(first: $agreementsFirst, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          ...PaperclipAgreementFields
        }
      }
    }
  }
}

${AGREEMENT_FRAGMENT}

${SALE_FRAGMENT}`;

/**
 * SalesAgreement is not a Node, so one agreement's sales are paged by
 * re-selecting that agreement through its order: `agreements(first: 1, after:
 * <cursor of the agreement before it>)`.
 */
export const AGREEMENT_SALES_QUERY = `query PaperclipAgreementSales($id: ID!, $agreementAfter: String, $salesFirst: Int!, $salesAfter: String) {
  order(id: $id) {
    id
    agreements(first: 1, after: $agreementAfter) {
      edges {
        cursor
        node {
          __typename
          id
          happenedAt
          sales(first: $salesFirst, after: $salesAfter) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              ...PaperclipSaleFields
            }
          }
        }
      }
    }
  }
}

${SALE_FRAGMENT}`;

export const ORDER_REFUNDS_QUERY = `query PaperclipOrderRefunds($id: ID!, $refundLinesFirst: Int!) {
  order(id: $id) {
    id
    refunds {
      ...PaperclipRefundFields
    }
  }
}

${REFUND_FRAGMENT}`;

export const REFUND_LINE_ITEMS_QUERY = `query PaperclipRefundLineItems($id: ID!, $after: String, $refundLinesFirst: Int!) {
  node(id: $id) {
    __typename
    ... on Refund {
      id
      refundLineItems(first: $refundLinesFirst, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          ${REFUND_LINE_FIELDS}
        }
      }
    }
  }
}`;

export const PRODUCT_TYPES_QUERY = `query PaperclipProductTypes($first: Int!, $after: String) {
  productTypes(first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes
  }
}`;

export const PRODUCTS_PAGE_QUERY = `query PaperclipProductsPage($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      productType
    }
  }
}`;

export const SHOPIFY_ENGINE_DOCUMENTS = {
  SHOP_WINDOW_QUERY,
  ORDERS_SCAN_QUERY,
  ORDER_AGREEMENTS_QUERY,
  AGREEMENT_SALES_QUERY,
  ORDER_REFUNDS_QUERY,
  REFUND_LINE_ITEMS_QUERY,
  PRODUCT_TYPES_QUERY,
  PRODUCTS_PAGE_QUERY,
} as const;

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

class LookupRefusal extends Error {
  readonly refusal: DataRefusal;
  constructor(code: DataRefusalCode, message: string, detail: string[] = []) {
    super(message);
    this.name = "LookupRefusal";
    this.refusal = { code, message, detail };
  }
}

const TOO_BIG_MESSAGE =
  "The lookup became too big to finish safely (too many orders to go through), so I am not giving a partial figure. Try one month at a time, or ask a board user for help.";
const THROTTLED_MESSAGE =
  "Shopify asked us to wait because too many requests came in, so I am not giving a partial figure. Try again in a minute.";
const MISSING_ORDER_HISTORY_MESSAGE =
  "The Shopify connection lacks access to older orders (the read_all_orders permission), so returns and edits on older orders would be missing. I am therefore giving no figures. That does not mean sales were zero.";
const UPSTREAM_MESSAGE = "Shopify answered with an error, so I have no figures to give. Try again later.";
const SHAPE_MESSAGE =
  "Shopify sent data in a format I do not recognise, so I am not giving an answer. The error has been logged.";
const INVARIANT_MESSAGE =
  "The figures from Shopify did not add up when I checked them, so I am not giving an answer. The error has been logged.";

// ---------------------------------------------------------------------------
// One lookup's request runner: budget, deadline, pacing, THROTTLED retries.
// ---------------------------------------------------------------------------

export interface ShopifyAdapterClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

const realClock: ShopifyAdapterClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

class LookupRunner {
  private readonly startedAtMs: number;
  requests = 0;
  costPoints = 0;
  throttleRetries = 0;
  readonly warnings: string[] = [];
  private lastRequestedCost = 0;
  private lastThrottle: ShopifyCostExtension["throttleStatus"] = null;

  constructor(
    private readonly client: ShopifyQueryClient,
    private readonly limits: ShopifyLookupLimits,
    private readonly clock: ShopifyAdapterClock,
  ) {
    this.startedAtMs = clock.now().getTime();
  }

  elapsedMs(): number {
    return this.clock.now().getTime() - this.startedAtMs;
  }

  private remainingMs(): number {
    return this.limits.maxDurationMs - this.elapsedMs();
  }

  private async waitFor(ms: number): Promise<void> {
    if (ms <= 0) return;
    if (ms >= this.remainingMs()) {
      throw new LookupRefusal("time_budget_exceeded", TOO_BIG_MESSAGE, [
        `would wait ${Math.ceil(ms)}ms for Shopify's throttle with ${Math.max(0, this.remainingMs())}ms left`,
      ]);
    }
    await this.clock.sleep(ms);
  }

  /** Wait until the bucket is likely to hold the last query's cost again. */
  private async pace(): Promise<void> {
    const status = this.lastThrottle;
    if (!status || !(status.restoreRate > 0)) return;
    const deficit = this.lastRequestedCost - status.currentlyAvailable;
    if (deficit > 0) await this.waitFor((deficit / status.restoreRate) * 1000);
  }

  async run<T>(document: string, variables: Record<string, unknown>): Promise<T> {
    if (isWriteLikeGraphqlDocument(document)) {
      throw new LookupRefusal("upstream_error", UPSTREAM_MESSAGE, ["refused a write-like document"]);
    }
    for (let attempt = 0; ; attempt += 1) {
      if (this.requests >= this.limits.maxRequests) {
        throw new LookupRefusal("request_budget_exceeded", TOO_BIG_MESSAGE, [
          `reached ${this.limits.maxRequests} upstream requests`,
        ]);
      }
      if (this.remainingMs() <= 0) {
        throw new LookupRefusal("time_budget_exceeded", TOO_BIG_MESSAGE, [
          `reached ${this.limits.maxDurationMs}ms`,
        ]);
      }
      await this.pace();
      this.requests += 1;
      let response: ShopifyGraphqlResponse;
      try {
        response = await this.client.request(document, variables, {
          signal: AbortSignal.timeout(Math.max(1, this.remainingMs())),
        });
      } catch (error) {
        if (this.remainingMs() <= 0) {
          throw new LookupRefusal("time_budget_exceeded", TOO_BIG_MESSAGE, [
            `request aborted at the ${this.limits.maxDurationMs}ms deadline`,
          ]);
        }
        throw new LookupRefusal("upstream_error", UPSTREAM_MESSAGE, [cleanDetail(error)]);
      }
      if (!response || typeof response !== "object") {
        throw new LookupRefusal("unexpected_shape", SHAPE_MESSAGE, ["response body is not an object"]);
      }
      const cost = response.extensions?.cost ?? null;
      if (cost) {
        const actual = numberOrNull(cost.actualQueryCost);
        const requested = numberOrNull(cost.requestedQueryCost);
        this.costPoints += actual ?? requested ?? 0;
        this.lastRequestedCost = requested ?? actual ?? 0;
        const status = cost.throttleStatus;
        this.lastThrottle =
          status &&
          typeof status.currentlyAvailable === "number" &&
          typeof status.restoreRate === "number" &&
          typeof status.maximumAvailable === "number"
            ? status
            : null;
      }
      const errors = Array.isArray(response.errors) ? response.errors : [];
      const throttled = errors.some((error) => error?.extensions?.code === "THROTTLED");
      if (throttled) {
        if (attempt >= this.limits.maxThrottleRetries) {
          throw new LookupRefusal("throttled", THROTTLED_MESSAGE, [
            `still THROTTLED after ${this.limits.maxThrottleRetries} retries`,
          ]);
        }
        this.throttleRetries += 1;
        // pace() before the retry waits for the deficit; wait at least 1s so a
        // response without cost data still backs off.
        if (!this.lastThrottle || this.lastRequestedCost <= this.lastThrottle.currentlyAvailable) {
          await this.waitFor(1_000);
        }
        continue;
      }
      if (errors.length > 0) {
        throw new LookupRefusal(
          "upstream_error",
          UPSTREAM_MESSAGE,
          errors.slice(0, 3).map((error) => cleanDetail(error?.message ?? error?.extensions?.code ?? "GraphQL error")),
        );
      }
      if (!response.data || typeof response.data !== "object") {
        throw new LookupRefusal("unexpected_shape", SHAPE_MESSAGE, ["response has no data"]);
      }
      return response.data as T;
    }
  }

  audit(refusal: DataRefusal | null, invariantViolations: string[] = []): DataLookupAudit {
    return {
      upstreamRequests: this.requests,
      costPoints: Math.round(this.costPoints),
      durationMs: Math.max(0, this.elapsedMs()),
      throttleRetries: this.throttleRetries,
      warnings: [...this.warnings],
      refusalCode: refusal?.code ?? null,
      invariantViolations,
    };
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cleanDetail(value: unknown): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return redactKnownLeakedSecretPatterns(String(text)).slice(0, 300);
}

// ---------------------------------------------------------------------------
// Shape guards (fail closed on anything unexpected)
// ---------------------------------------------------------------------------

function shapeError(detail: string): LookupRefusal {
  return new LookupRefusal("unexpected_shape", SHAPE_MESSAGE, [detail]);
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw shapeError(`${where} is not an object`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw shapeError(`${where} is not a list`);
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string") throw shapeError(`${where} is not text`);
  return value;
}

function asDate(value: unknown, where: string): Date {
  const date = new Date(asString(value, where));
  if (Number.isNaN(date.getTime())) throw shapeError(`${where} is not a date`);
  return date;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

function asPageInfo(value: unknown, where: string): PageInfo {
  const info = asObject(value, where);
  if (typeof info.hasNextPage !== "boolean") throw shapeError(`${where}.hasNextPage missing`);
  const endCursor = info.endCursor === null || info.endCursor === undefined ? null : asString(info.endCursor, where);
  if (info.hasNextPage && !endCursor) throw shapeError(`${where} says more pages but gives no cursor`);
  return { hasNextPage: info.hasNextPage, endCursor };
}

// ---------------------------------------------------------------------------
// Ledger model
// ---------------------------------------------------------------------------

type ProductRef = { productType: string } | null; // null = product deleted

interface LedgerSale {
  actionType: string;
  lineType: string;
  typename: string;
  quantity: number | null;
  product: ProductRef;
}

interface LedgerAgreement {
  id: string;
  happenedAt: Date;
  sales: LedgerSale[];
}

interface LedgerRefund {
  id: string;
  createdAt: Date | null;
  lines: Array<{ quantity: number; product: ProductRef }>;
}

interface LedgerOrder {
  id: string;
  createdAt: Date;
  test: boolean;
  agreements: LedgerAgreement[];
  refunds: LedgerRefund[];
}

function parseProduct(lineItem: unknown, where: string): ProductRef {
  const item = asObject(lineItem, `${where}.lineItem`);
  if (item.product === null) return null;
  const product = asObject(item.product, `${where}.lineItem.product`);
  return { productType: asString(product.productType, `${where}.lineItem.product.productType`) };
}

function parseSale(raw: unknown, where: string): LedgerSale {
  const sale = asObject(raw, where);
  const typename = asString(sale.__typename, `${where}.__typename`);
  const quantity = sale.quantity === null ? null : sale.quantity;
  if (quantity !== null && (typeof quantity !== "number" || !Number.isInteger(quantity))) {
    throw shapeError(`${where}.quantity is not a whole number`);
  }
  return {
    typename,
    actionType: asString(sale.actionType, `${where}.actionType`),
    lineType: asString(sale.lineType, `${where}.lineType`),
    quantity: quantity as number | null,
    product: typename === "ProductSale" ? parseProduct(sale.lineItem, where) : null,
  };
}

function parseSalesConnection(raw: unknown, where: string): { sales: LedgerSale[]; pageInfo: PageInfo } {
  const connection = asObject(raw, where);
  return {
    sales: asArray(connection.nodes, `${where}.nodes`).map((node, index) => parseSale(node, `${where}[${index}]`)),
    pageInfo: asPageInfo(connection.pageInfo, `${where}.pageInfo`),
  };
}

function parseRefundLines(raw: unknown, where: string): { lines: LedgerRefund["lines"]; pageInfo: PageInfo } {
  const connection = asObject(raw, where);
  const lines = asArray(connection.nodes, `${where}.nodes`).map((node, index) => {
    const line = asObject(node, `${where}[${index}]`);
    if (typeof line.quantity !== "number" || !Number.isInteger(line.quantity)) {
      throw shapeError(`${where}[${index}].quantity is not a whole number`);
    }
    return { quantity: line.quantity, product: parseProduct(line.lineItem, `${where}[${index}]`) };
  });
  return { lines, pageInfo: asPageInfo(connection.pageInfo, `${where}.pageInfo`) };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface ShopifyAdapterOptions {
  client: ShopifyQueryClient;
  limits?: Partial<ShopifyLookupLimits>;
  clock?: Partial<ShopifyAdapterClock>;
}

export interface ShopifyCatalogOptions {
  /** Also scan the last 12 months of orders for units sold per type (costs more requests). */
  includeUnitsSold?: boolean;
  limits?: Partial<ShopifyLookupLimits>;
}

export interface ShopifySalesAdapter {
  sales(request: SalesRequest): Promise<DataLookupOutcome<SalesResult>>;
  catalog(options?: ShopifyCatalogOptions): Promise<DataLookupOutcome<CatalogResult>>;
}

interface ShopWindow {
  name: string;
  domain: string;
  timezone: string;
  earliestVisibleOrderAt: Date | null;
  /**
   * Whether the app holds read_all_orders. Without it Shopify hides orders
   * created more than 60 days ago, and with them every later return, edit
   * or cancellation on those orders, so no month can be counted completely.
   */
  hasAllOrdersAccess: boolean;
}

interface ResolvedPeriod {
  token: string;
  year: number;
  month: number;
  key: string;
  start: Date;
  nextStart: Date;
  running: boolean;
  future: boolean;
}

export function createShopifySalesAdapter(options: ShopifyAdapterOptions): ShopifySalesAdapter {
  const clock: ShopifyAdapterClock = { ...realClock, ...options.clock };
  const baseLimits: ShopifyLookupLimits = { ...DEFAULT_SHOPIFY_LOOKUP_LIMITS, ...options.limits };

  async function withRunner<T>(
    limits: ShopifyLookupLimits,
    body: (runner: LookupRunner) => Promise<T>,
  ): Promise<DataLookupOutcome<T>> {
    const runner = new LookupRunner(options.client, limits, clock);
    try {
      const result = await body(runner);
      return { ok: true, result, audit: runner.audit(null) };
    } catch (error) {
      const refusal =
        error instanceof LookupRefusal
          ? error.refusal
          : { code: "upstream_error" as const, message: UPSTREAM_MESSAGE, detail: [cleanDetail(error)] };
      const invariantViolations = refusal.code === "invariant_failed" ? (refusal.detail ?? []) : [];
      return { ok: false, refusal, audit: runner.audit(refusal, invariantViolations) };
    }
  }

  async function readShopWindow(runner: LookupRunner): Promise<ShopWindow> {
    const data = await runner.run<Record<string, unknown>>(SHOP_WINDOW_QUERY, {});
    const shop = asObject(data.shop, "shop");
    const timezone = asString(shop.ianaTimezone, "shop.ianaTimezone");
    try {
      assertValidTimeZone(timezone);
    } catch {
      throw shapeError(`unknown shop time zone ${timezone}`);
    }
    const scopes = asArray(
      asObject(data.currentAppInstallation, "currentAppInstallation").accessScopes,
      "currentAppInstallation.accessScopes",
    ).map((scope, index) => asString(asObject(scope, `accessScopes[${index}]`).handle, `accessScopes[${index}].handle`));
    const nodes = asArray(asObject(data.orders, "orders").nodes, "orders.nodes");
    const first = nodes.length > 0 ? asObject(nodes[0], "orders.nodes[0]") : null;
    return {
      name: asString(shop.name, "shop.name"),
      domain: asString(shop.myshopifyDomain, "shop.myshopifyDomain"),
      timezone,
      earliestVisibleOrderAt: first ? asDate(first.createdAt, "orders.nodes[0].createdAt") : null,
      hasAllOrdersAccess: scopes.includes("read_all_orders"),
    };
  }

  async function readProductTypes(runner: LookupRunner, limits: ShopifyLookupLimits): Promise<Set<string>> {
    const types = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const data: Record<string, unknown> = await runner.run(PRODUCT_TYPES_QUERY, {
        first: limits.productTypesPageSize,
        after,
      });
      if (data.productTypes === null) break;
      const connection = asObject(data.productTypes, "productTypes");
      for (const value of asArray(connection.nodes, "productTypes.nodes")) {
        const type = asString(value, "productTypes.nodes[]").trim();
        if (type) types.add(type);
      }
      const pageInfo = asPageInfo(connection.pageInfo, "productTypes.pageInfo");
      if (!pageInfo.hasNextPage) break;
      after = pageInfo.endCursor;
    }
    return types;
  }

  /** Every non-test order updated at or after `from`, with complete nested lists. */
  async function scanLedger(runner: LookupRunner, limits: ShopifyLookupLimits, from: Date): Promise<LedgerOrder[]> {
    const orders: LedgerOrder[] = [];
    const seen = new Set<string>();
    const query = `updated_at:>='${from.toISOString()}' AND test:false`;
    let after: string | null = null;
    for (;;) {
      const data: Record<string, unknown> = await runner.run(ORDERS_SCAN_QUERY, {
        first: limits.ordersPageSize,
        after,
        query,
        agreementsFirst: limits.agreementsPageSize,
        salesFirst: limits.salesPageSize,
        refundsFirst: limits.refundsPerOrder,
        refundLinesFirst: limits.refundLinesPageSize,
      });
      const connection = asObject(data.orders, "orders");
      const nodes = asArray(connection.nodes, "orders.nodes");
      for (let index = 0; index < nodes.length; index += 1) {
        const where = `orders[${index}]`;
        const raw = asObject(nodes[index], where);
        const id = asString(raw.id, `${where}.id`);
        if (typeof raw.test !== "boolean") throw shapeError(`${where}.test missing`);
        // An order updated again mid-scan can move to a later page and show up
        // twice; count it once (its latest copy has every agreement).
        const order: LedgerOrder = {
          id,
          createdAt: asDate(raw.createdAt, `${where}.createdAt`),
          test: raw.test === true,
          agreements: await readAgreements(runner, limits, id, raw.agreements, where),
          refunds: await readRefunds(runner, limits, id, raw.refunds, where),
        };
        if (seen.has(id)) {
          const existing = orders.findIndex((entry) => entry.id === id);
          orders[existing] = order;
        } else {
          seen.add(id);
          orders.push(order);
        }
      }
      const pageInfo = asPageInfo(connection.pageInfo, "orders.pageInfo");
      if (!pageInfo.hasNextPage) break;
      after = pageInfo.endCursor;
    }
    return orders;
  }

  async function readAgreements(
    runner: LookupRunner,
    limits: ShopifyLookupLimits,
    orderId: string,
    firstPage: unknown,
    where: string,
  ): Promise<LedgerAgreement[]> {
    const agreements: LedgerAgreement[] = [];
    let connection = asObject(firstPage, `${where}.agreements`);
    let pageAfter: string | null = null;
    for (;;) {
      const edges = asArray(connection.edges, `${where}.agreements.edges`);
      let previousCursor = pageAfter;
      for (let index = 0; index < edges.length; index += 1) {
        const edgeWhere = `${where}.agreements[${agreements.length}]`;
        const edge = asObject(edges[index], edgeWhere);
        const cursor = asString(edge.cursor, `${edgeWhere}.cursor`);
        const node = asObject(edge.node, `${edgeWhere}.node`);
        const agreementId = asString(node.id, `${edgeWhere}.id`);
        const firstSales = parseSalesConnection(node.sales, `${edgeWhere}.sales`);
        const sales = [...firstSales.sales];
        let salesPage = firstSales.pageInfo;
        while (salesPage.hasNextPage) {
          const data: Record<string, unknown> = await runner.run(AGREEMENT_SALES_QUERY, {
            id: orderId,
            agreementAfter: previousCursor,
            salesFirst: limits.salesFollowUpPageSize,
            salesAfter: salesPage.endCursor,
          });
          const order = asObject(data.order, `${edgeWhere} follow-up order`);
          const followEdges = asArray(
            asObject(order.agreements, `${edgeWhere} follow-up agreements`).edges,
            `${edgeWhere} follow-up edges`,
          );
          const followNode = asObject(asObject(followEdges[0], `${edgeWhere} follow-up edge`).node, `${edgeWhere} follow-up node`);
          if (followNode.id !== agreementId) throw shapeError(`${edgeWhere} follow-up returned another agreement`);
          const next = parseSalesConnection(followNode.sales, `${edgeWhere} follow-up sales`);
          sales.push(...next.sales);
          salesPage = next.pageInfo;
        }
        agreements.push({ id: agreementId, happenedAt: asDate(node.happenedAt, `${edgeWhere}.happenedAt`), sales });
        previousCursor = cursor;
      }
      const pageInfo = asPageInfo(connection.pageInfo, `${where}.agreements.pageInfo`);
      if (!pageInfo.hasNextPage) break;
      pageAfter = pageInfo.endCursor;
      const data: Record<string, unknown> = await runner.run(ORDER_AGREEMENTS_QUERY, {
        id: orderId,
        after: pageAfter,
        agreementsFirst: limits.agreementsPageSize,
        salesFirst: limits.salesPageSize,
      });
      connection = asObject(asObject(data.order, `${where} agreements follow-up order`).agreements, `${where}.agreements`);
    }
    return agreements;
  }

  async function readRefunds(
    runner: LookupRunner,
    limits: ShopifyLookupLimits,
    orderId: string,
    firstList: unknown,
    where: string,
  ): Promise<LedgerRefund[]> {
    let list = asArray(firstList, `${where}.refunds`);
    if (list.length >= limits.refundsPerOrder) {
      const data: Record<string, unknown> = await runner.run(ORDER_REFUNDS_QUERY, {
        id: orderId,
        refundLinesFirst: limits.refundLinesPageSize,
      });
      list = asArray(asObject(data.order, `${where} refunds follow-up order`).refunds, `${where}.refunds`);
    }
    const refunds: LedgerRefund[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const refundWhere = `${where}.refunds[${index}]`;
      const raw = asObject(list[index], refundWhere);
      const refundId = asString(raw.id, `${refundWhere}.id`);
      const first = parseRefundLines(raw.refundLineItems, `${refundWhere}.refundLineItems`);
      const lines = [...first.lines];
      let page = first.pageInfo;
      while (page.hasNextPage) {
        const data: Record<string, unknown> = await runner.run(REFUND_LINE_ITEMS_QUERY, {
          id: refundId,
          after: page.endCursor,
          refundLinesFirst: limits.salesFollowUpPageSize,
        });
        const node = asObject(data.node, `${refundWhere} follow-up`);
        if (node.id !== refundId) throw shapeError(`${refundWhere} follow-up returned another refund`);
        const next = parseRefundLines(node.refundLineItems, `${refundWhere} follow-up lines`);
        lines.push(...next.lines);
        page = next.pageInfo;
      }
      refunds.push({
        id: refundId,
        createdAt: raw.createdAt === null ? null : asDate(raw.createdAt, `${refundWhere}.createdAt`),
        lines,
      });
    }
    return refunds;
  }

  function resolvePeriods(tokens: string[], now: Date, timezone: string): ResolvedPeriod[] {
    const today = zonedParts(now, timezone);
    const resolved = tokens.map((token): ResolvedPeriod => {
      let ym: { year: number; month: number } | null;
      if (token === "last_month") ym = addMonths(today.year, today.month, -1);
      else if (token === "month_before_last") ym = addMonths(today.year, today.month, -2);
      else if (token === "this_month_to_date") ym = { year: today.year, month: today.month };
      else ym = parseMonthKey(token);
      if (!ym) {
        throw new LookupRefusal("invalid_period", `I do not understand the period "${token}". Use a month, for example 2026-07.`);
      }
      const next = addMonths(ym.year, ym.month, 1);
      const start = zonedMonthStart(ym.year, ym.month, timezone);
      const nextStart = zonedMonthStart(next.year, next.month, timezone);
      return {
        token,
        year: ym.year,
        month: ym.month,
        key: monthKey(ym.year, ym.month),
        start,
        nextStart,
        future: start.getTime() > now.getTime(),
        running: start.getTime() <= now.getTime() && now.getTime() < nextStart.getTime(),
      };
    });
    const keys = new Set(resolved.map((period) => period.key));
    if (keys.size !== resolved.length) {
      throw new LookupRefusal("invalid_request", "The two periods are the same month. Choose two different months.");
    }
    return resolved.sort((a, b) => a.start.getTime() - b.start.getTime());
  }

  function periodLabel(period: ResolvedPeriod): string {
    return `${NORWEGIAN_MONTHS[period.month - 1]} ${period.year}`;
  }

  async function sales(request: SalesRequest): Promise<DataLookupOutcome<SalesResult>> {
    return withRunner(baseLimits, async (runner) => {
      const parsed = salesRequestSchema.safeParse(request);
      if (!parsed.success) {
        const measure = (request as { measure?: unknown })?.measure;
        if (Array.isArray(measure) && measure.every((entry) => typeof entry === "string") && isKronerOnlyRefusal(measure)) {
          throw new LookupRefusal("kroner_not_enabled", KRONER_NOT_ENABLED_MESSAGE);
        }
        throw new LookupRefusal(
          "invalid_request",
          "The question could not be turned into a valid lookup (at most two months, given as months).",
          parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        );
      }
      const input = parsed.data;
      // Refused BEFORE any upstream request: kroner is not verified yet.
      if (isKronerOnlyRefusal(input.measure)) {
        throw new LookupRefusal("kroner_not_enabled", KRONER_NOT_ENABLED_MESSAGE);
      }
      const requestedTypes = input.productTypes
        ? [...new Set(input.productTypes.map((type) => type.trim()).filter(Boolean))]
        : null;
      if (requestedTypes && requestedTypes.length === 0) {
        throw new LookupRefusal("invalid_request", "No product type was given.");
      }

      const shop = await readShopWindow(runner);
      const asOf = clock.now();
      const periods = resolvePeriods(input.periods, asOf, shop.timezone);

      const scanned = periods.filter((period) => !period.future);
      if (scanned.length > 0) {
        if (!shop.hasAllOrdersAccess) {
          throw new LookupRefusal(
            "missing_order_history_access",
            MISSING_ORDER_HISTORY_MESSAGE,
            ["app installation lacks the read_all_orders access scope"],
          );
        }
        if (!shop.earliestVisibleOrderAt) {
          throw new LookupRefusal(
            "no_visible_orders",
            `Shopify shows no orders for the online store ${shop.domain}, so I have no figures to give. That does not mean sales were zero.`,
          );
        }
        const tooEarly = scanned.find((period) => period.start.getTime() < shop.earliestVisibleOrderAt!.getTime());
        if (tooEarly) {
          throw new LookupRefusal(
            "before_visible_window",
            `Shopify lar meg bare se ordre fra og med ${formatZonedDate(shop.earliestVisibleOrderAt, shop.timezone)}, så jeg kan ikke gi tall for ${periodLabel(tooEarly)}. Det betyr ikke at salget var null.`,
            [`period ${tooEarly.key} starts ${tooEarly.start.toISOString()}, earliest visible order ${shop.earliestVisibleOrderAt.toISOString()}`],
          );
        }
      }

      if (requestedTypes) {
        const catalogTypes = await readProductTypes(runner, baseLimits);
        const unknown = requestedTypes.filter((type) => !catalogTypes.has(type));
        if (unknown.length > 0) {
          const nearest = nearestValues(unknown[0]!, [...catalogTypes], 3);
          throw new LookupRefusal(
            "unknown_product_type",
            `The product type "${unknown[0]}" does not exist in the Shopify catalog.${nearest.length > 0 ? ` Nearest: ${nearest.join(", ")}.` : ""}`,
            unknown.map((type) => `unknown product type ${type}`),
          );
        }
      }

      const ledger =
        scanned.length > 0 ? await scanLedger(runner, baseLimits, scanned[0]!.start) : ([] as LedgerOrder[]);

      const aggregate = aggregateLedger(ledger, scanned, shop.timezone, asOf, runner.warnings);

      const resultPeriods: SalesPeriod[] = periods.map((period) => {
        const statusText = period.running ? `pågår, per ${formatZonedDateTime(asOf, shop.timezone)}` : "avsluttet";
        const end = period.running || period.future ? asOf : period.nextStart;
        const base = {
          key: period.key,
          token: period.token,
          label: periodLabel(period),
          start: period.start.toISOString(),
          end: (period.future ? period.start : end).toISOString(),
          status: (period.running || period.future ? "pågår" : "avsluttet") as SalesPeriod["status"],
          statusText: period.future ? "ikke startet" : statusText,
        };
        if (period.future) {
          return {
            ...base,
            dataState: "no_data" as const,
            noDataReason: "Perioden har ikke startet ennå.",
            total: null,
            selection: null,
            byProductType: [],
            otherProductTypes: null,
            untyped: null,
            deletedProduct: null,
          };
        }
        const buckets = aggregate.get(period.key) ?? new Map<string, SalesLines>();
        return { ...base, ...shapePeriodBuckets(buckets, requestedTypes, input.groupBy) };
      });

      const comparison = buildComparison(resultPeriods, requestedTypes ? "selection" : "total");
      const candidate: SalesResult = {
        kind: "sales",
        source: "shopify",
        store: shop.domain,
        storeName: shop.name,
        asOf: asOf.toISOString(),
        timezone: shop.timezone,
        measure: "units",
        groupBy: input.groupBy,
        productTypesCounted: requestedTypes,
        definitions: [...SALES_DEFINITIONS_NB],
        periods: resultPeriods,
        comparison,
      };
      const result = salesResultSchema.parse(candidate);
      const violations = checkSalesInvariants(result);
      if (violations.length > 0) {
        throw new LookupRefusal("invariant_failed", INVARIANT_MESSAGE, violations);
      }
      return result;
    });
  }

  async function catalog(catalogOptions: ShopifyCatalogOptions = {}): Promise<DataLookupOutcome<CatalogResult>> {
    const limits = { ...baseLimits, ...catalogOptions.limits };
    return withRunner(limits, async (runner) => {
      const shop = await readShopWindow(runner);
      const counts = new Map<string, number>();
      let untypedProducts = 0;
      let after: string | null = null;
      for (;;) {
        const data: Record<string, unknown> = await runner.run(PRODUCTS_PAGE_QUERY, {
          first: limits.productsPageSize,
          after,
        });
        const connection = asObject(data.products, "products");
        for (const [index, node] of asArray(connection.nodes, "products.nodes").entries()) {
          const type = asString(asObject(node, `products[${index}]`).productType, `products[${index}].productType`).trim();
          if (!type) untypedProducts += 1;
          else counts.set(type, (counts.get(type) ?? 0) + 1);
        }
        const pageInfo = asPageInfo(connection.pageInfo, "products.pageInfo");
        if (!pageInfo.hasNextPage) break;
        after = pageInfo.endCursor;
      }

      const asOf = clock.now();
      let unitsStatus = "ikke beregnet (ikke bedt om)";
      let unitsByType: Map<string, number> | null = null;
      let untypedUnits: number | null = null;
      let deletedUnits: number | null = null;
      if (catalogOptions.includeUnitsSold) {
        const from = new Date(asOf.getTime() - 365 * 24 * 60 * 60 * 1000);
        if (!shop.hasAllOrdersAccess) {
          unitsStatus = "ikke beregnet: Shopify-tilkoblingen mangler tilgang til eldre ordre";
        } else if (!shop.earliestVisibleOrderAt || shop.earliestVisibleOrderAt.getTime() > from.getTime()) {
          unitsStatus = shop.earliestVisibleOrderAt
            ? `ikke beregnet: Shopify viser bare ordre fra og med ${formatZonedDate(shop.earliestVisibleOrderAt, shop.timezone)}`
            : "ikke beregnet: Shopify viser ingen ordre";
        } else {
          try {
            const ledger = await scanLedger(runner, limits, from);
            unitsByType = new Map();
            untypedUnits = 0;
            deletedUnits = 0;
            for (const order of ledger) {
              if (order.test) continue;
              for (const agreement of order.agreements) {
                if (agreement.happenedAt.getTime() < from.getTime()) continue;
                for (const sale of agreement.sales) {
                  if (sale.lineType !== "PRODUCT" || sale.actionType !== "ORDER") continue;
                  const quantity = Math.max(0, sale.quantity ?? 0);
                  if (!sale.product) deletedUnits += quantity;
                  else if (!sale.product.productType.trim()) untypedUnits += quantity;
                  else {
                    const type = sale.product.productType.trim();
                    unitsByType.set(type, (unitsByType.get(type) ?? 0) + quantity);
                  }
                }
              }
            }
            unitsStatus = "beregnet";
          } catch (error) {
            if (
              error instanceof LookupRefusal &&
              (error.refusal.code === "request_budget_exceeded" || error.refusal.code === "time_budget_exceeded")
            ) {
              // Complete or nothing for this column: no partial units sold.
              unitsByType = null;
              untypedUnits = null;
              deletedUnits = null;
              unitsStatus = "ikke beregnet: for mange ordre å gå gjennom i ett oppslag";
              runner.warnings.push(`catalog units sold skipped: ${error.refusal.detail?.join("; ") ?? error.refusal.code}`);
            } else {
              throw error;
            }
          }
        }
      }

      const allTypes = new Set([...counts.keys(), ...(unitsByType?.keys() ?? [])]);
      const productTypes: CatalogEntry[] = [...allTypes]
        .sort((a, b) => a.localeCompare(b, "nb"))
        .map((productType) => ({
          productType,
          productCount: counts.get(productType) ?? 0,
          unitsSoldLast12Months: unitsByType ? (unitsByType.get(productType) ?? 0) : null,
        }));
      return catalogResultSchema.parse({
        kind: "catalog",
        source: "shopify",
        store: shop.domain,
        storeName: shop.name,
        asOf: asOf.toISOString(),
        timezone: shop.timezone,
        productTypes,
        untypedProductCount: untypedProducts,
        untypedUnitsSoldLast12Months: untypedUnits,
        deletedProductUnitsSoldLast12Months: deletedUnits,
        unitsSoldStatus: unitsStatus,
        earliestVisibleOrderAt: shop.earliestVisibleOrderAt?.toISOString() ?? null,
      });
    });
  }

  return { sales, catalog };
}

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

const UNTYPED_KEY = "\u0000untyped";
const DELETED_KEY = "\u0000deleted";

function bucketKeyFor(product: ProductRef): string {
  if (!product) return DELETED_KEY;
  const type = product.productType.trim();
  return type ? type : UNTYPED_KEY;
}

/**
 * Place every PRODUCT sale in the shop-zone month of its agreement. Also runs
 * the refunds-based second count and pushes any disagreement into `warnings`.
 */
function aggregateLedger(
  ledger: LedgerOrder[],
  periods: ResolvedPeriod[],
  timezone: string,
  asOf: Date,
  warnings: string[],
): Map<string, Map<string, SalesLines>> {
  const wanted = new Set(periods.map((period) => period.key));
  const result = new Map<string, Map<string, SalesLines>>();
  const refundCount = new Map<string, Map<string, number>>();
  for (const key of wanted) {
    result.set(key, new Map());
    refundCount.set(key, new Map());
  }
  const lines = (month: string, bucket: string) => {
    const monthMap = result.get(month)!;
    let entry = monthMap.get(bucket);
    if (!entry) {
      entry = emptyLines();
      monthMap.set(bucket, entry);
    }
    return entry;
  };

  for (const order of ledger) {
    if (order.test) continue; // belt and braces: the scan already asks for test:false
    const orderMonth = zonedMonthKey(order.createdAt, timezone);
    for (const agreement of order.agreements) {
      if (agreement.happenedAt.getTime() > asOf.getTime()) continue;
      const month = zonedMonthKey(agreement.happenedAt, timezone);
      if (!wanted.has(month)) continue;
      for (const sale of agreement.sales) {
        if (sale.lineType !== "PRODUCT") continue;
        if (sale.typename !== "ProductSale") {
          throw shapeError(`PRODUCT line of type ${sale.typename} on agreement ${agreement.id}`);
        }
        const quantity = sale.quantity ?? 0; // a money-only line carries no units
        const entry = lines(month, bucketKeyFor(sale.product));
        switch (sale.actionType) {
          case "ORDER":
            if (quantity < 0) throw shapeError(`ORDER sale with negative quantity on agreement ${agreement.id}`);
            entry.sold += quantity;
            entry.net += quantity;
            break;
          case "RETURN": {
            if (quantity > 0) throw shapeError(`RETURN sale with positive quantity on agreement ${agreement.id}`);
            const returned = -quantity;
            entry.returnsInPeriod += returned;
            entry.net -= returned;
            if (orderMonth < month) entry.returnsFromEarlierPeriods += returned;
            break;
          }
          case "UPDATE":
            entry.edits += quantity;
            entry.net += quantity;
            break;
          default:
            throw shapeError(`sale action ${sale.actionType} on agreement ${agreement.id}`);
        }
      }
    }
    for (const refund of order.refunds) {
      if (!refund.createdAt || refund.createdAt.getTime() > asOf.getTime()) continue;
      const month = zonedMonthKey(refund.createdAt, timezone);
      if (!wanted.has(month)) continue;
      const monthCounts = refundCount.get(month)!;
      for (const line of refund.lines) {
        const bucket = bucketKeyFor(line.product);
        monthCounts.set(bucket, (monthCounts.get(bucket) ?? 0) + line.quantity);
      }
    }
  }

  // Second way of counting returns: refunds vs the ledger. Warn, never refuse.
  for (const month of wanted) {
    const ledgerMonth = result.get(month)!;
    const refundMonth = refundCount.get(month)!;
    const buckets = new Set([...ledgerMonth.keys(), ...refundMonth.keys()]);
    let ledgerTotal = 0;
    let refundTotal = 0;
    for (const bucket of buckets) {
      const fromLedger = ledgerMonth.get(bucket)?.returnsInPeriod ?? 0;
      const fromRefunds = refundMonth.get(bucket) ?? 0;
      ledgerTotal += fromLedger;
      refundTotal += fromRefunds;
      if (fromLedger !== fromRefunds) {
        warnings.push(
          `refunds_cross_check ${month} ${displayBucket(bucket)}: ledger returns ${fromLedger}, refund lines ${fromRefunds}`,
        );
      }
    }
    if (ledgerTotal !== refundTotal) {
      warnings.push(`refunds_cross_check ${month} total: ledger returns ${ledgerTotal}, refund lines ${refundTotal}`);
    }
  }
  return result;
}

function displayBucket(key: string): string {
  if (key === UNTYPED_KEY) return UNTYPED_BUCKET_LABEL;
  if (key === DELETED_KEY) return DELETED_PRODUCT_BUCKET_LABEL;
  return key;
}

function shapePeriodBuckets(
  buckets: Map<string, SalesLines>,
  requestedTypes: string[] | null,
  groupBy: "none" | "product_type",
): Pick<
  SalesPeriod,
  "dataState" | "noDataReason" | "total" | "selection" | "byProductType" | "otherProductTypes" | "untyped" | "deletedProduct"
> {
  const typed = [...buckets.entries()].filter(([key]) => key !== UNTYPED_KEY && key !== DELETED_KEY);
  const listed = new Set<string>();
  if (groupBy === "product_type") for (const [key] of typed) listed.add(key);
  for (const type of requestedTypes ?? []) listed.add(type);

  const byProductType: ProductTypeBucket[] = [...listed]
    .sort((a, b) => a.localeCompare(b, "nb"))
    .map((productType) => ({ productType, lines: { ...(buckets.get(productType) ?? emptyLines()) } }));
  let other = emptyLines();
  for (const [key, value] of typed) if (!listed.has(key)) other = addLines(other, value);
  const untyped = { ...(buckets.get(UNTYPED_KEY) ?? emptyLines()) };
  const deletedProduct = { ...(buckets.get(DELETED_KEY) ?? emptyLines()) };
  let total = addLines(addLines(other, untyped), deletedProduct);
  for (const bucket of byProductType) total = addLines(total, bucket.lines);

  let selection: SalesLines | null = null;
  if (requestedTypes) {
    selection = emptyLines();
    for (const type of requestedTypes) selection = addLines(selection, buckets.get(type) ?? emptyLines());
  }
  return {
    dataState: "data",
    noDataReason: null,
    total,
    selection,
    byProductType,
    otherProductTypes: other,
    untyped,
    deletedProduct,
  };
}

function buildComparison(periods: SalesPeriod[], basis: "selection" | "total"): SalesComparison | null {
  if (periods.length !== 2) return null;
  const [from, to] = periods as [SalesPeriod, SalesPeriod];
  const fromLines = basis === "selection" ? from.selection : from.total;
  const toLines = basis === "selection" ? to.selection : to.total;
  if (!fromLines || !toLines) return null;
  return {
    fromKey: from.key,
    toKey: to.key,
    basis,
    netChange: toLines.net - fromLines.net,
    netChangePercent: computeChangePercent(fromLines.net, toLines.net),
  };
}

// ---------------------------------------------------------------------------
// Nearest catalog values for an unknown product type
// ---------------------------------------------------------------------------

export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/å/gi, "a")
    .toLowerCase()
    .trim();
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = saved;
    }
  }
  return previous[b.length]!;
}

export function nearestValues(query: string, candidates: string[], limit: number): string[] {
  const needle = normalizeForMatch(query);
  return candidates
    .map((candidate) => {
      const normalized = normalizeForMatch(candidate);
      const contains = normalized.includes(needle) || needle.includes(normalized);
      return { candidate, score: (contains ? 0 : 1000) + editDistance(needle, normalized) };
    })
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate, "nb"))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
