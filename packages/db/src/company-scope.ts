import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { crossCompanyAccessLog } from "./schema/cross_company_access_log.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DUR-247: the supported way to interact with the Postgres Row-Level
// Security policies added in migration 0148 (see that migration's header
// comment for the full design).
//
// withCompanyScope sets the `app.current_company_id` session claim via
// `set_config(..., true)` inside a transaction, i.e. Postgres' `SET LOCAL`
// equivalent -- the claim is scoped to exactly this transaction and never
// leaks onto a pooled connection once it is returned to the pool.
//
// withCompanyScopeBypass does NOT set a claim -- the bypass is granted by
// Postgres role membership (`paperclip_app_bypass`), not by anything this
// code can set on a connection. A plain settable session GUC would let any
// SQL statement reaching this connection -- including one driven by an
// unrelated SQL-injection-shaped bug -- grant itself the same bypass, which
// is exactly the gap this design closes. withCompanyScopeBypass instead
// verifies the connection already holds that (pre-provisioned, admin-granted)
// membership and fails loudly if it doesn't, rather than silently no-op'ing.
//
// Neither helper is wired into the live request path or background
// schedulers yet (tracked as a DUR-247 follow-up) -- see the migration
// comment for why that is a deliberate, separate rollout step.

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
    const [membership] = (await tx.execute(
      sql`SELECT pg_has_role(current_user, 'paperclip_app_bypass', 'member') AS has_bypass`,
    )) as unknown as { has_bypass: boolean }[];
    if (!membership?.has_bypass) {
      throw new Error(
        "withCompanyScopeBypass: this connection's role is not a member of paperclip_app_bypass, " +
          "so it cannot bypass company-scoped RLS. This is a Postgres role grant an administrator must " +
          "make ahead of time (GRANT paperclip_app_bypass TO <role>) -- it is not something a connection " +
          "can grant itself, by design.",
      );
    }

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
