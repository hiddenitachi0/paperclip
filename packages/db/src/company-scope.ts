import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import type { ReservedSql } from "postgres";
import type { Db } from "./client.js";
import { crossCompanyAccessLog } from "./schema/cross_company_access_log.js";
import * as schema from "./schema/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DUR-247: the supported way to interact with the Postgres Row-Level
// Security policies added in migration 0149 (see that migration's header
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

// DUR-269: the request/scheduler-scoped counterpart to withCompanyScope /
// withCompanyScopeBypass above. Those two hold one Postgres transaction open
// for the lifetime of the callback, which is fine for a single unit of work
// but is unsuitable for wrapping an entire HTTP request or scheduler tick --
// holding a transaction open across a whole request (including any slow
// mid-request calls to external services/LLMs some routes make) risks
// connection-pool exhaustion and long lock hold times, a reliability
// incident distinct from the isolation goal this module exists for.
//
// runInCompanyScope / runInCompanyScopeBypass instead RESERVE one physical
// connection for the callback's duration (sql.reserve()), set the session
// claim once (not SET LOCAL -- session-level, so it survives across the
// autocommit statements a request naturally issues), and populate an
// AsyncLocalStorage-held scope so createRequestScopedDb's Proxy (below) can
// resolve "the current request's scoped db" for every one of the app's
// existing 3302 db.select/insert/update/delete/execute/query/transaction
// call sites without touching any of them.
//
// Design reviewed on DUR-275 (accepted with 4 required modifications, all
// incorporated below):
//   1. The Proxy's AsyncLocalStorage-miss path fails loud (throws) instead
//      of silently falling back to the raw pooled db -- see
//      createRequestScopedDb. A lost async context (setTimeout, a raw
//      EventEmitter listener, a worker-thread callback) must surface as an
//      error, not as silently regained unscoped access.
//   2. The session claim is reset (RESET, not just relying on request end)
//      before every reserved connection is released back to the pool, so a
//      connection reused by the next request/tick can never inherit a prior
//      request's company claim. If the reset itself fails, the connection is
//      sacrificed (sql.end()) rather than recycled with unknown claim state.
//   3. createRequestScopedDb forwards generically over every property
//      (including deep-proxying `.query`, drizzle's relational query
//      builder) instead of an enumerated method allowlist, so it can't
//      silently miss a drizzle API surface by omission.
//   4. This module only exports the primitives -- it is the caller's
//      responsibility to wrap only the app's one request-serving db
//      singleton (not createDb() itself, which ~10 scripts/CLI
//      commands/tests call directly and must keep getting the raw,
//      always-pooled, unscoped db with no ALS involvement at all).

export interface RequestCompanyScope {
  readonly kind: "scoped";
  readonly companyId: string;
  readonly scopedDb: Db;
}

export interface RequestCompanyScopeBypass {
  readonly kind: "bypass";
  readonly scopedDb: Db;
}

export type RequestScope = RequestCompanyScope | RequestCompanyScopeBypass;

// Shared between runInCompanyScope/runInCompanyScopeBypass (which populate
// it) and createRequestScopedDb (which reads it) -- a single module-level
// instance so both sides always agree on "the current scope."
export const requestCompanyScopeStorage = new AsyncLocalStorage<RequestScope>();

// drizzle-orm's postgres-js driver reads client.options.parsers/.serializers
// to construct a PostgresJsDatabase (see node_modules/drizzle-orm/postgres-js/driver.*,
// `construct()`). The object sql.reserve() returns does NOT carry an
// `.options` property at runtime, even though postgres.js's own .d.ts
// declares `ReservedSql extends Sql` (which types .options as present) --
// verified directly against the pinned postgres@3.4.9 runtime while building
// this. options.parsers/.serializers/.types are pool-wide shared-by-reference
// config (every physical connection, reserved or not, was constructed from
// this same object), so copying the reference from the pool's own client is
// correct, not a guess -- it does not change what the reserved connection
// actually does on the wire, it only satisfies drizzle's constructor.
function withDrizzleCompatibleClient(reserved: ReservedSql, rawDb: Db): ReservedSql {
  const patchable = reserved as ReservedSql & { options?: unknown };
  if (!patchable.options) {
    Object.defineProperty(patchable, "options", {
      value: rawDb.$client.options,
      enumerable: true,
      configurable: true,
    });
  }
  return reserved;
}

async function resetClaimAndRelease(reserved: ReservedSql): Promise<void> {
  try {
    await reserved`RESET app.current_company_id`;
    reserved.release();
  } catch (err) {
    // The connection's claim state is now unknown and must never go back to
    // the pool for something else to inherit. The reviewed design (DUR-275)
    // called for sql.end()'ing just this one connection in that case, but
    // ReservedSql has no such per-connection close at runtime in the pinned
    // postgres@3.4.9 (.end()/.close() only exist on the pool-wide client,
    // and calling them here would tear down every other in-flight request's
    // connection too) -- verified while building this, a real divergence
    // from what DUR-275 assumed. The only safe option with the API this
    // library actually exposes is to never call .release(): an
    // unreleased reserved connection can never be handed to another
    // request, so it can never leak this claim to another tenant. It is
    // simply abandoned (one permanently lost pool slot) instead of being
    // recycled with unknown claim state. This never throws -- it must not
    // mask fn()'s own result or error from the caller's finally block.
    console.error(
      "company-scope: failed to reset session claim before release; abandoning the connection instead of recycling it",
      err,
    );
  }
}

/**
 * Reserve one physical connection, set the `app.current_company_id` session
 * claim, and run `fn` with an AsyncLocalStorage scope so every db call made
 * through createRequestScopedDb(rawDb) during `fn` -- however deep in the
 * call stack -- resolves to this connection. Intended for wrapping one whole
 * HTTP request or scheduler tick, not a single query.
 */
export async function runInCompanyScope<T>(rawDb: Db, companyId: string, fn: () => Promise<T>): Promise<T> {
  if (!UUID_RE.test(companyId)) {
    throw new Error(`runInCompanyScope: companyId is not a UUID: ${companyId}`);
  }

  const reserved = withDrizzleCompatibleClient(await rawDb.$client.reserve(), rawDb);
  try {
    await reserved`select set_config('app.current_company_id', ${companyId}, false)`;
    const scopedDb = drizzlePg(reserved, { schema });
    return await requestCompanyScopeStorage.run({ kind: "scoped", companyId, scopedDb }, fn);
  } finally {
    await resetClaimAndRelease(reserved);
  }
}

/**
 * Bypass counterpart to runInCompanyScope: reserves a connection, checks
 * paperclip_app_bypass role membership and logs to cross_company_access_log
 * once for the whole callback (not per query), then runs `fn` with an
 * AsyncLocalStorage scope. For board/board_delegate/none actors and
 * instance-wide background schedulers -- see withCompanyScopeBypass above
 * for why this is a role-membership check, not a settable session GUC.
 */
export async function runInCompanyScopeBypass<T>(
  rawDb: Db,
  opts: CompanyScopeBypassOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const reserved = withDrizzleCompatibleClient(await rawDb.$client.reserve(), rawDb);
  try {
    const [membership] = (await reserved`
      select pg_has_role(current_user, 'paperclip_app_bypass', 'member') as has_bypass
    `) as unknown as { has_bypass: boolean }[];
    if (!membership?.has_bypass) {
      throw new Error(
        "runInCompanyScopeBypass: this connection's role is not a member of paperclip_app_bypass, " +
          "so it cannot bypass company-scoped RLS. This is a Postgres role grant an administrator must " +
          "make ahead of time (GRANT paperclip_app_bypass TO <role>) -- it is not something a connection " +
          "can grant itself, by design.",
      );
    }

    const scopedDb = drizzlePg(reserved, { schema });
    await scopedDb.insert(crossCompanyAccessLog).values({
      reason: opts.reason,
      actorType: opts.actorType ?? null,
      actorId: opts.actorId ?? null,
      route: opts.route ?? null,
      companyIdsTouched: opts.companyIdsTouched ?? null,
    });

    return await requestCompanyScopeStorage.run({ kind: "bypass", scopedDb }, fn);
  } finally {
    await resetClaimAndRelease(reserved);
  }
}

function walkPath(root: unknown, path: readonly PropertyKey[]): unknown {
  return path.reduce<unknown>((acc, key) => (acc as Record<PropertyKey, unknown> | null | undefined)?.[key], root);
}

function describePath(path: readonly PropertyKey[], prop: PropertyKey): string {
  return [...path, prop].map((key) => String(key)).join(".");
}

/**
 * Wrap the app's one request-serving db singleton so every existing call
 * site (db.select/insert/update/delete/execute/query, including nested
 * db.query.<table>.findFirst()-style builders) transparently resolves to the
 * current request/tick's reserved, company-scoped (or bypass-scoped)
 * connection established by runInCompanyScope/runInCompanyScopeBypass --
 * with NO call-site changes required. db.transaction() is the one
 * deliberate exception -- see the comment at its trap below.
 *
 * Forwards generically over every other property (function values are
 * bound to the effective target; object values are recursively wrapped)
 * rather than an enumerated method list, so it can't silently miss part of
 * drizzle's API surface. If no scope is active for the current async
 * context, every access throws -- this proxy never falls back to the raw
 * pooled db, so a lost async context (setTimeout, a bare EventEmitter
 * listener, a worker-thread callback) surfaces as a loud error instead of
 * silently regaining full unscoped access.
 *
 * Only wrap the app's single request-serving singleton with this. Scripts,
 * tests, migrations, and startup/admin tasks must keep using createDb()'s
 * raw return value directly -- they never run inside the ALS scope this
 * proxy requires, by design.
 */
export function createRequestScopedDb(rawDb: Db): Db {
  const build = (path: readonly PropertyKey[]): unknown => {
    const structuralTarget = (walkPath(rawDb, path) as object | null) ?? {};
    return new Proxy(structuralTarget, {
      get(_target, prop) {
        // db.transaction() is deliberately NOT forwarded, even though every
        // other property is generically forwarded (see the doc comment
        // above). Drizzle's transaction() calls the underlying postgres.js
        // client's .begin(), which only exists on the top-level pool client
        // -- the reserved connection this proxy resolves to at request time
        // does not have it (verified against the pinned postgres@3.4.9
        // runtime while building this). Binding it anyway would let a call
        // site reach a confusing "client.begin is not a function" deep
        // inside drizzle instead of an actionable error at the call site.
        // Call sites that need a real transaction inside company scope
        // should use withCompanyScope(rawDb, companyId, fn) /
        // withCompanyScopeBypass(rawDb, opts, fn) directly instead -- those
        // hold their own short-lived transaction, not the whole request.
        if (path.length === 0 && prop === "transaction") {
          return () => {
            throw new Error(
              "createRequestScopedDb: db.transaction() is not supported through the request-scoped proxy. " +
                "Use withCompanyScope(rawDb, companyId, fn) or withCompanyScopeBypass(rawDb, opts, fn) directly " +
                "for call sites that need an actual transaction.",
            );
          };
        }

        const store = requestCompanyScopeStorage.getStore();
        if (!store) {
          throw new Error(
            `createRequestScopedDb: attempted to use "${describePath(path, prop)}" outside any ` +
              "AsyncLocalStorage-tracked request/scheduler scope. This proxy only serves scoped access " +
              "established by runInCompanyScope/runInCompanyScopeBypass, and refuses to fall back to the " +
              "raw pooled connection -- a lost async context must fail loudly, not silently regain " +
              "unscoped access. If this is script/test/migration/startup code, use createDb()'s raw " +
              "return value directly instead of this wrapped singleton.",
          );
        }
        const effective = walkPath(store.scopedDb, path) as Record<PropertyKey, unknown>;
        const value = effective[prop];
        if (typeof value === "function") return value.bind(effective);
        if (value !== null && typeof value === "object") return build([...path, prop]);
        return value;
      },
    });
  };
  return build([]) as Db;
}
