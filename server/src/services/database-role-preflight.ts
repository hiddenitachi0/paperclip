import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

/**
 * DUR-3945 (DUR-244 item 3): a startup check that tells the operator, in
 * plain words, which database credentials the app is actually running with
 * and whether they are the ones the RLS cutover runbook
 * (docs/rls-cutover-runbook.md) expects at each step.
 *
 * Why this exists: the whole point of the cutover is that a misconfigured
 * credential fails CLOSED (zero rows), not loud. An app pool whose role has
 * neither paperclip_app_scoped nor paperclip_app_bypass membership starts
 * fine, serves every request, and shows an empty instance. A bypass pool
 * whose role lacks bypass membership starts fine and then every scheduler
 * tick throws forever. Both are exactly the "silence must mean healthy"
 * failures this platform must not have -- so they are named here at boot.
 *
 * Read-only: only catalog lookups (pg_roles, pg_tables, pg_has_role). Never
 * changes anything. Logging vs. refusing to start is the caller's choice
 * (see PAPERCLIP_DB_ROLE_PREFLIGHT in server/src/index.ts).
 */

export type DatabaseRolePosture =
  /** The role is a superuser: RLS never applies to it, it can do anything. The pre-cutover state. */
  | "superuser"
  /** The role owns the tables: RLS never applies to a table's owner. The pre-cutover state on a non-superuser owner. */
  | "table-owner"
  /** Non-owner login that holds paperclip_app_bypass: sees every company, no DDL. The runbook's intermediate step for DATABASE_URL, and the target for DATABASE_BYPASS_URL. */
  | "bypass-login"
  /** Non-owner login that holds paperclip_app_scoped only: bound by RLS. The runbook's final step for DATABASE_URL. */
  | "scoped-login"
  /** Non-owner login with neither membership: RLS denies every tenant row. Misconfiguration. */
  | "no-access"
  /** Non-owner login holding BOTH memberships: violates migration 0149's invariant. Misconfiguration. */
  | "invariant-violated";

export interface DatabaseRoleFacts {
  role: string;
  isSuperuser: boolean;
  ownsTables: boolean;
  inScoped: boolean;
  inBypass: boolean;
  posture: DatabaseRolePosture;
}

export interface DatabaseRolePreflight {
  app: DatabaseRoleFacts;
  bypass: DatabaseRoleFacts;
  /** True when the two pools are the same credential (DATABASE_BYPASS_URL unset or equal to DATABASE_URL). */
  sharedCredential: boolean;
  /** Whether Row-Level Security actually restricts what the app's request pool can see. */
  rlsBindsAppPool: boolean;
  /** Plain-language problems that will break the app. Empty means the combination is workable. */
  problems: string[];
  /** Plain-language notes that are not errors but the operator should know (e.g. "still on the superuser"). */
  notes: string[];
}

export async function inspectDatabaseRole(db: Db): Promise<DatabaseRoleFacts> {
  const rows = (await db.execute(sql`
    SELECT
      current_user::text AS role,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
      EXISTS (
        SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'companies' AND tableowner = current_user
      ) AS owns_tables,
      pg_has_role(current_user, 'paperclip_app_scoped', 'member') AS in_scoped,
      pg_has_role(current_user, 'paperclip_app_bypass', 'member') AS in_bypass
  `)) as unknown as Array<{
    role: string;
    is_superuser: boolean | null;
    owns_tables: boolean;
    in_scoped: boolean;
    in_bypass: boolean;
  }>;
  const row = rows[0];
  if (!row) throw new Error("database role preflight: catalog query returned no row");
  const isSuperuser = row.is_superuser === true;
  // pg_has_role() unconditionally reports true for a superuser (see migration
  // 0151's comment); report real membership only for non-superusers.
  const inScoped = !isSuperuser && row.in_scoped === true;
  const inBypass = !isSuperuser && row.in_bypass === true;
  return {
    role: row.role,
    isSuperuser,
    ownsTables: row.owns_tables === true,
    inScoped,
    inBypass,
    posture: classifyRolePosture({ isSuperuser, ownsTables: row.owns_tables === true, inScoped, inBypass }),
  };
}

export function classifyRolePosture(facts: {
  isSuperuser: boolean;
  ownsTables: boolean;
  inScoped: boolean;
  inBypass: boolean;
}): DatabaseRolePosture {
  if (facts.isSuperuser) return "superuser";
  if (facts.ownsTables) return "table-owner";
  if (facts.inScoped && facts.inBypass) return "invariant-violated";
  if (facts.inBypass) return "bypass-login";
  if (facts.inScoped) return "scoped-login";
  return "no-access";
}

/**
 * Combine the two pools' facts into a verdict. Pure, so the wording can be
 * unit-tested without a database.
 */
export function evaluateDatabaseRolePreflight(input: {
  app: DatabaseRoleFacts;
  bypass: DatabaseRoleFacts;
  sharedCredential: boolean;
}): DatabaseRolePreflight {
  const { app, bypass, sharedCredential } = input;
  const problems: string[] = [];
  const notes: string[] = [];

  const rlsBindsAppPool = app.posture === "scoped-login";

  switch (app.posture) {
    case "superuser":
      notes.push(
        `The app connects to the database as "${app.role}", which is a database superuser. ` +
          "Company isolation (row-level security) does not apply to it yet. This is the state before the " +
          "RLS cutover -- see docs/rls-cutover-runbook.md, step 3.",
      );
      break;
    case "table-owner":
      notes.push(
        `The app connects as "${app.role}", which owns the tables, so company isolation does not apply to it yet. ` +
          "See docs/rls-cutover-runbook.md, step 3.",
      );
      break;
    case "bypass-login":
      notes.push(
        `The app connects as "${app.role}": no longer the table owner or a superuser (good), but it still sees every ` +
          "company. Company isolation will only bind the app once DATABASE_URL points at the scoped login " +
          "(docs/rls-cutover-runbook.md, step 4 -- gated).",
      );
      break;
    case "scoped-login":
      notes.push(
        `The app connects as "${app.role}", which is bound by company isolation: every request sees only its own company.`,
      );
      break;
    case "no-access":
      problems.push(
        `DATABASE_URL connects as "${app.role}", which is neither the table owner nor a member of paperclip_app_scoped ` +
          "or paperclip_app_bypass. Every company-scoped query will return zero rows and the instance will look empty. " +
          "Point DATABASE_URL back at the previous credential, or grant the role as docs/rls-cutover-runbook.md describes.",
      );
      break;
    case "invariant-violated":
      problems.push(
        `DATABASE_URL connects as "${app.role}", which holds BOTH paperclip_app_scoped and paperclip_app_bypass. ` +
          "That breaks the isolation design (migration 0149): a scoped connection must never be able to bypass. " +
          "Run: REVOKE paperclip_app_bypass FROM " + app.role + ";",
      );
      break;
  }

  const bypassOk = bypass.posture === "superuser" || bypass.posture === "table-owner" || bypass.posture === "bypass-login";
  if (!bypassOk) {
    const where = sharedCredential ? "DATABASE_URL (DATABASE_BYPASS_URL is not set, so the same credential is used)" : "DATABASE_BYPASS_URL";
    problems.push(
      `${where} connects as "${bypass.role}", which cannot bypass company isolation (not a superuser, not the table owner, ` +
        "not a member of paperclip_app_bypass). The background scheduler, the board sign-in/claim flows and every " +
        "instance-wide operation would fail on every attempt. Set DATABASE_BYPASS_URL to the bypass login " +
        "(docs/rls-cutover-runbook.md, step 2).",
    );
  }
  if (bypass.posture === "invariant-violated") {
    problems.push(
      `DATABASE_BYPASS_URL connects as "${bypass.role}", which holds BOTH paperclip_app_scoped and paperclip_app_bypass -- ` +
        "see migration 0149's invariant. Run: REVOKE paperclip_app_scoped FROM " + bypass.role + ";",
    );
  }

  if (!sharedCredential && rlsBindsAppPool && bypassOk) {
    notes.push("Both credentials are in their final cutover positions (scoped app pool, separate bypass pool).");
  }

  return { app, bypass, sharedCredential, rlsBindsAppPool, problems, notes };
}

export async function runDatabaseRolePreflight(input: {
  appDb: Db;
  bypassDb: Db;
  sharedCredential: boolean;
}): Promise<DatabaseRolePreflight> {
  const app = await inspectDatabaseRole(input.appDb);
  const bypass = input.sharedCredential ? app : await inspectDatabaseRole(input.bypassDb);
  return evaluateDatabaseRolePreflight({ app, bypass, sharedCredential: input.sharedCredential });
}

/** "strict" makes a preflight problem refuse startup; anything else only logs. */
export function resolveDatabaseRolePreflightMode(
  env: { PAPERCLIP_DB_ROLE_PREFLIGHT?: string } = process.env,
): "strict" | "warn" {
  return env.PAPERCLIP_DB_ROLE_PREFLIGHT?.trim().toLowerCase() === "strict" ? "strict" : "warn";
}
