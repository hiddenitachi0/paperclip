import {
  DELETED_PRODUCT_BUCKET_LABEL,
  UNTYPED_BUCKET_LABEL,
  type CatalogResult,
  type SalesLines,
  type SalesPeriod,
  type SalesResult,
} from "./contract.js";
import { formatZonedDate, formatZonedDateTime, NORWEGIAN_MONTHS, zonedParts } from "./zoned-time.js";

/**
 * DUR-3972 S3: the fixed Norwegian answer card.
 *
 * Every number on the card comes from a validated SalesResult; nothing is
 * rounded, estimated or computed by the model. Numbers are written with a
 * plain space as the thousands separator and an ASCII minus ("1 234", "-3"),
 * never Intl's non-breaking space or U+2212, so S4's "every number in the reply
 * must come from the tool output" check can match them exactly.
 *
 * Layout per period (never a single net figure):
 *   Solgt / Returer i måneden (herav fra tidligere måneder) / Endringer (only
 *   when not zero) / Netto, then the server-computed change, the product types
 *   counted, the untyped and deleted lines, the definitions and the footer.
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
  return `${sign}${Math.abs(value).toFixed(1).replace(".", ",")} %`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Juli 2026 (1.–31. juli 2026, avsluttet)": the exact dates and whether the month is closed. */
export function periodRange(period: SalesPeriod, timezone: string): string {
  const start = new Date(period.start);
  const startParts = zonedParts(start, timezone);
  const monthName = NORWEGIAN_MONTHS[startParts.month - 1];
  if (period.dataState === "no_data" && period.statusText === "ikke startet") {
    return `${capitalize(`${monthName} ${startParts.year}`)} (ikke startet)`;
  }
  // `end` is exclusive: show the last instant before it as the last day.
  const lastIncluded = new Date(new Date(period.end).getTime() - 1);
  const endParts = zonedParts(lastIncluded, timezone);
  const range = `${startParts.day}.–${endParts.day}. ${monthName} ${startParts.year}`;
  return `${capitalize(`${monthName} ${startParts.year}`)} (${range}, ${period.statusText})`;
}

function linesBlock(lines: SalesLines, indent = ""): string[] {
  const out = [
    `${indent}Solgt: ${formatCount(lines.sold)} stk`,
    `${indent}Returer i måneden: ${formatCount(lines.returnsInPeriod)} stk (herav ${formatCount(lines.returnsFromEarlierPeriods)} fra tidligere måneder)`,
  ];
  if (lines.edits !== 0) out.push(`${indent}Endringer: ${formatSignedCount(lines.edits)} stk`);
  out.push(`${indent}Netto: ${formatCount(lines.net)} stk`);
  return out;
}

function compactLines(lines: SalesLines): string {
  const parts = [`solgt ${formatCount(lines.sold)}`, `returer ${formatCount(lines.returnsInPeriod)}`];
  if (lines.edits !== 0) parts.push(`endringer ${formatSignedCount(lines.edits)}`);
  parts.push(`netto ${formatCount(lines.net)}`);
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
      ? `Salg i antall enheter for produkttype: ${result.productTypesCounted!.join(", ")}`
      : "Salg i antall enheter, alle produkter",
  );

  for (const period of result.periods) {
    lines.push("");
    lines.push(periodRange(period, tz));
    if (period.dataState === "no_data") {
      lines.push(`Ingen data: ${period.noDataReason ?? "ingen tall for perioden"} (ikke det samme som null salg)`);
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
      lines.push(`${UNTYPED_BUCKET_LABEL}, ikke talt med: ${compactLines(period.untyped!)}`);
      lines.push(`${DELETED_PRODUCT_BUCKET_LABEL}, ikke talt med: ${compactLines(period.deletedProduct!)}`);
    } else {
      lines.push(`Herav ${UNTYPED_BUCKET_LABEL}: ${compactLines(period.untyped!)}`);
      lines.push(`Herav ${DELETED_PRODUCT_BUCKET_LABEL}: ${compactLines(period.deletedProduct!)}`);
    }
    if (filtered && isAllZero(period.selection)) {
      lines.push("Ingen salg av disse produkttypene i perioden (alle ordre er gått gjennom).");
    }
  }

  if (result.comparison) {
    const from = result.periods.find((period) => period.key === result.comparison!.fromKey)!;
    const to = result.periods.find((period) => period.key === result.comparison!.toKey)!;
    const percent =
      result.comparison.netChangePercent === null ? "" : ` (${formatPercent(result.comparison.netChangePercent)})`;
    lines.push("");
    lines.push(
      `Endring netto fra ${from.label} til ${to.label}: ${formatSignedCount(result.comparison.netChange)} stk${percent}` +
        (to.status === "pågår" ? `, men ${to.label} pågår fortsatt` : ""),
    );
  }

  lines.push("");
  lines.push(
    filtered
      ? `Produkttyper talt med (etter dagens produkttype): ${result.productTypesCounted!.join(", ")}`
      : "Produkttyper talt med: alle (etter dagens produkttype)",
  );
  lines.push(`Slik er tallene regnet: ${result.definitions.join(" ")}`);
  lines.push(renderSourceFooter(result, options.lookupId));
  return lines.join("\n");
}

export function renderSourceFooter(
  result: Pick<SalesResult, "store" | "timezone" | "asOf">,
  lookupId: string,
): string {
  return `Kilde: Shopify (nettbutikken ${result.store}), ikke regnskap · ${result.timezone} · hentet ${formatZonedDateTime(new Date(result.asOf), result.timezone)} · oppslag ${lookupId}`;
}

export function renderCatalogAnswerCard(result: CatalogResult, options: SalesAnswerCardOptions): string {
  const lines: string[] = [`Produkttyper i nettbutikken ${result.store} (${result.productTypes.length} typer)`];
  const withUnits = result.unitsSoldStatus === "beregnet";
  for (const entry of result.productTypes) {
    const units =
      withUnits && entry.unitsSoldLast12Months !== null
        ? `, ${formatCount(entry.unitsSoldLast12Months)} stk solgt siste 12 måneder`
        : "";
    lines.push(`- ${entry.productType}: ${formatCount(entry.productCount)} produkter${units}`);
  }
  lines.push(`- ${UNTYPED_BUCKET_LABEL}: ${formatCount(result.untypedProductCount)} produkter` +
    (withUnits && result.untypedUnitsSoldLast12Months !== null
      ? `, ${formatCount(result.untypedUnitsSoldLast12Months)} stk solgt siste 12 måneder`
      : ""));
  if (withUnits && result.deletedProductUnitsSoldLast12Months !== null) {
    lines.push(
      `- ${DELETED_PRODUCT_BUCKET_LABEL}: ${formatCount(result.deletedProductUnitsSoldLast12Months)} stk solgt siste 12 måneder`,
    );
  }
  if (!withUnits) lines.push(`Solgte enheter: ${result.unitsSoldStatus}.`);
  if (result.earliestVisibleOrderAt) {
    lines.push(`Shopify viser ordre tilbake til ${formatZonedDate(new Date(result.earliestVisibleOrderAt), result.timezone)}.`);
  }
  lines.push(renderSourceFooter(result, options.lookupId));
  return lines.join("\n");
}
