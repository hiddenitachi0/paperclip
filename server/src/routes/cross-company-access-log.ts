import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { assertInstanceAdmin } from "./authz.js";
import {
  CROSS_COMPANY_ACCESS_LOG_DEFAULT_PAGE_SIZE,
  CROSS_COMPANY_ACCESS_LOG_MAX_PAGE_SIZE,
  decodeCrossCompanyAccessLogCursor,
  listCrossCompanyAccessLog,
} from "../services/cross-company-access-log-view.js";

function singleQueryValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest(`"${name}" must be given once`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseInstant(value: string | undefined, name: string): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`"${name}" is not a date and time`);
  return parsed;
}

/**
 * DUR-3983: "Who looked at another company's data" -- the read-only view of
 * cross_company_access_log, for the instance admin only.
 *
 * Category (c) in the DUR-277 route inventory: instance-wide, with no
 * companyId anywhere in the request, so it sits on the raw Db the same way
 * instance-security.ts and instance-settings.ts do (see the service module
 * for why it does not audit its own reads). Admin-only is enforced before
 * anything touches the database; this is an authorization check, so unlike
 * the fail-open gates elsewhere it fails CLOSED.
 *
 * GET /instance/cross-company-access
 *   from, to   ISO date-times; from is inclusive, to is exclusive
 *   cursor     the nextCursor of the previous page (older entries)
 *   limit      1-200, default 50
 *   routine    "show" to include the timer-driven scheduler ticks that were
 *              logged before 17 Sep 2026; hidden by default
 */
export function crossCompanyAccessLogRoutes(db: Db) {
  const router = Router();

  router.get("/instance/cross-company-access", async (req, res) => {
    assertInstanceAdmin(req);

    const from = parseInstant(singleQueryValue(req.query.from, "from"), "from");
    const to = parseInstant(singleQueryValue(req.query.to, "to"), "to");
    if (from && to && from.getTime() >= to.getTime()) {
      throw badRequest('"from" must be earlier than "to"');
    }

    const rawCursor = singleQueryValue(req.query.cursor, "cursor");
    const cursor = rawCursor === undefined ? null : decodeCrossCompanyAccessLogCursor(rawCursor);
    if (rawCursor !== undefined && !cursor) throw badRequest('"cursor" is not valid; start again from the first page');

    const rawLimit = singleQueryValue(req.query.limit, "limit");
    let limit = CROSS_COMPANY_ACCESS_LOG_DEFAULT_PAGE_SIZE;
    if (rawLimit !== undefined) {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > CROSS_COMPANY_ACCESS_LOG_MAX_PAGE_SIZE) {
        throw badRequest(`"limit" must be a whole number from 1 to ${CROSS_COMPANY_ACCESS_LOG_MAX_PAGE_SIZE}`);
      }
    }

    const routine = singleQueryValue(req.query.routine, "routine");
    if (routine !== undefined && routine !== "show" && routine !== "hide") {
      throw badRequest('"routine" must be "show" or "hide"');
    }

    res.json(
      await listCrossCompanyAccessLog(db, {
        from,
        to,
        cursor,
        limit,
        hideRoutineScheduler: routine !== "show",
      }),
    );
  });

  return router;
}
