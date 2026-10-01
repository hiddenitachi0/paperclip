import type { NextFunction, Request, Response } from "express";

/**
 * DUR-4142/DUR-4182 naming: "Positions" is the new operator-facing name for
 * what used to be called the "Jobs" page -- the existing `agent-roles`
 * concept (company_agent_roles: instructions, skills, connectors, grants).
 * Table/column names and the old `/agent-roles` route paths stay exactly as
 * they are (ground rule: no renaming underneath anything already live) --
 * this just rewrites the new `/positions` path onto the old one before route
 * matching, so both names work identically.
 *
 * This does NOT touch `/jobs`: that word now names a separate, genuinely new
 * feature (one-press jobs built on Routines, server/src/routes/jobs.ts) with
 * its own live routes, not an alias for anything. An earlier draft of this
 * middleware aliased `/jobs` onto `/routines`, which would have silently
 * redirected every real Jobs API call (e.g. `/jobs/:id/run`) onto Routines
 * endpoints -- caught in review before it shipped.
 */
const ALIASES: Array<[RegExp, string]> = [
  [/^\/companies\/([^/]+)\/positions(\/|\?|$)/, "/companies/$1/agent-roles$2"],
  [/^\/positions(\/|\?|$)/, "/agent-roles$1"],
];

export function positionsJobsPathAliasMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    for (const [pattern, replacement] of ALIASES) {
      if (pattern.test(req.url)) {
        req.url = req.url.replace(pattern, replacement);
        break;
      }
    }
    next();
  };
}
