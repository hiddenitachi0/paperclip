import { FIKEN_API_HOST } from "@paperclipai/shared";
import { createSafeOutboundFetch, FIKEN_OUTBOUND_POLICY, SafeOutboundFetchError, type OutboundFetch } from "../safe-outbound-fetch.js";
import type { DataSourceCallBudget } from "./connection-kind.js";
import { DataSourceUpstreamError } from "./contract.js";
import { scrubSecrets } from "./shopify-client.js";

/**
 * DUR-4072 PR3: a READ-ONLY client for Fiken's REST API v2.
 *
 * Read-only is enforced here, in code, three times over:
 *   1. the client has only `get` and `getAll`; there is no method that takes
 *      an HTTP verb or a body;
 *   2. every path must match FIKEN_READ_PATHS (a fixed allow-list of the
 *      read endpoints a report needs, all under this connection's own
 *      company slug) -- nothing built from free text reaches Fiken;
 *   3. the authorised fetch underneath refuses any method but GET before
 *      the key is even loaded (`assertFikenGet`).
 * Fiken's personal API keys are NOT read-only on Fiken's side (a key can do
 * whatever its user can), which is exactly why the fence lives here.
 *
 * Fiken allows about four requests a second and no parallel requests, so
 * calls are made one at a time with a short pause between them; a 429 is
 * retried twice after a wait. Every call counts against the lookup's request
 * budget and wall-clock deadline, and a list that would exceed its row cap is
 * refused, never cut short.
 *
 * Amounts in Fiken are integers in øre. Journal entries carry signed lines
 * `{account, amount}` (debit +, credit −). NOTE: the /transactions endpoint
 * (and the dashboard's synced copy of it) nests those lines one level down,
 * under `entries[].lines`, with no top-level date or lines -- a reader that
 * looks for top-level `lines` silently sees nothing. This client reads
 * /journalEntries (flat) and `flattenFikenEntries` accepts both shapes.
 */

export const FIKEN_API_BASE = `https://${FIKEN_API_HOST}/api/v2`;
/** Fiken's largest page. */
export const FIKEN_PAGE_SIZE = 100;
/** Pause between two requests (Fiken: about four a second, one at a time). */
export const FIKEN_REQUEST_SPACING_MS = 260;
const FIKEN_MAX_429_RETRIES = 2;

const SLUG = "[a-z0-9][a-z0-9-]{1,120}";
/** The only paths this client will ever request. All GET, all under one company. */
export const FIKEN_READ_PATHS: readonly RegExp[] = [
  new RegExp(`^/companies/${SLUG}$`),
  new RegExp(`^/companies/${SLUG}/(accounts|accountBalances|journalEntries|invoices|contacts)$`),
];

export class FikenWriteRefusedError extends Error {
  constructor(method: string) {
    super(`Paperclip only reads from Fiken; a ${method} request was refused before it was sent.`);
    this.name = "FikenWriteRefusedError";
  }
}

/** Refuses anything but GET (or an absent method, which fetch treats as GET). */
export function assertFikenGet(init?: RequestInit): void {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET") throw new FikenWriteRefusedError(method);
  if (init?.body !== undefined && init.body !== null) throw new FikenWriteRefusedError(`${method} with a body`);
}

export type FikenQuery = Record<string, string | number | undefined>;

export interface FikenClient {
  readonly companySlug: string;
  /** One GET of a whitelisted path under this company. `path` is relative to the company, e.g. "/accounts" or "". */
  get(path: string, query?: FikenQuery): Promise<{ body: unknown; headers: Headers }>;
  /** Every page of a list endpoint. Refuses (never truncates) when there are more than `maxRows` rows. */
  getAll(path: string, query: FikenQuery, options: { maxRows: number }): Promise<unknown[]>;
  stats(): { requests: number };
}

export interface CreateFikenClientInput {
  companySlug: string;
  /** Resolves the personal API key (lazily, once). */
  getApiToken: () => Promise<string>;
  budget: DataSourceCallBudget;
  /** Values to scrub from every error text. */
  knownSecrets: () => string[];
  /** Replaces the guarded fetch; tests only. */
  fetchImpl?: OutboundFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFikenClient(input: CreateFikenClientInput): FikenClient {
  const guarded = input.fetchImpl ?? createSafeOutboundFetch(FIKEN_OUTBOUND_POLICY);
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const startedAt = now();
  const deadline = startedAt + input.budget.deadlineMs;
  let requests = 0;
  let lastRequestAt = 0;

  /** The ONE place a request leaves: GET only, the key added here and nowhere else. */
  const authorisedFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    assertFikenGet(init);
    const token = await input.getApiToken();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    return guarded(url, { method: "GET", headers });
  };

  function fail(code: string, message: string): never {
    throw new DataSourceUpstreamError(code, scrubSecrets(message, input.knownSecrets()));
  }

  function buildUrl(path: string, query: FikenQuery = {}): string {
    const full = `/companies/${input.companySlug}${path}`;
    if (!FIKEN_READ_PATHS.some((pattern) => pattern.test(full))) {
      fail("path_not_allowed", "Paperclip does not read that part of Fiken.");
    }
    const url = new URL(`${FIKEN_API_BASE}${full}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async function get(path: string, query: FikenQuery = {}): Promise<{ body: unknown; headers: Headers }> {
    const url = buildUrl(path, query);
    for (let attempt = 0; ; attempt += 1) {
      if (requests >= input.budget.maxRequests) {
        fail("request_budget_exceeded", `Reading from Fiken needed more than ${input.budget.maxRequests} requests, so it was stopped. Choose a shorter period.`);
      }
      const wait = lastRequestAt === 0 ? 0 : Math.max(0, lastRequestAt + FIKEN_REQUEST_SPACING_MS - now());
      if (now() + wait >= deadline) {
        fail("time_budget_exceeded", "Reading from Fiken took too long, so it was stopped. Choose a shorter period.");
      }
      if (wait > 0) await sleep(wait);
      requests += 1;
      lastRequestAt = now();
      let response: Response;
      try {
        response = await authorisedFetch(url);
      } catch (error) {
        if (error instanceof FikenWriteRefusedError) throw error;
        if (error instanceof SafeOutboundFetchError) fail("upstream_error", `Could not reach Fiken: ${error.message}`);
        fail("upstream_error", "Could not reach Fiken. Try again in a moment.");
      }
      if (response.status === 429 && attempt < FIKEN_MAX_429_RETRIES) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 1000);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        fail("unauthorized", "Fiken refused the API key. Check that the key is still valid and that the company has Fiken's API module switched on.");
      }
      if (response.status === 404) {
        fail("not_found", `Fiken does not know the company "${input.companySlug}", or the key has no access to it.`);
      }
      if (response.status === 429) fail("throttled", "Fiken asked us to slow down. Try again in a minute.");
      if (response.status >= 300) fail("upstream_error", `Fiken answered with an error (HTTP ${response.status}).`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        fail("unexpected_shape", "Fiken's answer could not be read.");
      }
      return { body, headers: response.headers };
    }
  }

  async function getAll(path: string, query: FikenQuery, options: { maxRows: number }): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 0; ; page += 1) {
      const { body, headers } = await get(path, { ...query, page, pageSize: FIKEN_PAGE_SIZE });
      if (!Array.isArray(body)) fail("unexpected_shape", "Fiken's answer was not a list.");
      rows.push(...body);
      if (rows.length > options.maxRows) {
        fail("too_many_rows", `Fiken has more than ${options.maxRows} rows for this, which is more than a report may read at once. Choose a shorter period.`);
      }
      const pageCount = Number(headers.get("fiken-api-page-count"));
      const done = Number.isFinite(pageCount) && pageCount > 0 ? page + 1 >= pageCount : body.length < FIKEN_PAGE_SIZE;
      if (done || body.length === 0) return rows;
    }
  }

  return {
    companySlug: input.companySlug,
    get,
    getAll,
    stats: () => ({ requests }),
  };
}

export interface FikenLine {
  account: string;
  /** øre, signed: debit +, credit −. */
  amount: number;
  vatCode: string | null;
}

export interface FikenEntry {
  journalEntryId: number | null;
  transactionId: number | null;
  date: string;
  description: string | null;
  lines: FikenLine[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toLine(raw: unknown): FikenLine | null {
  const line = asRecord(raw);
  if (!line) return null;
  const account = typeof line.account === "string" ? line.account : typeof line.account === "number" ? String(line.account) : null;
  const amount = typeof line.amount === "number" && Number.isFinite(line.amount) ? line.amount : null;
  if (account === null || amount === null) return null;
  return { account, amount, vatCode: typeof line.vatCode === "string" ? line.vatCode : null };
}

function toEntry(raw: Record<string, unknown>, fallback: { transactionId: number | null; description: string | null }): FikenEntry | null {
  const date = typeof raw.date === "string" ? raw.date : null;
  if (!date || !Array.isArray(raw.lines)) return null;
  return {
    journalEntryId: typeof raw.journalEntryId === "number" ? raw.journalEntryId : null,
    transactionId: typeof raw.transactionId === "number" ? raw.transactionId : fallback.transactionId,
    date,
    description: typeof raw.description === "string" ? raw.description : fallback.description,
    lines: raw.lines.map(toLine).filter((line): line is FikenLine => line !== null),
  };
}

/**
 * Journal entries in one flat shape, whichever shape Fiken (or a synced copy)
 * gave: a flat journal entry `{date, lines}`, or a transaction that nests its
 * entries `{entries: [{date, lines}]}` with no top-level date or lines.
 * Deleted transactions are dropped. Booked on the ENTRY date.
 */
export function flattenFikenEntries(rows: unknown[]): FikenEntry[] {
  const out: FikenEntry[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row || row.deleted === true) continue;
    if (Array.isArray(row.entries)) {
      const fallback = {
        transactionId: typeof row.transactionId === "number" ? row.transactionId : null,
        description: typeof row.description === "string" ? row.description : null,
      };
      for (const nested of row.entries) {
        const entry = asRecord(nested);
        const flat = entry ? toEntry(entry, fallback) : null;
        if (flat) out.push(flat);
      }
      continue;
    }
    const flat = toEntry(row, { transactionId: null, description: null });
    if (flat) out.push(flat);
  }
  return out;
}
