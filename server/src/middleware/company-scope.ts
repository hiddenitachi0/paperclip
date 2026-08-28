import type { Request, RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { runInCompanyScope } from "@paperclipai/db";
import { badRequest } from "../errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CompanyIdResolver = (req: Request) => string | undefined | Promise<string | undefined>;

/**
 * Canonical per-route middleware factory (DUR-269/DUR-277/DUR-347): resolves
 * the target companyId via `resolveCompanyId`, validates it, and establishes
 * a company-scoped AsyncLocalStorage context
 * (packages/db/src/company-scope.ts) for the remainder of the request.
 *
 * This is the one shared primitive every DUR-277 wave should build its
 * route-family scoping on top of, rather than reimplementing the
 * reserve/claim/release sequence per file -- that sequence is exactly what
 * DUR-275's design review holds to a specific bar (fail loud on an
 * AsyncLocalStorage miss, reset the session claim before the connection is
 * released back to the pool), so hand-rolling it again per route family
 * risks silently diverging from it. `companyScopeFromParam` and
 * `companyScopeFromBody` below cover the (a) direct-resolution categories
 * from the DUR-277 design doc; a wave wiring a (b) lookup-then-scope route
 * (companyId resolved via a prior DB lookup, e.g. an issue's `company_id`)
 * should pass an async `resolveCompanyId` here instead.
 *
 * `rawDb` must be the same raw (unwrapped) Db instance passed to
 * `createRequestScopedDb()` for the service(s) this route calls -- the two
 * share scope state through the module-level AsyncLocalStorage in
 * company-scope.ts, not through anything passed explicitly here.
 *
 * The companyId is validated (and, for lookup-based resolvers, resolved)
 * before any connection is reserved -- an invalid/missing companyId (or a
 * resolver that throws, e.g. a failed lookup) rejects the request with no
 * reserved connection or session claim ever created.
 *
 * Deliberately scoped per-route-file rather than mounted globally in
 * server/src/app.ts: each route family opts in independently, so an
 * unmigrated route is completely unaffected (still uses the raw db exactly
 * as before) rather than the app-wide cutover DUR-277's ticket originally
 * described as needing to be atomic. See DUR-277 for the full rollout
 * inventory.
 */
export function companyScope(rawDb: Db, resolveCompanyId: CompanyIdResolver): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => resolveCompanyId(req))
      .then((companyId) => {
        if (typeof companyId !== "string" || !UUID_RE.test(companyId)) {
          throw badRequest(`Invalid or missing companyId: ${String(companyId)}`);
        }

        return runInCompanyScope(rawDb, companyId, () =>
          new Promise<void>((resolve) => {
            res.once("finish", resolve);
            res.once("close", resolve);
            next();
          }),
        );
      })
      .catch((err) => {
        if (!res.headersSent) next(err);
        else console.error("company-scope middleware: error after response started", err);
      });
  };
}

/**
 * Reads the target company from `req.params.companyId`. Mount only on
 * routes whose full mounted path always includes that param before this
 * handler runs.
 */
export function companyScopeFromParam(rawDb: Db): RequestHandler {
  return companyScope(rawDb, (req) => {
    const value = req.params.companyId;
    return typeof value === "string" ? value : undefined;
  });
}

/**
 * Reads the target company from `req.body.companyId`, for routes that take
 * it in a JSON body rather than a route param (e.g. board-chat.ts,
 * chat-router.ts, lane-a.ts per the DUR-277 design doc's §1 category-(a)
 * body-resolution group).
 */
export function companyScopeFromBody(rawDb: Db): RequestHandler {
  return companyScope(rawDb, (req) => (req.body as Record<string, unknown> | undefined)?.companyId as string | undefined);
}
