import {
  DELETED_PRODUCT_BUCKET_LABEL,
  UNTYPED_BUCKET_LABEL,
  type CatalogResult,
  type SalesLines,
  type SalesPeriod,
  type SalesResult,
} from "./contract.js";
import { formatZonedDate, formatZonedDateTime, MONTH_NAMES, zonedParts } from "./zoned-time.js";

/**
 * DUR-3972 S3: the fixed answer card.
 *
 * Every number on the card comes from a validated SalesResult; nothing is
 * rounded, estimated or computed by the model. Numbers are written with a
 * plain space as the thousands separator and an ASCII minus ("1 234", "-3"),
 * never Intl's non-breaking space or U+2212, so S4's "every number in the reply
 * must come from the tool output" check can match them exactly.
 *
 * Layout per period (never a single net figure):
 *   Sold / Returns in the month (of which from earlier months) / Edits (only
 *   when not zero) / Net, then the server-computed change, the product types
 *   counted, the untyped and deleted lines, the definitions and the footer.
 *
 * Two things on the card are markers for the number check
 * (business-data-number-check.ts) and change together with it: the "No data:"
 * line, which the check drops before it grounds numbers, and the
 * "1–31 July 2026" date range, which it reads as a date, not as quantities.
 */

export function formatCount(value: number): string {
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(value)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function formatSignedCount(value: number): string {
  return value > 0 ? `+${formatCount(value)}` : formatCount(value);
}

export function formatPercent(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toFixed(1)} %`;
}

function plural(value: number, one: string, many: string): string {
  return Math.abs(value) === 1 ? one : many;
}

function units(value: number): string {
  return plural(value, "unit", "units");
}

/** "July 2026 (1–31 July 2026, closed)": the exact dates and whether the month is closed. */
export function periodRange(period: SalesPeriod, timezone: string): string {
  const start = new Date(period.start);
  const startParts = zonedParts(start, timezone);
  const monthName = MONTH_NAMES[startParts.month - 1];
  if (period.dataState === "no_data" && period.statusText === "not started") {
    return `${monthName} ${startParts.year} (not started)`;
  }
  // `end` is exclusive: show the last instant before it as the last day.
  const lastIncluded = new Date(new Date(period.end).getTime() - 1);
  const endParts = zonedParts(lastIncluded, timezone);
  const range = `${startParts.day}–${endParts.day} ${monthName} ${startParts.year}`;
  return `${monthName} ${startParts.year} (${range}, ${period.statusText})`;
}

function linesBlock(lines: SalesLines, indent = ""): string[] {
  const out = [
    `${indent}Sold: ${formatCount(lines.sold)} ${units(lines.sold)}`,
    `${indent}Returns in the month: ${formatCount(lines.returnsInPeriod)} ${units(lines.returnsInPeriod)} (of which ${formatCount(lines.returnsFromEarlierPeriods)} from earlier months)`,
  ];
  if (lines.edits !== 0) out.push(`${indent}Edits: ${formatSignedCount(lines.edits)} ${units(lines.edits)}`);
  out.push(`${indent}Net: ${formatCount(lines.net)} ${units(lines.net)}`);
  return out;
}

function compactLines(lines: SalesLines): string {
  const parts = [`sold ${formatCount(lines.sold)}`, `returns ${formatCount(lines.returnsInPeriod)}`];
  if (lines.edits !== 0) parts.push(`edits ${formatSignedCount(lines.edits)}`);
  parts.push(`net ${formatCount(lines.net)}`);
  return parts.join(", ");
}

function isAllZero(lines: SalesLines | null): boolean {
  return !lines || (lines.sold === 0 && lines.returnsInPeriod === 0 && lines.edits === 0 && lines.net === 0);
}

export interface SalesAnswerCardOptions {
  /** The audit row id (data_read_events.id), printed so the answer can be traced. */
  lookupId: string;
}

export function renderSalesAnswerCard(result: SalesResult, options: SalesAnswerCardOptions): string {
  const tz = result.timezone;
  const filtered = result.productTypesCounted !== null;
  const lines: string[] = [];
  lines.push(
    filtered
      ? `Sales in units for product type: ${result.productTypesCounted!.join(", ")}`
      : "Sales in units, all products",
  );

  for (const period of result.periods) {
    lines.push("");
    lines.push(periodRange(period, tz));
    if (period.dataState === "no_data") {
      // No digit on this line on purpose: the number check drops "No data"
      // lines, and a literal 0 here would let a reply claiming zero sales
      // through. "nothing sold" is not a number word either.
      lines.push(`No data: ${period.noDataReason ?? "no figures for the period"} (not the same as nothing sold)`);
      continue;
    }
    const headline = filtered ? period.selection! : period.total!;
    lines.push(...linesBlock(headline));
    if (filtered && result.productTypesCounted!.length > 1) {
      for (const bucket of period.byProductType.filter((entry) => result.productTypesCounted!.includes(entry.productType))) {
        lines.push(`  ${bucket.productType}: ${compactLines(bucket.lines)}`);
      }
    }
    if (!filtered && result.groupBy === "product_type") {
      for (const bucket of period.byProductType) {
        lines.push(`  ${bucket.productType}: ${compactLines(bucket.lines)}`);
      }
    }
    if (filtered) {
      lines.push(`${UNTYPED_BUCKET_LABEL}, not counted: ${compactLines(period.untyped!)}`);
      lines.push(`${DELETED_PRODUCT_BUCKET_LABEL}, not counted: ${compactLines(period.deletedProduct!)}`);
    } else {
      lines.push(`Of which ${UNTYPED_BUCKET_LABEL}: ${compactLines(period.untyped!)}`);
      lines.push(`Of which ${DELETED_PRODUCT_BUCKET_LABEL}: ${compactLines(period.deletedProduct!)}`);
    }
    if (filtered && isAllZero(period.selection)) {
      lines.push("Nothing sold of these product types in the period (every order was checked).");
    }
  }

  if (result.comparison) {
    const from = result.periods.find((period) => period.key === result.comparison!.fromKey)!;
    const to = result.periods.find((period) => period.key === result.comparison!.toKey)!;
    const percent =
      result.comparison.netChangePercent === null ? "" : ` (${formatPercent(result.comparison.netChangePercent)})`;
    lines.push("");
    lines.push(
      `Net change from ${from.label} to ${to.label}: ${formatSignedCount(result.comparison.netChange)} ${units(result.comparison.netChange)}${percent}` +
        (to.status === "running" ? `, but ${to.label} is still running` : ""),
    );
  }

  lines.push("");
  lines.push(
    filtered
      ? `Product types counted (by today's product type): ${result.productTypesCounted!.join(", ")}`
      : "Product types counted: all (by today's product type)",
  );
  lines.push(`How the figures are calculated: ${result.definitions.join(" ")}`);
  lines.push(renderSourceFooter(result, options.lookupId));
  return lines.join("\n");
}

export function renderSourceFooter(
  result: Pick<SalesResult, "store" | "timezone" | "asOf">,
  lookupId: string,
): string {
  return `Source: Shopify (online store ${result.store}), not the accounts · ${result.timezone} · fetched ${formatZonedDateTime(new Date(result.asOf), result.timezone)} · lookup ${lookupId}`;
}

export function renderCatalogAnswerCard(result: CatalogResult, options: SalesAnswerCardOptions): string {
  const lines: string[] = [
    `Product types in the online store ${result.store} (${result.productTypes.length} ${plural(result.productTypes.length, "type", "types")})`,
  ];
  const withUnits = result.unitsSoldStatus === "calculated";
  const soldLast12Months = (value: number) => `, ${formatCount(value)} ${units(value)} sold in the last 12 months`;
  for (const entry of result.productTypes) {
    const sold = withUnits && entry.unitsSoldLast12Months !== null ? soldLast12Months(entry.unitsSoldLast12Months) : "";
    lines.push(`- ${entry.productType}: ${formatCount(entry.productCount)} ${plural(entry.productCount, "product", "products")}${sold}`);
  }
  lines.push(
    `- ${UNTYPED_BUCKET_LABEL}: ${formatCount(result.untypedProductCount)} ${plural(result.untypedProductCount, "product", "products")}` +
      (withUnits && result.untypedUnitsSoldLast12Months !== null ? soldLast12Months(result.untypedUnitsSoldLast12Months) : ""),
  );
  if (withUnits && result.deletedProductUnitsSoldLast12Months !== null) {
    lines.push(`- ${DELETED_PRODUCT_BUCKET_LABEL}: ${soldLast12Months(result.deletedProductUnitsSoldLast12Months).slice(2)}`);
  }
  if (!withUnits) lines.push(`Units sold: ${result.unitsSoldStatus}.`);
  if (result.earliestVisibleOrderAt) {
    lines.push(`Shopify shows orders back to ${formatZonedDate(new Date(result.earliestVisibleOrderAt), result.timezone)}.`);
  }
  lines.push(renderSourceFooter(result, options.lookupId));
  return lines.join("\n");
}
