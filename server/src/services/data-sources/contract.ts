import { z } from "zod";

/**
 * DUR-3972 S3: the business-data contract.
 *
 * Every data source (Shopify now, the Nordstrand dashboard later) answers in
 * exactly this shape, so the quick-agent tool, the answer card and the audit
 * row never care where the numbers came from. Parsing is strict about types
 * and lenient about extras: unknown fields are DROPPED (zod's default strip),
 * so a source can never smuggle free text or extra numbers past the contract.
 *
 * First release: units only. A request for any kroner measure is refused with
 * a plain sentence (see `KRONER_NOT_ENABLED_MESSAGE`) until kroner has its own
 * reconciliation against Shopify Analytics.
 */

/** Every source kind a result may name. Mirrors DATA_CONNECTION_KINDS in @paperclipai/shared. */
export const DATA_SOURCE_KINDS = ["shopify", "woocommerce", "fiken", "sftp_file"] as const;
export type DataSourceKind = (typeof DATA_SOURCE_KINDS)[number];

/**
 * The base of every "the source answered badly" error a client throws. Its
 * message is a plain sentence that is safe to show a person: every client
 * scrubs its own credential values out before throwing. Callers that do not
 * care which source failed test `instanceof DataSourceUpstreamError`.
 */
export class DataSourceUpstreamError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DataSourceUpstreamError";
    this.code = code;
  }
}

/** The only measure answered in this release. */
export const SALES_MEASURES = ["units"] as const;
export type SalesMeasure = (typeof SALES_MEASURES)[number];

export const PERIOD_TOKEN_KEYWORDS = ["last_month", "month_before_last", "this_month_to_date"] as const;
/** A period is ALWAYS a token the server resolves; the model never supplies free dates. */
export const periodTokenSchema = z.union([
  z.enum(PERIOD_TOKEN_KEYWORDS),
  z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM"),
]);
export type PeriodToken = z.infer<typeof periodTokenSchema>;

export const SALES_GROUP_BY = ["none", "product_type"] as const;

export const salesRequestSchema = z.object({
  periods: z.array(periodTokenSchema).min(1).max(2),
  /** Must be ["units"]. Anything else is refused, never silently ignored. */
  measure: z.array(z.string()).default(["units"]),
  /** Exact catalog product types (already resolved from the user's words). Omit for all products. */
  productTypes: z.array(z.string().min(1).max(255)).max(50).optional(),
  groupBy: z.enum(SALES_GROUP_BY).default("none"),
});
export type SalesRequest = z.input<typeof salesRequestSchema>;
export type NormalizedSalesRequest = z.output<typeof salesRequestSchema>;

/** Buckets that are never a real product type. */
export const UNTYPED_BUCKET_LABEL = "(without product type)";
export const DELETED_PRODUCT_BUCKET_LABEL = "(deleted product)";

const int = () => z.number().int();
const nonNegativeInt = () => z.number().int().nonnegative();

/** The three-line answer (plus edits). All in units. */
export const salesLinesSchema = z.object({
  /** Units on new orders placed in the period (before returns). */
  sold: nonNegativeInt(),
  /** Units returned in the period, whatever month the order was placed. */
  returnsInPeriod: nonNegativeInt(),
  /** Part of `returnsInPeriod` whose order was created in an earlier month. */
  returnsFromEarlierPeriods: nonNegativeInt(),
  /** Net unit change from order edits in the period (can be negative). */
  edits: int(),
  /** sold - returnsInPeriod + edits. */
  net: int(),
});
export type SalesLines = z.infer<typeof salesLinesSchema>;

export const productTypeBucketSchema = z.object({
  productType: z.string(),
  lines: salesLinesSchema,
});
export type ProductTypeBucket = z.infer<typeof productTypeBucketSchema>;

export const PERIOD_STATUSES = ["closed", "running"] as const;

export const salesPeriodSchema = z.object({
  key: z.string().regex(/^\d{4}-\d{2}$/),
  /** The token the caller asked for, e.g. "last_month". */
  token: z.string(),
  /** "July 2026". */
  label: z.string(),
  /** Inclusive start (UTC ISO) of the month in the shop's zone. */
  start: z.string(),
  /** Exclusive end (UTC ISO): the next month's start, or `asOf` while the month is running. */
  end: z.string(),
  status: z.enum(PERIOD_STATUSES),
  /** "closed", "running, as of 21.09.2026 at 10:14", or "not started". */
  statusText: z.string(),
  /** `no_data` is NEVER zero: numbers are null and `noDataReason` says why. */
  dataState: z.enum(["data", "no_data"]),
  noDataReason: z.string().nullable(),
  /** Every product line in the shop (all types, untyped and deleted included). */
  total: salesLinesSchema.nullable(),
  /** Sum of the requested product types; null when no filter was given. */
  selection: salesLinesSchema.nullable(),
  /** The requested types (filter) or every type (group_by product_type). */
  byProductType: z.array(productTypeBucketSchema),
  /** All typed products not listed in `byProductType`. */
  otherProductTypes: salesLinesSchema.nullable(),
  untyped: salesLinesSchema.nullable(),
  deletedProduct: salesLinesSchema.nullable(),
});
export type SalesPeriod = z.infer<typeof salesPeriodSchema>;

export const salesComparisonSchema = z.object({
  /** Period keys: change FROM the earlier TO the later period. */
  fromKey: z.string(),
  toKey: z.string(),
  /** What is compared: the selection when filtered, otherwise the shop total. */
  basis: z.enum(["selection", "total"]),
  netChange: int(),
  /** Rounded to one decimal; null when the earlier net is 0 (no meaningful percentage). */
  netChangePercent: z.number().nullable(),
});
export type SalesComparison = z.infer<typeof salesComparisonSchema>;

export const salesResultSchema = z.object({
  kind: z.literal("sales"),
  source: z.enum(DATA_SOURCE_KINDS),
  /** Shop address, e.g. "nordstrand.myshopify.com". */
  store: z.string(),
  storeName: z.string(),
  asOf: z.string(),
  timezone: z.string(),
  measure: z.enum(SALES_MEASURES),
  groupBy: z.enum(SALES_GROUP_BY),
  /** Exact product types counted in `selection`; null = no filter (all products). */
  productTypesCounted: z.array(z.string()).nullable(),
  /** The fixed definitions printed with every answer. */
  definitions: z.array(z.string()),
  periods: z.array(salesPeriodSchema).min(1).max(2),
  comparison: salesComparisonSchema.nullable(),
});
export type SalesResult = z.infer<typeof salesResultSchema>;

export const catalogEntrySchema = z.object({
  productType: z.string(),
  productCount: nonNegativeInt(),
  /** Units on orders placed in the last 12 months (before returns); null when not calculated. */
  unitsSoldLast12Months: nonNegativeInt().nullable(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const catalogResultSchema = z.object({
  kind: z.literal("catalog"),
  source: z.enum(DATA_SOURCE_KINDS),
  store: z.string(),
  storeName: z.string(),
  asOf: z.string(),
  timezone: z.string(),
  /** Real product types only; untyped products are counted separately. */
  productTypes: z.array(catalogEntrySchema),
  untypedProductCount: nonNegativeInt(),
  untypedUnitsSoldLast12Months: nonNegativeInt().nullable(),
  /** Units on lines whose product has since been deleted; null when not calculated. */
  deletedProductUnitsSoldLast12Months: nonNegativeInt().nullable(),
  /** "calculated" or a plain reason why units sold were not calculated. */
  unitsSoldStatus: z.string(),
  /** Earliest order Shopify lets us see (UTC ISO); null when there are no orders at all. */
  earliestVisibleOrderAt: z.string().nullable(),
});
export type CatalogResult = z.infer<typeof catalogResultSchema>;

export const KRONER_NOT_ENABLED_MESSAGE =
  "Amounts in kroner are not switched on yet. For now I can only answer in number of units, not in kroner.";

/** Plain refusals. `message` is shown to the person word for word. */
export const DATA_REFUSAL_CODES = [
  "kroner_not_enabled",
  "invalid_request",
  "invalid_period",
  "before_visible_window",
  "missing_order_history_access",
  "no_visible_orders",
  "unknown_product_type",
  "request_budget_exceeded",
  "time_budget_exceeded",
  "throttled",
  "upstream_error",
  "unexpected_shape",
  "invariant_failed",
] as const;
export type DataRefusalCode = (typeof DATA_REFUSAL_CODES)[number];

export interface DataRefusal {
  code: DataRefusalCode;
  message: string;
  /** Machine detail for the audit row (never shown to the model). */
  detail?: string[];
}

/** What S4 writes into data_read_events for every lookup, including refusals. */
export interface DataLookupAudit {
  upstreamRequests: number;
  /** Sum of Shopify `actualQueryCost` (falls back to requested cost when actual is missing). */
  costPoints: number;
  durationMs: number;
  throttleRetries: number;
  /** Non-blocking findings, e.g. the refunds cross-check disagreeing with the ledger. */
  warnings: string[];
  refusalCode: DataRefusalCode | null;
  /** Failed invariant checks (only on `invariant_failed`). */
  invariantViolations: string[];
}

export type DataLookupOutcome<T> =
  | { ok: true; result: T; audit: DataLookupAudit }
  | { ok: false; refusal: DataRefusal; audit: DataLookupAudit };

export function isKronerOnlyRefusal(measure: readonly string[]): boolean {
  return measure.length === 0 || measure.some((entry) => entry !== "units");
}

const ZERO_LINES: SalesLines = { sold: 0, returnsInPeriod: 0, returnsFromEarlierPeriods: 0, edits: 0, net: 0 };

export function emptyLines(): SalesLines {
  return { ...ZERO_LINES };
}

export function addLines(a: SalesLines, b: SalesLines): SalesLines {
  return {
    sold: a.sold + b.sold,
    returnsInPeriod: a.returnsInPeriod + b.returnsInPeriod,
    returnsFromEarlierPeriods: a.returnsFromEarlierPeriods + b.returnsFromEarlierPeriods,
    edits: a.edits + b.edits,
    net: a.net + b.net,
  };
}

function linesEqual(a: SalesLines, b: SalesLines): boolean {
  return (
    a.sold === b.sold &&
    a.returnsInPeriod === b.returnsInPeriod &&
    a.returnsFromEarlierPeriods === b.returnsFromEarlierPeriods &&
    a.edits === b.edits &&
    a.net === b.net
  );
}

function describeLines(lines: SalesLines): string {
  return `sold=${lines.sold} returns=${lines.returnsInPeriod} earlier=${lines.returnsFromEarlierPeriods} edits=${lines.edits} net=${lines.net}`;
}

/**
 * The consistency checks run on EVERY sales result (by the adapter, and again
 * by S4's query service before anything reaches the model). Returns the list
 * of violations; an empty list means the result may be shown.
 */
export function checkSalesInvariants(result: SalesResult): string[] {
  const violations: string[] = [];
  const checkLines = (where: string, lines: SalesLines) => {
    if (lines.sold - lines.returnsInPeriod + lines.edits !== lines.net) {
      violations.push(`${where}: sold - returns + edits != net (${describeLines(lines)})`);
    }
    if (lines.returnsFromEarlierPeriods > lines.returnsInPeriod) {
      violations.push(`${where}: returns from earlier periods exceed returns (${describeLines(lines)})`);
    }
    if (lines.sold < 0 || lines.returnsInPeriod < 0 || lines.returnsFromEarlierPeriods < 0) {
      violations.push(`${where}: negative count (${describeLines(lines)})`);
    }
  };

  const counted = result.productTypesCounted;
  for (const period of result.periods) {
    const at = `period ${period.key}`;
    const numberFields = [
      period.total,
      period.selection,
      period.otherProductTypes,
      period.untyped,
      period.deletedProduct,
    ];
    if (period.dataState === "no_data") {
      if (numberFields.some((value) => value !== null) || period.byProductType.length > 0) {
        violations.push(`${at}: no_data period carries numbers`);
      }
      if (!period.noDataReason) violations.push(`${at}: no_data period without a reason`);
      continue;
    }
    if (!period.total || !period.otherProductTypes || !period.untyped || !period.deletedProduct) {
      violations.push(`${at}: data period is missing a bucket`);
      continue;
    }
    checkLines(`${at} total`, period.total);
    checkLines(`${at} other types`, period.otherProductTypes);
    checkLines(`${at} ${UNTYPED_BUCKET_LABEL}`, period.untyped);
    checkLines(`${at} ${DELETED_PRODUCT_BUCKET_LABEL}`, period.deletedProduct);
    const seen = new Set<string>();
    let bucketSum = addLines(addLines(period.otherProductTypes, period.untyped), period.deletedProduct);
    for (const bucket of period.byProductType) {
      if (seen.has(bucket.productType)) violations.push(`${at}: product type listed twice (${bucket.productType})`);
      seen.add(bucket.productType);
      checkLines(`${at} type ${bucket.productType}`, bucket.lines);
      bucketSum = addLines(bucketSum, bucket.lines);
    }
    if (!linesEqual(bucketSum, period.total)) {
      violations.push(
        `${at}: product-type buckets do not add up to the total (buckets ${describeLines(bucketSum)} vs total ${describeLines(period.total)})`,
      );
    }
    if (counted) {
      if (!period.selection) {
        violations.push(`${at}: filtered result without a selection`);
      } else {
        checkLines(`${at} selection`, period.selection);
        let selectionSum = emptyLines();
        for (const type of counted) {
          const bucket = period.byProductType.find((entry) => entry.productType === type);
          if (!bucket) violations.push(`${at}: counted type ${type} has no bucket`);
          else selectionSum = addLines(selectionSum, bucket.lines);
        }
        if (!linesEqual(selectionSum, period.selection)) {
          violations.push(`${at}: selection is not the sum of the counted types`);
        }
      }
    } else if (period.selection !== null) {
      violations.push(`${at}: unfiltered result carries a selection`);
    }
  }

  if (result.comparison) {
    const from = result.periods.find((period) => period.key === result.comparison!.fromKey);
    const to = result.periods.find((period) => period.key === result.comparison!.toKey);
    const pick = (period: SalesPeriod | undefined) =>
      result.comparison!.basis === "selection" ? period?.selection : period?.total;
    const fromLines = pick(from);
    const toLines = pick(to);
    if (!fromLines || !toLines) {
      violations.push("comparison refers to a period without numbers");
    } else {
      if (toLines.net - fromLines.net !== result.comparison.netChange) {
        violations.push("comparison net change does not match the periods");
      }
      const expectedPercent = computeChangePercent(fromLines.net, toLines.net);
      if (expectedPercent !== result.comparison.netChangePercent) {
        violations.push("comparison percentage does not match the periods");
      }
    }
  }
  return violations;
}

/** Percentage change rounded to one decimal; null when the base is 0. */
export function computeChangePercent(fromNet: number, toNet: number): number | null {
  if (fromNet === 0) return null;
  return Math.round(((toNet - fromNet) / Math.abs(fromNet)) * 1000) / 10;
}

export const SALES_DEFINITIONS: readonly string[] = [
  "Number of units, not kroner.",
  "Sold = units on orders placed in the month, before returns.",
  "Returns are counted in the month the return happens, even when the order is from an earlier month.",
  "Edits = units added or removed by order edits in the month.",
  "Net = sold - returns + edits.",
  "Test orders are left out.",
  "Grouped by today's product type in Shopify.",
  `Lines without a product type and lines whose product has been deleted are shown separately as ${UNTYPED_BUCKET_LABEL} and ${DELETED_PRODUCT_BUCKET_LABEL}.`,
];
