import { describe, expect, it } from "vitest";
import type { DataConnectionConfig, DataConnectionKind, ResolvedReportPeriod } from "@paperclipai/shared";
import {
  assertFikenGet,
  createFikenClient,
  FikenWriteRefusedError,
  flattenFikenEntries,
} from "../services/data-sources/fiken-client.js";
import { FIKEN_READ_ONLY_NOTE } from "../services/data-sources/fiken-source.js";
import type { DataSourceConnectionInfo } from "../services/data-sources/connection-kind.js";
import { getDataSourceKind, type OpenReadContextInput } from "../services/data-sources/registry.js";
import { parseCsv, readReportDataItem } from "../services/data-sources/report-data-readers.js";
import { DataSourceUpstreamError } from "../services/data-sources/contract.js";

/**
 * DUR-4072 PR3: the Fiken adapter is read-only and talks only to recorded
 * (stubbed) HTTP here -- no real call is ever made.
 *
 *  - only GET leaves the client; any other verb, or a body, is refused before
 *    the key is even loaded; only whitelisted read paths under the
 *    connection's own company slug are requested;
 *  - pagination follows Fiken-Api-Page-Count; a list over its row cap is
 *    refused, never cut; the request budget is enforced;
 *  - the key travels in the Authorization header only and is scrubbed from
 *    every error;
 *  - the report readers shape balances, journal entries (both Fiken shapes:
 *    flat, and nested under entries[]), invoices without customers, and a
 *    contacts COUNT without names.
 */

const TOKEN = "fk" + "_live_0123456789abcdefSECRETTOKEN";
const SLUG = "nordstrand-mobler-as";

interface Recorded {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

function stubFiken(routes: (url: URL) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers), body: init?.body });
    const answer = routes(url);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json", ...(answer.headers ?? {}) },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function connection(kind: DataConnectionKind, config: DataConnectionConfig): DataSourceConnectionInfo {
  return {
    id: "7b81e0aa-0000-4000-8000-000000000001",
    companyId: "7b81e0aa-0000-4000-8000-000000000002",
    kind,
    name: "Regnskap",
    shopDomain: null,
    apiVersion: null,
    config,
    access: "read",
    hostKeyFingerprint: null,
    ianaTimezone: null,
    currencyCode: null,
    earliestVisibleOrderAt: null,
  };
}

function fikenInput(fetchImpl: typeof fetch, budget = { maxRequests: 50, deadlineMs: 60_000 }): OpenReadContextInput & { loads: () => number } {
  let loads = 0;
  const secrets: string[] = [];
  return {
    connection: connection("fiken", { kind: "fiken", companySlug: SLUG }),
    loadCredential: async () => {
      loads += 1;
      secrets.push(TOKEN);
      return { kind: "api_token", apiToken: TOKEN };
    },
    budget,
    knownSecrets: () => [...secrets],
    registerSecret: (value) => secrets.push(value),
    deps: { fetchImpl, sleep: async () => undefined },
    loads: () => loads,
  };
}

const Q3: ResolvedReportPeriod = { token: "2026-Q3", from: "2026-07-01", to: "2026-09-30", months: ["2026-07", "2026-08", "2026-09"], label: "Q3 2026" };
const LIMITS = { maxRows: 1_000, maxFileBytes: 1024 * 1024, maxDurationMs: 30_000 };

describe("DUR-4072 Fiken read-only adapter", () => {
  it("refuses every verb but GET, and any body, before anything is sent", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      expect(() => assertFikenGet({ method })).toThrow(FikenWriteRefusedError);
    }
    expect(() => assertFikenGet({ method: "GET", body: "{}" })).toThrow(FikenWriteRefusedError);
    expect(() => assertFikenGet({ method: "GET" })).not.toThrow();
    expect(() => assertFikenGet(undefined)).not.toThrow();
  });

  it("only requests whitelisted read paths under the connection's own company", async () => {
    const { calls, fetchImpl } = stubFiken(() => ({ body: {} }));
    const client = createFikenClient({
      companySlug: SLUG,
      getApiToken: async () => TOKEN,
      budget: { maxRequests: 10, deadlineMs: 10_000 },
      knownSecrets: () => [TOKEN],
      fetchImpl,
      sleep: async () => undefined,
    });
    for (const path of ["/invoices/123/send", "/sales", "/../other-company/accounts", "/journalEntries/1/attachments", "/../../users"]) {
      await expect(client.get(path)).rejects.toMatchObject({ code: "path_not_allowed" });
    }
    expect(calls).toHaveLength(0);
    // The client offers no way to send anything else.
    expect(Object.keys(client).sort()).toEqual(["companySlug", "get", "getAll", "stats"]);
  });

  it("pages through a list with GET only, the key in the Authorization header and nowhere else", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => ({ code: String(1000 + i), name: `Konto ${i}` })),
      [{ code: "3000", name: "Salgsinntekt" }],
    ];
    const { calls, fetchImpl } = stubFiken((url) => {
      const page = Number(url.searchParams.get("page"));
      return { body: pages[page] ?? [], headers: { "Fiken-Api-Page-Count": "2" } };
    });
    const entry = getDataSourceKind("fiken");
    const input = fikenInput(fetchImpl);
    const context = entry.openReadContext(input);
    expect(input.loads()).toBe(0); // the key is loaded lazily, on the first request
    const result = await readReportDataItem(context, { key: "accounts", dataset: "fiken_accounts" }, Q3, LIMITS);
    expect(result.rowCount).toBe(101);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.body).toBeUndefined();
      expect(call.url.origin).toBe("https://api.fiken.no");
      expect(call.url.pathname).toBe(`/api/v2/companies/${SLUG}/accounts`);
      expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(call.url.toString()).not.toContain(TOKEN);
    }
    expect(calls.map((call) => call.url.searchParams.get("page"))).toEqual(["0", "1"]);
    expect(calls[0]!.url.searchParams.get("pageSize")).toBe("100");
    expect(JSON.stringify(result.data)).not.toContain(TOKEN);
  });

  it("refuses a list over its row cap instead of cutting it short", async () => {
    const { fetchImpl } = stubFiken(() => ({ body: Array.from({ length: 100 }, (_, i) => ({ code: String(i) })), headers: { "Fiken-Api-Page-Count": "9" } }));
    const context = getDataSourceKind("fiken").openReadContext(fikenInput(fetchImpl));
    await expect(readReportDataItem(context, { key: "accounts", dataset: "fiken_accounts" }, Q3, { ...LIMITS, maxRows: 150 })).rejects.toMatchObject({
      code: "too_many_rows",
    });
  });

  it("stops at the request budget", async () => {
    const { calls, fetchImpl } = stubFiken(() => ({ body: Array.from({ length: 100 }, () => ({})), headers: { "Fiken-Api-Page-Count": "50" } }));
    const context = getDataSourceKind("fiken").openReadContext(fikenInput(fetchImpl, { maxRequests: 3, deadlineMs: 60_000 }));
    await expect(readReportDataItem(context, { key: "j", dataset: "fiken_journal_entries" }, Q3, LIMITS)).rejects.toMatchObject({
      code: "request_budget_exceeded",
    });
    expect(calls).toHaveLength(3);
  });

  it("explains a refused key in plain words, without the key", async () => {
    const { fetchImpl } = stubFiken(() => ({ status: 401, body: { error: `bad token ${TOKEN}` } }));
    const outcome = await getDataSourceKind("fiken").check(fikenInput(fetchImpl));
    expect(outcome).toMatchObject({ ok: false, canActivate: false, observed: null });
    expect(outcome.problems[0]).toMatch(/Fiken refused the API key/);
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it("Test reads the company and says Paperclip only reads", async () => {
    const { calls, fetchImpl } = stubFiken((url) => {
      expect(url.pathname).toBe(`/api/v2/companies/${SLUG}`);
      return { body: { name: "Nordstrand Møbler AS", slug: SLUG, organizationNumber: "999999999" } };
    });
    const outcome = await getDataSourceKind("fiken").check(fikenInput(fetchImpl));
    expect(outcome).toMatchObject({ ok: true, canActivate: true });
    expect(outcome.observed?.shopName).toBe("Nordstrand Møbler AS");
    expect(outcome.notes).toContain(FIKEN_READ_ONLY_NOTE);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(getDataSourceKind("fiken").supported).toBe(true);
  });

  it("balances: opening (day before the period) and closing, merged per account", async () => {
    const { calls, fetchImpl } = stubFiken((url) => {
      const date = url.searchParams.get("date");
      if (date === "2026-06-30") return { body: [{ code: "1920", name: "Bank", balance: 100_000 }, { code: "1500:10001", name: "Kunde", balance: 5_000 }] };
      return { body: [{ code: "1920", name: "Bank", balance: 250_000 }, { code: "3000", name: "Salg", balance: -150_000 }] };
    });
    const context = getDataSourceKind("fiken").openReadContext(fikenInput(fetchImpl));
    const result = await readReportDataItem(context, { key: "balances", dataset: "fiken_balances" }, Q3, LIMITS);
    expect(calls.map((call) => call.url.searchParams.get("date"))).toEqual(["2026-06-30", "2026-09-30"]);
    expect(result.data).toMatchObject({
      amountsIn: "øre",
      openingDate: "2026-06-30",
      closingDate: "2026-09-30",
      accounts: [
        { code: "1500:10001", opening: 5_000, closing: 0, change: -5_000 },
        { code: "1920", opening: 100_000, closing: 250_000, change: 150_000 },
        { code: "3000", opening: 0, closing: -150_000, change: -150_000 },
      ],
    });
  });

  it("journal entries: filtered by entry date, and the nested transaction shape is flattened", async () => {
    const { calls, fetchImpl } = stubFiken(() => ({
      body: [
        { journalEntryId: 1, transactionId: 10, date: "2026-07-03", description: "Salg", lines: [{ account: "1920", amount: 12_500 }, { account: "3000", amount: -12_500, vatCode: "3" }] },
        // A synced transaction: no top-level date or lines, the lines live under entries[].
        { transactionId: 11, createdDate: "2026-10-01", deleted: false, entries: [{ date: "2026-08-15", lines: [{ account: "6300", amount: 4_000 }, { account: "1920", amount: -4_000 }] }] },
        { transactionId: 12, deleted: true, entries: [{ date: "2026-08-16", lines: [{ account: "6300", amount: 1 }] }] },
      ],
    }));
    const context = getDataSourceKind("fiken").openReadContext(fikenInput(fetchImpl));
    const result = await readReportDataItem(context, { key: "journal", dataset: "fiken_journal_entries" }, Q3, LIMITS);
    expect(calls[0]!.url.searchParams.get("dateGe")).toBe("2026-07-01");
    expect(calls[0]!.url.searchParams.get("dateLe")).toBe("2026-09-30");
    expect(result.rowCount).toBe(2);
    const data = result.data as { lineCount: number; entries: Array<{ date: string; transactionId: number; lines: Array<{ account: string; amount: number }> }> };
    expect(data.lineCount).toBe(4);
    expect(data.entries[1]).toMatchObject({ date: "2026-08-15", transactionId: 11, lines: [{ account: "6300", amount: 4_000 }, { account: "1920", amount: -4_000 }] });
  });

  it("flattenFikenEntries keeps balanced signed lines and ignores rows without a date", () => {
    const flat = flattenFikenEntries([{ lines: [{ account: "1", amount: 1 }] }, { date: "2026-07-01", lines: [{ account: 1920, amount: 5 }, { account: "x" }] }]);
    expect(flat).toEqual([{ journalEntryId: null, transactionId: null, date: "2026-07-01", description: null, lines: [{ account: "1920", amount: 5, vatCode: null }] }]);
  });

  it("invoices leave the customer out; contacts are counts only", async () => {
    const { fetchImpl } = stubFiken((url) => {
      if (url.pathname.endsWith("/invoices")) {
        expect(url.searchParams.get("issueDateGe")).toBe("2026-07-01");
        return { body: [{ invoiceId: 5, invoiceNumber: 1042, issueDate: "2026-07-10", dueDate: "2026-07-24", net: 80_000, vat: 20_000, gross: 100_000, currency: "NOK", settled: true, customer: { name: "Ola Nordmann", email: "ola@example.no" } }] };
      }
      return { body: [{ name: "Ola Nordmann", customer: true }, { name: "Leverandør AS", supplier: true }, { name: "Gammel", customer: true, inactive: true }] };
    });
    const context = getDataSourceKind("fiken").openReadContext(fikenInput(fetchImpl));
    const invoices = await readReportDataItem(context, { key: "invoices", dataset: "fiken_invoices" }, Q3, LIMITS);
    expect(JSON.stringify(invoices.data)).not.toContain("Ola");
    expect(invoices.rows[0]).toMatchObject({ invoiceNumber: 1042, gross: 100_000, settled: true });
    const contacts = await readReportDataItem(context, { key: "contacts", dataset: "fiken_contacts_summary" }, Q3, LIMITS);
    expect(contacts.data).toEqual({ total: 3, customers: 2, suppliers: 1, inactive: 1 });
    expect(JSON.stringify(contacts)).not.toContain("Ola");
  });

  it("a reader refuses a dataset the connection kind cannot give", async () => {
    const { fetchImpl } = stubFiken(() => ({ body: [] }));
    const context = getDataSourceKind("fiken").openReadContext(fikenInput(fetchImpl));
    await expect(readReportDataItem(context, { key: "s", dataset: "shopify_sales", groupBy: "none" }, Q3, LIMITS)).rejects.toMatchObject({ code: "dataset_not_offered" });
    await expect(readReportDataItem(context, { key: "f", dataset: "file", path: "a.csv", format: "csv" }, Q3, LIMITS)).rejects.toMatchObject({ code: "dataset_not_offered" });
  });

  it("errors are plain DataSourceUpstreamErrors", async () => {
    const { fetchImpl } = stubFiken(() => ({ status: 500, body: {} }));
    const context = getDataSourceKind("fiken").openReadContext(fikenInput(fetchImpl));
    const error = await readReportDataItem(context, { key: "a", dataset: "fiken_accounts" }, Q3, LIMITS).catch((caught) => caught);
    expect(error).toBeInstanceOf(DataSourceUpstreamError);
    expect(error.message).toBe("Fiken answered with an error (HTTP 500).");
  });
});

describe("DUR-4072 report file reader", () => {
  it("reads a semicolon CSV with quotes, and refuses one over the row cap", () => {
    const rows = parseCsv('\uFEFFKonto;Navn;Beløp\n3000;"Salg; butikk";"1 250,50"\r\n4000;Varekjøp;-300\n', 10);
    expect(rows).toEqual([
      { Konto: "3000", Navn: "Salg; butikk", Beløp: "1 250,50" },
      { Konto: "4000", Navn: "Varekjøp", Beløp: "-300" },
    ]);
    expect(() => parseCsv("a,b\n1,2\n3,4\n5,6\n", 2)).toThrow(/more than 2/);
  });

  it("reads one file through the file-server context, never writes", async () => {
    const written: string[] = [];
    const context = {
      kind: "sftp_file" as const,
      connection: connection("sftp_file", { kind: "sftp_file", host: "h", port: 22, username: "u", remotePath: "/r", access: "read" } as DataConnectionConfig),
      now: () => new Date(),
      stats: () => ({ requests: 1, costPoints: 0 }),
      files: {
        basePath: "/r",
        access: "read" as const,
        list: async () => ({ path: "/r", entries: [] }),
        read: async (path: string) => ({ path: `/r/${path}`, bytes: Buffer.from("Konto,Beløp\n3000,100\n"), size: 20, modifiedAt: null }),
        write: async (path: string) => {
          written.push(path);
          return { path };
        },
        remove: async (path: string) => {
          written.push(path);
          return { path };
        },
        resolve: (path: string) => path,
        session: () => null,
        stats: () => ({ requests: 1 }),
        close: async () => undefined,
      },
    };
    const result = await readReportDataItem(context, { key: "file", dataset: "file", path: "salg.csv", format: "csv" }, Q3, LIMITS);
    expect(result.rowCount).toBe(1);
    expect(result.data).toMatchObject({ format: "csv", file: { path: "/r/salg.csv" }, rows: [{ Konto: "3000", Beløp: "100" }] });
    expect(written).toEqual([]);
  });
});
