import type { RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { runInCompanyScope } from "@paperclipai/db";
import { badRequest } from "../errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-route middleware that establishes a company-scoped AsyncLocalStorage
 * context (packages/db/src/company-scope.ts, DUR-269/DUR-277) for the
 * remainder of the request, reading the target company from
 * `req.params.companyId`. Mount only on routes whose full mounted path
 * always includes that param before this handler runs.
 *
 * `rawDb` must be the same raw (unwrapped) Db instance passed to
 * `createRequestScopedDb()` for the service(s) this route calls -- the two
 * share scope state through the module-level AsyncLocalStorage in
 * company-scope.ts, not through anything passed explicitly here.
 *
 * Deliberately scoped per-route-file rather than mounted globally in
 * server/src/app.ts: each route family opts in independently, so an
 * unmigrated route is completely unaffected (still uses the raw db exactly
 * as before) rather than the app-wide cutover DUR-277's ticket describes as
 * needing to be atomic. See DUR-277 for the full rollout inventory.
 */
export function companyScopeFromParam(rawDb: Db): RequestHandler {
  return (req, res, next) => {
    const companyId = req.params.companyId;
    if (typeof companyId !== "string" || !UUID_RE.test(companyId)) {
      next(badRequest(`Invalid or missing companyId route param: ${String(companyId)}`));
      return;
    }

    runInCompanyScope(rawDb, companyId, () =>
      new Promise<void>((resolve) => {
        res.once("finish", resolve);
        res.once("close", resolve);
        next();
      }),
    ).catch((err) => {
      if (!res.headersSent) next(err);
      else console.error("company-scope middleware: error after response started", err);
    });
  };
}
