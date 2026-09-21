import { and, desc, eq, gte, inArray, lt, lte, not, or, sql, type SQL } from "drizzle-orm";
import {
  agents,
  authUsers,
  companies,
  crossCompanyAccessLog,
  ROUTINE_SCHEDULER_BYPASS_ACTOR_TYPE,
  ROUTINE_SCHEDULER_BYPASS_ROUTES,
  type Db,
} from "@paperclipai/db";
import type { CrossCompanyAccessLogEntry, CrossCompanyAccessLogPage } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/**
 * DUR-3983: read side of `cross_company_access_log` for the instance admin's
 * "Who looked at another company's data" page.
 *
 * The table is instance-wide by nature (it has no company_id column, so it
 * carries no row-level-security policy), and this reader is only ever called
 * from an instance-admin-only route. It therefore runs on the raw Db exactly
 * like the other instance-admin pages (instance-security.ts,
 * instance-settings.ts): no /companies/:companyId in the path, no
 * request-scoped proxy, so there is no company scope for it to fall outside
 * of. It deliberately does not wrap itself in runInCompanyScopeBypass: that
 * would write a fresh row into the very log being read on every page view,
 * and the admin's own reading of an audit trail is not a cross-company data
 * access worth recording.
 *
 * Bounded and indexed: every query is `ORDER BY occurred_at DESC, id DESC
 * LIMIT n+1` with range predicates on occurred_at only, so it rides
 * cross_company_access_log_occurred_at_idx (migration 0149) as a backward
 * index range scan. Pagination is keyset (cursor), never OFFSET, so page 50
 * costs the same as page 1 on a table that has held ~430k rows.
 */

export const CROSS_COMPANY_ACCESS_LOG_DEFAULT_PAGE_SIZE = 50;
export const CROSS_COMPANY_ACCESS_LOG_MAX_PAGE_SIZE = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A cursor timestamp is exactly what occurredAtText() below renders.
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface CrossCompanyAccessLogCursor {
  /** occurred_at at full microsecond precision, UTC. */
  occurredAt: string;
  id: string;
}

export interface ListCrossCompanyAccessLogOptions {
  /** Inclusive lower bound on occurred_at. */
  from?: Date | null;
  /** Exclusive upper bound on occurred_at. */
  to?: Date | null;
  cursor?: CrossCompanyAccessLogCursor | null;
  limit?: number;
  /**
   * Leave out the timer-driven scheduler ticks that filled the table before
   * DUR-386 stopped writing them (16-17 Sep 2026). Only exact matches on the
   * same list the writer silences are hidden, so anything unusual still shows.
   */
  hideRoutineScheduler?: boolean;
}

/**
 * The cursor carries the row's occurred_at as Postgres rendered it, not a JS
 * Date: timestamptz has microsecond precision and Date has milliseconds, so a
 * Date-based cursor would silently skip every row that falls in the lost
 * sub-millisecond gap between two pages.
 */
export function encodeCrossCompanyAccessLogCursor(cursor: CrossCompanyAccessLogCursor): string {
  return Buffer.from(`${cursor.occurredAt}|${cursor.id}`, "utf8").toString("base64url");
}

/** Returns null for anything that is not a cursor this module produced. */
export function decodeCrossCompanyAccessLogCursor(raw: string): CrossCompanyAccessLogCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [occurredAt, id, ...rest] = decoded.split("|");
  if (rest.length > 0 || !occurredAt || !id) return null;
  if (!CURSOR_TS_RE.test(occurredAt) || !UUID_RE.test(id)) return null;
  return { occurredAt, id };
}

const occurredAtText = sql<string>`to_char(${crossCompanyAccessLog.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The page query on its own, so a test can EXPLAIN exactly what the route runs. */
export function buildCrossCompanyAccessLogPageQuery(db: Db, opts: ListCrossCompanyAccessLogOptions) {
  const limit = clampLimit(opts.limit);
  const conditions: SQL[] = [];
  if (opts.from) conditions.push(gte(crossCompanyAccessLog.occurredAt, opts.from));
  if (opts.to) conditions.push(lt(crossCompanyAccessLog.occurredAt, opts.to));
  if (opts.cursor) {
    const cursorTs = sql`${opts.cursor.occurredAt}::timestamptz`;
    // The plain `<=` is what the index range scan starts from; the OR breaks
    // ties between rows written in the same microsecond.
    conditions.push(lte(crossCompanyAccessLog.occurredAt, cursorTs));
    conditions.push(
      or(
        lt(crossCompanyAccessLog.occurredAt, cursorTs),
        lt(crossCompanyAccessLog.id, opts.cursor.id),
      )!,
    );
  }
  if (opts.hideRoutineScheduler) {
    // COALESCE so a row with a NULL actor_type or route counts as "not
    // routine" and stays visible, instead of NULL-propagating out of the
    // filter. Only an exact match on both is hidden.
    conditions.push(
      not(
        and(
          sql`coalesce(${eq(crossCompanyAccessLog.actorType, ROUTINE_SCHEDULER_BYPASS_ACTOR_TYPE)}, false)`,
          sql`coalesce(${inArray(crossCompanyAccessLog.route, [...ROUTINE_SCHEDULER_BYPASS_ROUTES])}, false)`,
        )!,
      ),
    );
  }
  return db
    .select({
      id: crossCompanyAccessLog.id,
      occurredAt: occurredAtText,
      reason: crossCompanyAccessLog.reason,
      actorType: crossCompanyAccessLog.actorType,
      actorId: crossCompanyAccessLog.actorId,
      route: crossCompanyAccessLog.route,
      companyIdsTouched: crossCompanyAccessLog.companyIdsTouched,
    })
    .from(crossCompanyAccessLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(crossCompanyAccessLog.occurredAt), desc(crossCompanyAccessLog.id))
    .limit(limit + 1);
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return CROSS_COMPANY_ACCESS_LOG_DEFAULT_PAGE_SIZE;
  return Math.min(CROSS_COMPANY_ACCESS_LOG_MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function companyIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string");
}

/**
 * Best-effort id -> display name lookups. A name is a nicety on an audit page:
 * if a lookup fails (or, after the RLS cutover, a row-level policy hides it),
 * the entry is still shown with its raw id rather than failing the page.
 */
async function lookupNames<T extends { id: string; name: string | null }>(
  label: string,
  ids: string[],
  run: (ids: string[]) => Promise<T[]>,
): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>();
  if (ids.length === 0) return names;
  try {
    for (const row of await run(ids)) names.set(row.id, row.name);
  } catch (err) {
    logger.warn({ err, label }, "cross-company access log: name lookup failed; showing ids instead");
  }
  return names;
}

export async function listCrossCompanyAccessLog(
  db: Db,
  opts: ListCrossCompanyAccessLogOptions,
): Promise<CrossCompanyAccessLogPage> {
  const limit = clampLimit(opts.limit);
  const rows = await buildCrossCompanyAccessLogPageQuery(db, { ...opts, limit });
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeCrossCompanyAccessLogCursor({ occurredAt: last.occurredAt, id: last.id }) : null;

  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  const companyIds = new Set<string>();
  for (const row of pageRows) {
    if (row.actorId && row.actorType === "user") userIds.add(row.actorId);
    // agents.id is a uuid column: a malformed id would be a query error, not a miss.
    if (row.actorId && row.actorType === "agent" && UUID_RE.test(row.actorId)) agentIds.add(row.actorId);
    for (const id of companyIdsOf(row.companyIdsTouched)) if (UUID_RE.test(id)) companyIds.add(id);
  }

  const [userNames, agentNames, companyNames] = await Promise.all([
    lookupNames("users", [...userIds], (ids) =>
      db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, ids)),
    ),
    lookupNames("agents", [...agentIds], (ids) =>
      db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ids)),
    ),
    lookupNames("companies", [...companyIds], (ids) =>
      db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, ids)),
    ),
  ]);

  const entries: CrossCompanyAccessLogEntry[] = pageRows.map((row) => {
    let actorName: string | null = null;
    if (row.actorId && row.actorType === "user") actorName = userNames.get(row.actorId) ?? null;
    if (row.actorId && row.actorType === "agent") actorName = agentNames.get(row.actorId) ?? null;
    return {
      id: row.id,
      occurredAt: row.occurredAt,
      reason: row.reason,
      actorType: row.actorType,
      actorId: row.actorId,
      actorName,
      route: row.route,
      companies: companyIdsOf(row.companyIdsTouched).map((id) => ({ id, name: companyNames.get(id) ?? null })),
    };
  });

  return { entries, nextCursor };
}
