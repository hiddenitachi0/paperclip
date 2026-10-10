import type { ReportDataItem, ResolvedReportPeriod } from "@paperclipai/shared";
import type { DataSourceReadContext } from "./connection-kind.js";
import { DataSourceUpstreamError, salesResultSchema, type SalesPeriod } from "./contract.js";
import { flattenFikenEntries } from "./fiken-client.js";
import { isFileServerError } from "./file-server/errors.js";
import { shopifyDataSource } from "./shopify-source.js";

/**
 * DUR-4072 PR3: one reader per dataset a report template can name. A reader
 * gets a read context the data-connection service opened (the key stays
 * inside its transport), reads exactly one dataset for one period, and
 * returns plain JSON for the script's input snapshot.
 *
 * Readers only read. Shopify goes through the query-only sales engine (the
 * client refuses any mutation), Fiken through the GET-only client, a file
 * server through `files.read` (never write or remove). A reader never cuts a
 * result short: over a cap is a refusal with a plain sentence.
 */

export interface ReportDataLimits {
  /** Most rows (entries, invoices, CSV lines ...) one dataset may return. */
  maxRows: number;
  /** Most bytes one file may have. */
  maxFileBytes: number;
  /** Wall-clock time left for this dataset. */
  maxDurationMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReportDataItemResult {
  /** How many rows the dataset holds (shown in the preview, kept in the audit row). */
  rowCount: number;
  /** What the script gets under `data.<key>`. */
  data: unknown;
  /** The rows a preview shows the first few of. */
  rows: unknown[];
}

/** A refusal whose message is a plain sentence that is safe to show a person. */
export class ReportDataRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReportDataRefusal";
    this.code = code;
  }
}

function tooMany(maxRows: number, what: string): never {
  throw new ReportDataRefusal("too_many_rows", `There are more than ${maxRows} ${what}, which is more than a report may read at once. Choose a shorter period.`);
}

// ---------------------------------------------------------------- Shopify

async function readShopifySales(context: DataSourceReadContext, item: Extract<ReportDataItem, { dataset: "shopify_sales" }>, period: ResolvedReportPeriod, limits: ReportDataLimits): Promise<ReportDataItemResult> {
  if (context.kind !== "shopify") throw new ReportDataRefusal("dataset_not_offered", "Sales per month can only be read from a Shopify connection.");
  if (period.months.length > 24) tooMany(24, "months");
  const adapter = shopifyDataSource.adapters.sales!(context, {
    limits: { maxDurationMs: limits.maxDurationMs },
    ...(limits.sleep ? { sleep: limits.sleep } : {}),
  });
  const months: SalesPeriod[] = [];
  let header: { store: string; storeName: string; timezone: string; asOf: string } | null = null;
  // The sales engine answers at most two months per call.
  for (let index = 0; index < period.months.length; index += 2) {
    const chunk = period.months.slice(index, index + 2);
    const outcome = await adapter.sales({ periods: chunk, measure: ["units"], groupBy: item.groupBy });
    if (!outcome.ok) throw new ReportDataRefusal(outcome.refusal.code, outcome.refusal.message);
    const checked = salesResultSchema.safeParse(outcome.result);
    if (!checked.success) throw new ReportDataRefusal("unexpected_shape", "Shopify's figures did not have the expected shape, so nothing was used.");
    header ??= { store: checked.data.store, storeName: checked.data.storeName, timezone: checked.data.timezone, asOf: checked.data.asOf };
    months.push(...checked.data.periods);
  }
  return {
    rowCount: months.length,
    rows: months.map((month) => ({ month: month.key, status: month.status, dataState: month.dataState, ...(month.total ?? {}) })),
    data: { source: "shopify", measure: "units", ...header, months },
  };
}

// ---------------------------------------------------------------- Files

/** A small RFC 4180 reader. The delimiter is `;`, `,` or a tab, whichever the header line uses most. */
export function parseCsv(input: string, maxRows: number): Array<Record<string, string>> {
  const text = input.replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const [best] = [";", ",", "\t"]
    .map((candidate) => ({ candidate, count: firstLine.split(candidate).length - 1 }))
    .sort((a, b) => b.count - a.count);
  const delimiter = best && best.count > 0 ? best.candidate : ",";
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      record.push(field);
      field = "";
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
      if (records.length > maxRows + 1) tooMany(maxRows, "lines in the file");
    } else field += char;
  }
  record.push(field);
  if (record.some((value) => value !== "")) records.push(record);
  if (records.length > maxRows + 1) tooMany(maxRows, "lines in the file");
  const [headerRow, ...body] = records;
  if (!headerRow) return [];
  const headers = headerRow.map((name, index) => name.trim() || `column_${index + 1}`);
  return body.map((values) => Object.fromEntries(headers.map((name, index) => [name, values[index] ?? ""])));
}

async function readFile(context: DataSourceReadContext, item: Extract<ReportDataItem, { dataset: "file" }>, limits: ReportDataLimits): Promise<ReportDataItemResult> {
  if (context.kind !== "ftp_file" && context.kind !== "ftps_file" && context.kind !== "sftp_file") {
    throw new ReportDataRefusal("dataset_not_offered", "A file can only be read from an FTP, FTPS or SFTP connection.");
  }
  let read: Awaited<ReturnType<typeof context.files.read>>;
  try {
    read = await context.files.read(item.path, { maxBytes: limits.maxFileBytes });
  } catch (error) {
    if (isFileServerError(error)) throw new ReportDataRefusal(error.code, error.message);
    throw error;
  }
  const text = read.bytes.toString("utf8").replace(/^﻿/, "");
  const file = { path: read.path, size: read.size, modifiedAt: read.modifiedAt ? read.modifiedAt.toISOString() : null };
  if (item.format === "csv") {
    const rows = parseCsv(text, limits.maxRows);
    return { rowCount: rows.length, rows, data: { file, format: "csv", rows } };
  }
  if (item.format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ReportDataRefusal("unexpected_shape", `The file ${read.path} is not valid JSON.`);
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    if (rows.length > limits.maxRows) tooMany(limits.maxRows, "rows in the file");
    return { rowCount: rows.length, rows, data: { file, format: "json", content: parsed } };
  }
  const lines = text.split(/\r?\n/);
  if (lines.length > limits.maxRows) tooMany(limits.maxRows, "lines in the file");
  return { rowCount: lines.length, rows: lines, data: { file, format: "text", text } };
}

// ---------------------------------------------------------------- Fiken

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dayBefore(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

async function readFiken(context: DataSourceReadContext, item: ReportDataItem, period: ResolvedReportPeriod, limits: ReportDataLimits): Promise<ReportDataItemResult> {
  if (context.kind !== "fiken") throw new ReportDataRefusal("dataset_not_offered", "This dataset can only be read from a Fiken connection.");
  const fiken = context.fiken;
  const maxRows = limits.maxRows;
  switch (item.dataset) {
    case "fiken_accounts": {
      const accounts = (await fiken.getAll("/accounts", {}, { maxRows })).map((raw) => {
        const row = asRecord(raw);
        return { code: str(row.code), name: str(row.name) };
      });
      return { rowCount: accounts.length, rows: accounts, data: { amountsIn: "øre", accounts } };
    }
    case "fiken_balances": {
      const openingDate = dayBefore(period.from);
      const closingDate = period.to;
      const read = async (date: string) =>
        (await fiken.getAll("/accountBalances", { date }, { maxRows })).map((raw) => {
          const row = asRecord(raw);
          return { code: str(row.code) ?? "", name: str(row.name), balance: num(row.balance) ?? 0 };
        });
      const opening = await read(openingDate);
      const closing = await read(closingDate);
      const byCode = new Map<string, { code: string; name: string | null; opening: number; closing: number; change: number }>();
      for (const row of opening) byCode.set(row.code, { code: row.code, name: row.name, opening: row.balance, closing: 0, change: 0 });
      for (const row of closing) {
        const entry = byCode.get(row.code) ?? { code: row.code, name: row.name, opening: 0, closing: 0, change: 0 };
        entry.closing = row.balance;
        entry.name ??= row.name;
        byCode.set(row.code, entry);
      }
      const accounts = [...byCode.values()]
        .map((entry) => ({ ...entry, change: entry.closing - entry.opening }))
        .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
      return { rowCount: accounts.length, rows: accounts, data: { amountsIn: "øre", openingDate, closingDate, accounts } };
    }
    case "fiken_journal_entries": {
      const raw = await fiken.getAll("/journalEntries", { dateGe: period.from, dateLe: period.to }, { maxRows });
      // Booked on the ENTRY date; a nested transaction shape is flattened too.
      const entries = flattenFikenEntries(raw).filter((entry) => entry.date >= period.from && entry.date <= period.to);
      const lineCount = entries.reduce((sum, entry) => sum + entry.lines.length, 0);
      return {
        rowCount: entries.length,
        rows: entries,
        data: { amountsIn: "øre", sign: "debit positive, credit negative", from: period.from, to: period.to, lineCount, entries },
      };
    }
    case "fiken_invoices": {
      const invoices = (await fiken.getAll("/invoices", { issueDateGe: period.from, issueDateLe: period.to }, { maxRows })).map((rawInvoice) => {
        const row = asRecord(rawInvoice);
        // The customer is left out on purpose: no personal data in a report's input.
        return {
          invoiceId: num(row.invoiceId),
          invoiceNumber: num(row.invoiceNumber) ?? str(row.invoiceNumber),
          issueDate: str(row.issueDate),
          dueDate: str(row.dueDate),
          currency: str(row.currency),
          net: num(row.net),
          vat: num(row.vat),
          gross: num(row.gross),
          netInNok: num(row.netInNok),
          vatInNok: num(row.vatInNok),
          grossInNok: num(row.grossInNok),
          settled: row.settled === true,
        };
      });
      return { rowCount: invoices.length, rows: invoices, data: { amountsIn: "øre", from: period.from, to: period.to, invoices } };
    }
    case "fiken_contacts_summary": {
      const contacts = (await fiken.getAll("/contacts", {}, { maxRows })).map(asRecord);
      const summary = {
        total: contacts.length,
        customers: contacts.filter((contact) => contact.customer === true).length,
        suppliers: contacts.filter((contact) => contact.supplier === true).length,
        inactive: contacts.filter((contact) => contact.inactive === true).length,
      };
      return { rowCount: contacts.length, rows: [summary], data: summary };
    }
    default:
      throw new ReportDataRefusal("dataset_not_offered", "Fiken cannot give that dataset.");
  }
}

/** Reads one dataset through an open context. Throws ReportDataRefusal or DataSourceUpstreamError with a plain sentence. */
export async function readReportDataItem(
  context: DataSourceReadContext,
  item: ReportDataItem,
  period: ResolvedReportPeriod,
  limits: ReportDataLimits,
): Promise<ReportDataItemResult> {
  switch (item.dataset) {
    case "shopify_sales":
      return readShopifySales(context, item, period, limits);
    case "file":
      return readFile(context, item, limits);
    default:
      return readFiken(context, item, period, limits);
  }
}

export function isPlainReadError(error: unknown): error is ReportDataRefusal | DataSourceUpstreamError {
  return error instanceof ReportDataRefusal || error instanceof DataSourceUpstreamError;
}
