import type postgres from "postgres";

// DUR-304 (DUR-294 item 2): during the RLS transition (see migration 0149's
// header comment and packages/db/src/company-scope.ts), the app's live
// DATABASE_URL role still owns every table and so still bypasses RLS
// unconditionally -- Phase 2 (DUR-247/DUR-250) is what will eventually make
// an unset `app.current_company_id` claim actually matter for the app's own
// credential. Once that happens, any query that reaches a tenant table
// without the claim set fails CLOSED (zero rows, RLS's default-deny), not
// loud -- there is no error to catch. That is silent by design for security
// (a stray/compromised connection must not learn *that* a policy blocked
// it), but it is exactly the wrong failure mode for catching an accidental,
// well-meaning direct-`db`-access code path before enforcement flips on.
//
// This module is a best-effort, log-only (never throws, never changes query
// results) instrument for the transition window: it watches every query the
// app's pool issues via postgres.js's `debug` hook, tracks per-physical-
// connection whether `app.current_company_id` is currently set (mirroring
// exactly the three call sites in company-scope.ts that ever set/reset it --
// see trackClaimState below), and logs the first time each (applicationName,
// table) pair is seen touched by a query on a connection with no claim set
// and no acknowledged withCompanyScopeBypass/runInCompanyScopeBypass audit
// entry already recorded on that same connection.
//
// Deliberately opt-in (see isUnscopedTenantAccessLoggingEnabled): postgres.js
// allocates a fresh `new Error()` per query to capture an origin stack trace
// whenever `debug` is a function (see postgres@3.4.9 src/query.js), which is
// real per-query overhead this repo should not pay by default in production.
// This is meant to be switched on for an audit window ahead of a Phase 2
// enforcement cutover, not left on permanently.

export const UNSCOPED_TENANT_ACCESS_LOG_ENV_VAR = "PAPERCLIP_LOG_UNSCOPED_TENANT_ACCESS";

export function isUnscopedTenantAccessLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[UNSCOPED_TENANT_ACCESS_LOG_ENV_VAR]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

// The RLS policy every tenant table gets is named identically (see migration
// 0149's `CREATE POLICY paperclip_company_scope ON %I ...`), so the live set
// of protected tables can be read back from pg_policies instead of being
// hand-duplicated here -- avoiding exactly the kind of drift DUR-327 is
// tracking for the secret-pattern lists, and automatically staying correct
// as future migrations add more tables under the same policy name.
export const TENANT_SCOPE_POLICY_NAME = "paperclip_company_scope";

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildTenantTableRegex(tableNames: readonly string[]): RegExp | null {
  const unique = [...new Set(tableNames)].filter((name) => name.length > 0);
  if (unique.length === 0) return null;
  const alternation = unique.map(escapeRegExpLiteral).sort((a, b) => b.length - a.length).join("|");
  return new RegExp(`\\b(${alternation})\\b`, "i");
}

export async function loadTenantTableNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ tablename: string }[]>`
    SELECT DISTINCT tablename FROM pg_policies WHERE policyname = ${TENANT_SCOPE_POLICY_NAME}
  `;
  return rows.map((row) => row.tablename);
}

const LOCAL_CLAIM_SET_RE = /set_config\(\s*'app\.current_company_id'\s*,\s*\$\d+\s*,\s*true\s*\)/i;
const SESSION_CLAIM_SET_RE = /set_config\(\s*'app\.current_company_id'\s*,\s*\$\d+\s*,\s*false\s*\)/i;
const CLAIM_RESET_RE = /^\s*reset\s+app\.current_company_id\b/i;
const BEGIN_RE = /^\s*begin\b/i;
const ROLLBACK_TO_RE = /^\s*rollback\s+to\b/i;
const TX_END_RE = /^\s*(commit|rollback)\b/i;
// withCompanyScopeBypass/runInCompanyScopeBypass both insert one row here,
// on the same connection, before running any of the caller's own queries
// (see company-scope.ts) -- an already-audited legitimate cross-company use,
// not a gap this log needs to also flag.
const BYPASS_AUDIT_INSERT_RE = /insert\s+into\s+"?cross_company_access_log"?/i;

interface ConnectionClaimState {
  claim: string | null;
  localClaimActive: boolean;
  bypassAcknowledged: boolean;
}

export interface UnscopedTenantAccessDebugHook {
  readonly debug: (connectionId: number, query: string, parameters: readonly unknown[]) => void;
  setTenantTables(tableNames: readonly string[]): void;
}

// Exposed for tests: the whole detector is pure/synchronous and never
// touches a real connection itself, so it can be driven with synthetic
// (connectionId, query, parameters) tuples with no postgres dependency.
export function createUnscopedTenantAccessDebugHook(applicationName: string): UnscopedTenantAccessDebugHook {
  const connectionStates = new Map<number, ConnectionClaimState>();
  const loggedKeys = new Set<string>();
  let tenantTableRegex: RegExp | null = null;

  function stateFor(connectionId: number): ConnectionClaimState {
    let state = connectionStates.get(connectionId);
    if (!state) {
      state = { claim: null, localClaimActive: false, bypassAcknowledged: false };
      connectionStates.set(connectionId, state);
    }
    return state;
  }

  function debug(connectionId: number, query: string, parameters: readonly unknown[]): void {
    const state = stateFor(connectionId);

    if (BEGIN_RE.test(query)) {
      state.bypassAcknowledged = false;
      return;
    }
    if (LOCAL_CLAIM_SET_RE.test(query) || SESSION_CLAIM_SET_RE.test(query)) {
      const value = parameters[0];
      state.claim = typeof value === "string" ? value : null;
      state.localClaimActive = LOCAL_CLAIM_SET_RE.test(query);
      return;
    }
    if (CLAIM_RESET_RE.test(query)) {
      state.claim = null;
      state.localClaimActive = false;
      state.bypassAcknowledged = false;
      return;
    }
    if (TX_END_RE.test(query) && !ROLLBACK_TO_RE.test(query)) {
      if (state.localClaimActive) {
        state.claim = null;
        state.localClaimActive = false;
      }
      return;
    }
    if (BYPASS_AUDIT_INSERT_RE.test(query)) {
      state.bypassAcknowledged = true;
      return;
    }

    if (state.claim || state.bypassAcknowledged || !tenantTableRegex) return;

    const match = query.match(tenantTableRegex);
    if (!match) return;

    const table = match[1] ?? match[0];
    const key = `${applicationName}:${table}`;
    if (loggedKeys.has(key)) return;
    loggedKeys.add(key);

    console.warn(
      `company-scope: unscoped query touched tenant table "${table}" with no app.current_company_id claim set ` +
        `(applicationName="${applicationName}"). This is expected for scripts/CLI/migrations, but a live request ` +
        "or scheduler path hitting this will silently see zero rows once RLS enforcement is flipped on for the " +
        "app's own role (DUR-247/DUR-250 Phase 2) -- route it through withCompanyScope/runInCompanyScope or an " +
        "explicit withCompanyScopeBypass/runInCompanyScopeBypass instead. (Logged once per applicationName/table " +
        "for this process's lifetime.)",
    );
  }

  return {
    debug,
    setTenantTables(tableNames: readonly string[]) {
      tenantTableRegex = buildTenantTableRegex(tableNames);
    },
  };
}
