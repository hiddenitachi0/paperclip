import { z } from "zod";
import type { DataConnectionKind } from "./validators/data-connection.js";

/**
 * DUR-4072 PR3: where a report template's data comes from.
 *
 * A template names ONE of its own company's data connections
 * (`dataConnectionId`) and a `dataQuery`: a reporting period plus up to six
 * named datasets read through that connection. The server reads them (the
 * key never leaves the server), audits every read in data_read_events, caps
 * size and time, and hands the result to the approved calculation script as
 * its input JSON -- the script itself has no network and no key.
 *
 * Everything here is read-only by construction: each dataset maps to fixed
 * GET requests (Fiken), a GraphQL query (Shopify, mutations refused by the
 * client) or a single file read (FTP/FTPS/SFTP). There is no dataset that
 * writes, and no free-form URL or query text.
 */

/** Periods a template or a run may name. Always resolved on the server, in Norwegian time. */
export const REPORT_PERIOD_KEYWORDS = [
  "last_month",
  "last_quarter",
  "last_year",
  "this_month_to_date",
  "this_quarter_to_date",
  "this_year_to_date",
] as const;
export type ReportPeriodKeyword = (typeof REPORT_PERIOD_KEYWORDS)[number];

export const REPORT_PERIOD_LABELS: Record<ReportPeriodKeyword, string> = {
  last_month: "Last month",
  last_quarter: "Last quarter",
  last_year: "Last year",
  this_month_to_date: "This month so far",
  this_quarter_to_date: "This quarter so far",
  this_year_to_date: "This year so far",
};

export const reportPeriodSchema = z.union([
  z.enum(REPORT_PERIOD_KEYWORDS),
  z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected a month like 2026-07"),
  z.string().regex(/^\d{4}-Q[1-4]$/, "Expected a quarter like 2026-Q3"),
  z.string().regex(/^\d{4}$/, "Expected a year like 2026"),
]);
export type ReportPeriod = z.infer<typeof reportPeriodSchema>;

export const REPORT_DATASETS = [
  "shopify_sales",
  "file",
  "fiken_accounts",
  "fiken_balances",
  "fiken_journal_entries",
  "fiken_invoices",
  "fiken_contacts_summary",
] as const;
export type ReportDataset = (typeof REPORT_DATASETS)[number];

/** Which connection kinds can answer each dataset. */
export const REPORT_DATASET_KINDS: Record<ReportDataset, readonly DataConnectionKind[]> = {
  shopify_sales: ["shopify"],
  file: ["ftp_file", "ftps_file", "sftp_file"],
  fiken_accounts: ["fiken"],
  fiken_balances: ["fiken"],
  fiken_journal_entries: ["fiken"],
  fiken_invoices: ["fiken"],
  fiken_contacts_summary: ["fiken"],
};

/** Plain-English name and one-line explanation, shown on the template page. */
export const REPORT_DATASET_LABELS: Record<ReportDataset, { label: string; help: string }> = {
  shopify_sales: {
    label: "Sales per month (units)",
    help: "Units sold, returned and net for each month in the period, read from Shopify.",
  },
  file: {
    label: "A file on the server",
    help: "One CSV, JSON or text file from the connection's folder, for example an exported spreadsheet.",
  },
  fiken_accounts: {
    label: "Chart of accounts",
    help: "Every account number and name in Fiken.",
  },
  fiken_balances: {
    label: "Account balances",
    help: "The balance of every account at the start and at the end of the period.",
  },
  fiken_journal_entries: {
    label: "Bookkeeping entries",
    help: "Every journal entry dated inside the period, with its account lines (amounts in øre, debit +, credit −).",
  },
  fiken_invoices: {
    label: "Sales invoices",
    help: "Invoices issued in the period: number, dates, amounts and whether they are paid. Customer names are left out.",
  },
  fiken_contacts_summary: {
    label: "Customer and supplier count",
    help: "How many customers and suppliers Fiken has. Counts only, no names.",
  },
};

export function reportDatasetsForKind(kind: DataConnectionKind): ReportDataset[] {
  return REPORT_DATASETS.filter((dataset) => REPORT_DATASET_KINDS[dataset].includes(kind));
}

const itemKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "Use a short name with lowercase letters, numbers and _ (for example sales).");

export const reportDataItemSchema = z.discriminatedUnion("dataset", [
  z.object({
    key: itemKeySchema,
    dataset: z.literal("shopify_sales"),
    groupBy: z.enum(["none", "product_type"]).default("none"),
  }).strict(),
  z.object({
    key: itemKeySchema,
    dataset: z.literal("file"),
    /** Relative to the connection's folder; confined there by the file-server transport. */
    path: z.string().trim().min(1).max(500),
    format: z.enum(["csv", "json", "text"]),
  }).strict(),
  z.object({ key: itemKeySchema, dataset: z.literal("fiken_accounts") }).strict(),
  z.object({ key: itemKeySchema, dataset: z.literal("fiken_balances") }).strict(),
  z.object({ key: itemKeySchema, dataset: z.literal("fiken_journal_entries") }).strict(),
  z.object({ key: itemKeySchema, dataset: z.literal("fiken_invoices") }).strict(),
  z.object({ key: itemKeySchema, dataset: z.literal("fiken_contacts_summary") }).strict(),
]);
export type ReportDataItem = z.infer<typeof reportDataItemSchema>;

export const REPORT_DATA_MAX_ITEMS = 6;

export const reportDataQuerySchema = z
  .object({
    /** The default period; a run may name another one. */
    period: reportPeriodSchema.default("last_month"),
    items: z.array(reportDataItemSchema).min(1).max(REPORT_DATA_MAX_ITEMS),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.items.forEach((item, index) => {
      if (seen.has(item.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", index, "key"], message: `The name "${item.key}" is used twice.` });
      }
      seen.add(item.key);
    });
  });
export type ReportDataQuery = z.infer<typeof reportDataQuerySchema>;
export type ReportDataQueryInput = z.input<typeof reportDataQuerySchema>;

/** Owner/admin "Preview data" on the template page (before or after saving). */
export const previewReportDataSchema = z
  .object({
    dataConnectionId: z.string().uuid(),
    dataQuery: reportDataQuerySchema,
    period: reportPeriodSchema.optional(),
  })
  .strict();
export type PreviewReportDataInput = z.infer<typeof previewReportDataSchema>;

/** A period resolved to whole dates (inclusive) and the calendar months it touches. */
export interface ResolvedReportPeriod {
  token: string;
  /** First day, YYYY-MM-DD. */
  from: string;
  /** Last day, YYYY-MM-DD, inclusive (today for a "so far" period). */
  to: string;
  /** Every month the period touches, oldest first, as YYYY-MM. */
  months: string[];
  label: string;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthsBetween(fromYear: number, fromMonth: number, toYear: number, toMonth: number): string[] {
  const months: string[] = [];
  let year = fromYear;
  let month = fromMonth;
  while (year < toYear || (year === toYear && month <= toMonth)) {
    months.push(`${year}-${pad(month)}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function range(token: string, fromYear: number, fromMonth: number, toYear: number, toMonth: number, toDay: number | null, label: string): ResolvedReportPeriod {
  const endDay = toDay ?? lastDayOfMonth(toYear, toMonth);
  return {
    token,
    from: `${fromYear}-${pad(fromMonth)}-01`,
    to: `${toYear}-${pad(toMonth)}-${pad(endDay)}`,
    months: monthsBetween(fromYear, fromMonth, toYear, toMonth),
    label,
  };
}

/**
 * Turns a period token into dates. `today` is the calendar day in Norway
 * (the caller works it out). A period that has not started yet is refused
 * by the caller, not here.
 */
export function resolveReportPeriod(token: ReportPeriod, today: { year: number; month: number; day: number }): ResolvedReportPeriod {
  const { year, month, day } = today;
  const quarterOf = (m: number) => Math.floor((m - 1) / 3) + 1;
  switch (token) {
    case "last_month": {
      const y = month === 1 ? year - 1 : year;
      const m = month === 1 ? 12 : month - 1;
      return range(token, y, m, y, m, null, `${MONTH_NAMES[m - 1]} ${y}`);
    }
    case "last_quarter": {
      let q = quarterOf(month) - 1;
      let y = year;
      if (q === 0) {
        q = 4;
        y -= 1;
      }
      return range(token, y, q * 3 - 2, y, q * 3, null, `Q${q} ${y}`);
    }
    case "last_year":
      return range(token, year - 1, 1, year - 1, 12, null, String(year - 1));
    case "this_month_to_date":
      return range(token, year, month, year, month, day, `${MONTH_NAMES[month - 1]} ${year} so far`);
    case "this_quarter_to_date": {
      const q = quarterOf(month);
      return range(token, year, q * 3 - 2, year, month, day, `Q${q} ${year} so far`);
    }
    case "this_year_to_date":
      return range(token, year, 1, year, month, day, `${year} so far`);
    default: {
      const monthMatch = /^(\d{4})-(\d{2})$/.exec(token);
      if (monthMatch) {
        const y = Number(monthMatch[1]);
        const m = Number(monthMatch[2]);
        return range(token, y, m, y, m, null, `${MONTH_NAMES[m - 1]} ${y}`);
      }
      const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(token);
      if (quarterMatch) {
        const y = Number(quarterMatch[1]);
        const q = Number(quarterMatch[2]);
        return range(token, y, q * 3 - 2, y, q * 3, null, `Q${q} ${y}`);
      }
      const y = Number(token);
      return range(token, y, 1, y, 12, null, String(y));
    }
  }
}

/** One dataset's slice of a preview: counts and the first rows only. */
export interface ReportDataPreviewItem {
  key: string;
  dataset: ReportDataset;
  label: string;
  ok: boolean;
  /** Rows (or entries) the dataset returned in full. */
  rowCount: number;
  /** The first rows, as the script would see them. */
  sampleRows: unknown[];
  /** A plain sentence when the read was refused or failed. */
  message: string | null;
  /** The data_read_events row for this read. */
  lookupId: string | null;
}

export interface ReportDataPreview {
  connectionName: string;
  kindLabel: string;
  period: ResolvedReportPeriod;
  items: ReportDataPreviewItem[];
  /** Size and digest of the full input the script would get. */
  bytes: number;
  sha256: string | null;
}
