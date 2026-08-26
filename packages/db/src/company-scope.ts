import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { crossCompanyAccessLog } from "./schema/cross_company_access_log.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DUR-247: these two helpers are the only supported way to set the
// `app.current_company_id` / `app.rls_bypass` session claims that the
// Postgres Row-Level Security policies added in migration 0148 key off of
// (see that migration's header comment for the full design). Both use
// `set_config(..., true)` inside a transaction, i.e. Postgres' `SET LOCAL`
// equivalent -- the claim is scoped to exactly this transaction and never
// leaks onto a pooled connection once it is returned to the pool.
//
// Neither is wired into the live request path or background schedulers yet
// (tracked as a DUR-247 follow-up) -- see the migration comment for why
// that is a deliberate, separate rollout step.

type ScopedDb = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function withCompanyScope<T>(
  db: Db,
  companyId: string,
  fn: (scopedDb: ScopedDb) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(companyId)) {
    throw new Error(`withCompanyScope: companyId is not a UUID: ${companyId}`);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_company_id', ${companyId}, true)`);
    return fn(tx);
  });
}

export interface CompanyScopeBypassOptions {
  /** Why this transaction legitimately needs to see more than one company. */
  reason: string;
  actorType?: string | null;
  actorId?: string | null;
  route?: string | null;
  companyIdsTouched?: string[] | null;
}

export async function withCompanyScopeBypass<T>(
  db: Db,
  opts: CompanyScopeBypassOptions,
  fn: (scopedDb: ScopedDb) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.rls_bypass', 'true', true)`);
    await tx.insert(crossCompanyAccessLog).values({
      reason: opts.reason,
      actorType: opts.actorType ?? null,
      actorId: opts.actorId ?? null,
      route: opts.route ?? null,
      companyIdsTouched: opts.companyIdsTouched ?? null,
    });
    return fn(tx);
  });
}
