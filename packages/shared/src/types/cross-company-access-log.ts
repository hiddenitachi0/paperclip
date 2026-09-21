/**
 * DUR-3983: read-only view of `cross_company_access_log` for the instance
 * admin ("Who looked at another company's data"). One row per use of the
 * cross-company escape hatch -- see packages/db/src/company-scope.ts
 * (runInCompanyScopeBypass) for the writer.
 */

export interface CrossCompanyAccessLogCompany {
  id: string;
  /** Null when the company no longer exists or its name could not be read. */
  name: string | null;
}

export interface CrossCompanyAccessLogEntry {
  id: string;
  occurredAt: string;
  /** Why the code crossed company boundaries, as recorded at the time. */
  reason: string;
  /** "user", "agent", "scheduler", "system", ... or null when nobody was signed in. */
  actorType: string | null;
  actorId: string | null;
  /** A person's or agent's display name, when one could be looked up. */
  actorName: string | null;
  /** The web address or background job that did the reading. */
  route: string | null;
  companies: CrossCompanyAccessLogCompany[];
}

export interface CrossCompanyAccessLogPage {
  entries: CrossCompanyAccessLogEntry[];
  /** Pass back as `cursor` to fetch the next (older) page; null on the last page. */
  nextCursor: string | null;
}
