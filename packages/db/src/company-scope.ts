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

// DUR-418: tracks how many withCompanyScope() calls are currently nested on
// top of a single request's reserved connection (see runOnReservedScope
// below), keyed by the RequestCompanyScope's scopedDb object identity (one
// per runInCompanyScope() call, i.e. one per request/tick). A first call
// opens a real `BEGIN`; anything nested inside that callback on the same
// connection uses a SAVEPOINT instead of a second `BEGIN`, which would
// silently attach to (and let an inner COMMIT prematurely finish) the outer
// transaction rather than erroring. No call site nests today (verified via
// DUR-916 review), but that invariant isn't enforced anywhere, so this is
// handled defensively rather than assumed.
//
// DUR-918 review: depth is assigned in call-start order, which is safe
// on its own (BEGIN/SAVEPOINT are issued in that same order -- see
// runOnReservedScope), but nothing about depth ASSIGNMENT stops two
// sibling calls from CLOSING (COMMIT/RELEASE SAVEPOINT) out of LIFO order
// when they run concurrently instead of being awaited one after another
// (e.g. two withCompanyScope calls on the same scope started via
// Promise.all, or a fire-and-forget continuation racing the handler that
// spawned it -- the exact DUR-417 queueTaskWatchdogEvaluation pattern).
// If a shallower call's COMMIT/ROLLBACK runs while a deeper call's
// SAVEPOINT is still open, it ends the whole transaction out from under
// the deeper call -- its subsequent statements land autocommitted outside
// any transaction, and its own RELEASE SAVEPOINT/ROLLBACK TO SAVEPOINT
// then fails against a connection with no open transaction. `waiters`
// below closes that gap: a call may only issue its own finalize statement
// once it is the innermost (topmost) still-open call, so completion order
// is always forced back into the same LIFO order depth was assigned in --
// see waitForTurn/releaseTurn.
interface ReservedScopeStack {
  /** Count of withCompanyScope() calls currently open (BEGIN/SAVEPOINT issued, not yet finalized) on this connection. */
  depth: number;
  /** Resolvers for calls waiting to become the topmost open call before they may finalize -- keyed by their own depth. */
  waiters: Map<number, () => void>;
}

const reservedScopeStacks = new WeakMap<Db, ReservedScopeStack>();

function getReservedScopeStack(scopedDb: Db): ReservedScopeStack {
  let stack = reservedScopeStacks.get(scopedDb);
  if (!stack) {
    stack = { depth: 0, waiters: new Map() };
    reservedScopeStacks.set(scopedDb, stack);
  }
  return stack;
}

// Resolves once `depth` is the innermost (topmost) still-open call on this
// connection -- i.e. every deeper call has already finalized. For strictly
// sequential (awaited) nesting this is already true by construction and
// resolves immediately with no extra wait; it only actually blocks a call
// whose sibling(s) opened after it are still mid-flight. This mirrors the
// dependency real nesting already has (an outer await already can't resume
// until an inner awaited call finishes) -- it does not introduce a new kind
// of wait, only extends the same guarantee to calls that weren't awaited
// relative to each other.
async function waitForTurn(stack: ReservedScopeStack, depth: number): Promise<void> {
  if (stack.depth === depth + 1) return;
  await new Promise<void>((resolve) => {
    stack.waiters.set(depth, resolve);
  });
}

function releaseTurn(stack: ReservedScopeStack, depth: number): void {
  stack.depth = depth;
  const nextWaiter = stack.waiters.get(depth - 1);
  if (nextWaiter) {
    stack.waiters.delete(depth - 1);
    nextWaiter();
  }
}

// DUR-916 review mod #2: drizzle's real `db.transaction(cb)` gives `cb` a
// `tx.rollback()` sentinel method -- calling it throws a special object that
// `db.transaction()` catches internally and resolves (not rejects) around.
// The hand-rolled BEGIN/SAVEPOINT wrapper here has no way to reproduce that
// resolve-on-rollback semantics (there is no outer `db.transaction()` call to
// catch it), so `.rollback()` is explicitly overridden to fail loudly instead
// of silently behaving differently than a real drizzle transaction would. No
// call site uses `tx.rollback()` today (verified during the DUR-916 review),
// so this only guards against a future, easy-to-make mistake.
//
// DUR-925: the same proxy also traps `.transaction()`. Without this, a
// service that closes over the value handed to a withCompanyScope()/
// runOnReservedScope() callback (e.g. secrets.ts's syncSecretRefsForTarget,
// constructed with `db = tx` for one business operation) and calls
// `db.transaction(fn)` directly on it -- without going back through
// withCompanyScope() -- reaches drizzle's real PostgresJsSession.transaction(),
// which calls `this.client.begin()`. The reserved connection backing this
// proxy is a postgres.js ReservedSql, which has no `.begin()` (only the
// top-level pool Sql does) -- see createRequestScopedDb's `.transaction`
// trap below for the sibling case this mirrors. Rather than fail loudly like
// that sibling trap, this one stays silently compatible: it routes the call
// through runOnReservedScope on the same connection/liveness, i.e. exactly
// what a true nested withCompanyScope(db, companyId, fn) call would do
// (SAVEPOINT, not a second BEGIN -- see the ReservedScopeStack depth
// tracking above). This keeps call sites written against the top-level
// pooled Db working unmodified when handed a reserved-connection-backed tx,
// which is the load-bearing pattern DUR-418 originally flagged as systemic
// (agents.ts/documents.ts/document-annotations.ts/external-objects.ts/
// feedback.ts/heartbeat.ts all pass a `tx` down into service functions this
// way).
//
// DUR-926 review: the trap must check `liveness.released` the same way
// withCompanyScope's own reuse branch does (see that check a few dozen lines
// down). Without it, a `tx`/`scopedDb` reference captured by something that
// outlives the owning runInCompanyScope() call (a fire-and-forget/`void`
// continuation -- the exact DUR-417/DUR-920 pattern this file already
// documents as real) could call `.transaction()` *after* the connection has
// been reset and handed back to the pool for an unrelated request/company.
// Unlike withCompanyScope, this trap only closes over `scopedDb`/`liveness`,
// not the raw pooled `Db`, so it has no fresh-connection fallback to reuse --
// it fails loudly instead, matching createRequestScopedDb's sibling trap.
function withRollbackGuard(scopedDb: Db, liveness: ReservedScopeLiveness): ScopedDb {
  return new Proxy(scopedDb as object, {
    get(target, prop, receiver) {
      if (prop === "rollback") {
        return () => {
          throw new Error(
            "withCompanyScope: tx.rollback() is not supported for a call running on a " +
              "runInCompanyScope()-reserved connection (DUR-418) -- drizzle's rollback-sentinel " +
              "resolve-not-reject semantics aren't reproduced by the hand-rolled BEGIN/SAVEPOINT wrapper " +
              "used here. Throw a regular Error from the callback instead; it rolls back this call's " +
              "SAVEPOINT/transaction the same as any other failure.",
          );
        };
      }
      if (prop === "transaction") {
        return (fn: (tx: ScopedDb) => Promise<unknown>) => {
          if (liveness.released) {
            throw new Error(
              "withCompanyScope: tx.transaction() was called after the runInCompanyScope() request scope " +
                "that reserved this connection already released it (DUR-926) -- this tx/scopedDb reference " +
                "was captured by something that outlived the owning request (e.g. a fire-and-forget " +
                "continuation, the DUR-417/DUR-920 pattern). The physical connection behind it may already " +
                "be back in the pool serving an unrelated request/company; reusing it here would silently " +
                "interleave writes with that unrelated request instead of erroring. Do not capture a " +
                "tx/scopedDb reference for use beyond the callback it was handed to.",
            );
          }
          return runOnReservedScope(scopedDb, liveness, fn);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as ScopedDb;
}

async function runOnReservedScope<T>(
  scopedDb: Db,
  liveness: ReservedScopeLiveness,
  fn: (scopedDb: ScopedDb) => Promise<T>,
): Promise<T> {
  // DUR-920: mark this call as committed to reusing the reserved connection
  // for its whole duration, synchronously, before any `await` -- the caller
  // (withCompanyScope) just checked `liveness.released === false` in the
  // same synchronous turn, so incrementing here with no intervening await
  // closes the window where runInCompanyScope's finally block could flip
  // `released` and release the connection in between the check and this
  // call actually starting. See markInFlightDrained's call sites for the
  // other half: runInCompanyScope/runInCompanyScopeBypass wait for this
  // counter to drain back to zero before releasing.
  liveness.inFlight += 1;
  const stack = getReservedScopeStack(scopedDb);
  const depth = stack.depth;
  const savepoint = `with_company_scope_${depth}`;
  stack.depth = depth + 1;
  try {
    await scopedDb.execute(depth === 0 ? sql`BEGIN` : sql.raw(`SAVEPOINT ${savepoint}`));
    try {
      const result = await fn(withRollbackGuard(scopedDb, liveness));
      await waitForTurn(stack, depth);
      await scopedDb.execute(depth === 0 ? sql`COMMIT` : sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
      return result;
    } catch (err) {
      await waitForTurn(stack, depth);
      await scopedDb
        .execute(depth === 0 ? sql`ROLLBACK` : sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`))
        .catch(() => {});
      throw err;
    }
  } finally {
    releaseTurn(stack, depth);
    // DUR-920: see the comment above this call's increment -- this call is
    // no longer committed to the connection, so it no longer counts toward
    // what runInCompanyScope's finally block is waiting to drain.
    liveness.inFlight -= 1;
    if (liveness.inFlight === 0) {
      markInFlightDrained(liveness);
    }
  }
}

export async function withCompanyScope<T>(
  db: Db,
  companyId: string,
  fn: (scopedDb: ScopedDb) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(companyId)) {
    throw new Error(`withCompanyScope: companyId is not a UUID: ${companyId}`);
  }

  // DUR-418: if we're already running inside a runInCompanyScope()-reserved
  // connection, run this transaction on THAT connection (BEGIN/SAVEPOINT in
  // runOnReservedScope) instead of calling db.transaction(), which would
  // reserve a SECOND physical connection from the same pool. Under enough
  // concurrent requests that both hold a runInCompanyScope reservation and
  // call withCompanyScope, every such nested db.transaction() call blocks
  // forever waiting for a connection that can never free up (releasing the
  // outer reservation requires this nested wait to finish first) -- a
  // permanent pool-exhaustion deadlock, not merely contention. See DUR-418
  // for the full repro.
  // DUR-3952: a "pooled" scope (runInPooledScope) has no reserved connection
  // to reuse -- its scopedDb IS the pool -- so it falls through to the
  // own-transaction path below exactly like no scope at all. Issuing
  // BEGIN/COMMIT as separate autocommit statements against a pool would land
  // them on different physical connections.
  const activeScope = requestCompanyScopeStorage.getStore();
  if (activeScope && activeScope.kind !== "pooled" && !activeScope.liveness.released) {
    if (activeScope.kind === "scoped") {
      // Only reused when the companyId matches the active scope exactly: the
      // reserved connection's session-level app.current_company_id claim is
      // already set to that company by runInCompanyScope, so no
      // per-transaction set_config is needed here (re-issuing it would just
      // be a second, redundant claim-setting path that could drift from the
      // session-level one over time).
      //
      // DUR-916 review mod #3: a DIFFERENT companyId is rejected outright,
      // not silently handed a second connection -- falling back would
      // reintroduce the exact pool-exhaustion deadlock this fix exists to
      // close, just conditionally (only in the cross-company case) and with
      // no visible signal when it happens. Legitimate cross-company access
      // has its own audited path: withCompanyScopeBypass +
      // cross_company_access_log.
      if (activeScope.companyId !== companyId) {
        throw new Error(
          `withCompanyScope: called for companyId ${companyId} while already inside a ` +
            `runInCompanyScope() request scope for a different companyId (${activeScope.companyId}). ` +
            "Reusing the outer connection would silently attach this call to the wrong company's " +
            "session claim, and acquiring a second pool connection here would reintroduce the DUR-418 " +
            "pool-exhaustion deadlock. Use withCompanyScopeBypass(rawDb, opts, fn) with a " +
            "cross_company_access_log entry for legitimate cross-company access instead.",
        );
      }
      return runOnReservedScope(activeScope.scopedDb, activeScope.liveness, fn);
    }

    // DUR-916 review mod #4: kind === "bypass" (from runInCompanyScopeBypass)
    // has no per-company claim to protect in the first place -- the
    // connection's access is already granted by paperclip_app_bypass role
    // membership, which covers every company regardless of what companyId
    // this call requested. Safe to reuse unconditionally, with no claim to
    // set or compare.
    return runOnReservedScope(activeScope.scopedDb, activeScope.liveness, fn);
  }

  // No live reserved scope: open our own connection from the pool. If `db` is
  // a request-scoped proxy whose scope has already been released, go through
  // the raw pool behind it (DUR-257) -- the proxy itself refuses
  // `.transaction()`, and before this every trailing executeRun step that
  // reached here left its run stuck "running" with a dead child.
  return unwrapRequestScopedDb(db).transaction(async (tx) => {
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
  return unwrapRequestScopedDb(db).transaction(async (tx) => {
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

// DUR-418: AsyncLocalStorage propagates a scope to every continuation spawned
// while `fn` was synchronously running -- including a fire-and-forget
// (`void someAsyncCall()`) chain that outlives `fn` itself and keeps running
// after runInCompanyScope's `finally` block has already reset+released the
// reserved connection back to the pool. `liveness.released` is flipped to
// `true` synchronously, before that release happens, so withCompanyScope can
// tell "the scope object is still in scope" apart from "the connection it
// points to is still safe to touch" and fall back to acquiring its own
// connection instead of issuing BEGIN on a connection some other request may
// already be mid-transaction on.
export interface ReservedScopeLiveness {
  released: boolean;
  // DUR-920: count of runOnReservedScope() calls currently committed to this
  // reserved connection (incremented/decremented synchronously around each
  // call, see runOnReservedScope). `released` alone only stops NEW calls from
  // starting to reuse the connection -- it does nothing for a call that
  // already read `released === false` and is mid-flight (e.g. a
  // fire-and-forget continuation started just before the request handler
  // resolved). runInCompanyScope/runInCompanyScopeBypass wait for this to
  // drain to zero (bounded, see waitForInFlightDrain) before actually
  // releasing the connection back to the pool.
  inFlight: number;
  // Set by waitForInFlightDrain while it is waiting; invoked by
  // runOnReservedScope's finally block when inFlight reaches 0. Never more
  // than one waiter at a time in practice (only runInCompanyScope's own
  // finally block waits), but nulled out immediately after firing/timing out
  // either way so a stale reference can't be double-invoked.
  onDrained: (() => void) | null;
}

// DUR-920: how long runInCompanyScope's finally block waits for in-flight
// runOnReservedScope() calls to drain before releasing the reserved
// connection. Bounded, not unbounded -- an in-flight fire-and-forget call
// that itself never resolves (e.g. it's stuck on a downstream call with no
// timeout of its own) must not block this request's connection from ever
// being released. DUR-3931: if the bound is hit, the still-in-flight calls
// are fenced off the connection (fenceReservedConnection) and it is rolled
// back, reset and recycled anyway -- it used to be abandoned outright, which
// meant a single stuck fire-and-forget call cost a pool slot permanently.
// Fencing gives the same "never hand a connection with a still-open
// transaction to an unrelated request" guarantee without the leak.
const IN_FLIGHT_DRAIN_TIMEOUT_MS = 10_000;

async function waitForInFlightDrain(liveness: ReservedScopeLiveness): Promise<void> {
  if (liveness.inFlight === 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      liveness.onDrained = null;
      resolve();
    }, IN_FLIGHT_DRAIN_TIMEOUT_MS);
    liveness.onDrained = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function markInFlightDrained(liveness: ReservedScopeLiveness): void {
  liveness.onDrained?.();
}

export interface RequestCompanyScope {
  readonly kind: "scoped";
  readonly companyId: string;
  readonly scopedDb: Db;
  readonly liveness: ReservedScopeLiveness;
}

export interface RequestCompanyScopeBypass {
  readonly kind: "bypass";
  readonly scopedDb: Db;
  readonly liveness: ReservedScopeLiveness;
}

/**
 * DUR-3952: the scope runInPooledScope establishes. Unlike the two above it
 * reserves nothing: `scopedDb` is the raw pooled Db itself, every query
 * borrows and returns a pool connection on its own, and `liveness.released`
 * therefore never flips -- there is no connection to release. This is what a
 * continuation that legitimately outlives the request/tick that spawned it
 * (a dispatched heartbeat run, a fire-and-forget re-check) runs under, so
 * createRequestScopedDb keeps resolving for it after the parent scope is
 * gone instead of either throwing (DUR-932 guard) or silently reusing the
 * parent's recycled connection.
 */
export interface RequestPooledScope {
  readonly kind: "pooled";
  readonly scopedDb: Db;
  readonly liveness: ReservedScopeLiveness;
}

export type RequestScope = RequestCompanyScope | RequestCompanyScopeBypass | RequestPooledScope;

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

// DUR-421 follow-up: Node's http.ServerResponse `close` event fires not only
// on a normal completed response but also "if the underlying connection was
// terminated prematurely (before the response completion)" (Node's own
// docs) -- e.g. a browser tab navigating away and its SPA data layer
// aborting the in-flight fetch via AbortController, which is routine, not
// exceptional. companyScope() (middleware/company-scope.ts) listens for both
// `finish` and `close` to resolve runInCompanyScope's `fn` and release the
// reserved connection, because relying on `finish` alone would leak the
// connection forever on a genuinely aborted request. But when `close` fires
// *without* `finish` having already fired, the route handler chain may still
// be mid-flight (Express's `next()` is fire-and-forget -- nothing here
// actually awaits the handler's completion). Releasing the connection back
// to the pool in that case lets a subsequent request reserve the same
// physical connection while the orphaned handler is still issuing queries on
// it, interleaving both requests' wire traffic and corrupting the Postgres
// extended-query protocol for both (surfaced in production as e.g. "bind
// message supplies N parameters, but prepared statement requires M").
// Throwing this from `fn` signals runInCompanyScope that the connection
// cannot simply be handed back to the pool -- see fenceReservedConnection
// below for how it is fenced off from the orphaned handler and then
// recycled safely.
//
// DUR-3931: this used to make runInCompanyScope *abandon* the connection --
// log and return without ever calling `reserved.release()`. That is a
// permanent, unbounded leak on a completely routine event: a browser
// aborts every in-flight fetch when the user navigates or reloads, so each
// reload burned one pool slot for the lifetime of the process. Once `max`
// (10 by default, see createDb) slots were burned the server was wedged
// forever -- postgres.js's `reserve()` awaits a promise with no timeout, so
// every subsequent company-scoped request hung rather than erroring. The
// connection is now fenced and recycled instead; see the finally block of
// runInCompanyScope.
export class ConnectionReleaseUnsafeError extends Error {
  constructor() {
    super(
      "company-scope: response stream closed before its handler finished; the handler may still be using this " +
        "connection, so it will not be recycled back to the pool",
    );
    this.name = "ConnectionReleaseUnsafeError";
  }
}

/**
 * DUR-3931: thrown when an orphaned handler tries to issue a query on a
 * connection whose owning request scope has already ended (client abort, or
 * an in-flight call that blew the drain bound). The request it belongs to is
 * already over -- its response socket is gone -- so failing its late query
 * loudly is strictly better than the alternatives: letting it run risks
 * interleaving with whatever request gets this physical connection next, and
 * refusing to ever recycle the connection is the leak this class exists to
 * remove.
 */
export class ConnectionFencedError extends Error {
  /**
   * @param detail Optional caller-specific message. When omitted, the generic
   *   connection-level fence message (DUR-3931) is used. The request-scoped
   *   proxy passes its own DUR-932 wording so both fences surface as the same
   *   error type (callers/tests match on `instanceof ConnectionFencedError`).
   */
  constructor(detail?: string) {
    super(
      detail ??
        "company-scope: this query was issued on a reserved connection after its owning request scope ended " +
          "(the response was closed/aborted before the handler finished). The connection has been recycled back " +
          "to the pool, so the query was not sent -- do not keep using a scopedDb/tx reference past the request " +
          "that created it.",
    );
    this.name = "ConnectionFencedError";
  }
}

interface ReservedConnectionFence {
  /** The client handed to drizzle. Identical to the reserved client until `close()`; every query throws afterwards. */
  readonly client: ReservedSql;
  /** Synchronously stop any *further* query from reaching the wire. Already-issued queries are unaffected. */
  close(): void;
}

// Every postgres.js entry point that can put traffic on the wire. The tagged
// template call itself is covered by the proxy's `apply` trap; drizzle's
// postgres-js session only ever uses `client.unsafe(...)` (verified against
// the pinned drizzle-orm@0.45.2 -- see its postgres-js/session.js), but the
// rest are trapped too so a future drizzle version or a hand-written call
// site can't quietly slip past the fence.
const FENCED_QUERY_METHODS = new Set<PropertyKey>([
  "unsafe",
  "begin",
  "savepoint",
  "prepare",
  "file",
  "reserve",
  "listen",
  "notify",
  "subscribe",
  "cursor",
]);

/**
 * DUR-3931: wrap a reserved connection so that all query traffic through it
 * can be stopped synchronously, in one turn, with no `await` in between.
 *
 * This is what makes recycling an aborted request's connection safe. The
 * hazard the old abandon-forever behaviour was avoiding is real: Express's
 * `next()` is fire-and-forget, so when the response closes early the handler
 * chain may still be running and still issuing queries. Releasing underneath
 * it would let an unrelated request reserve the same physical connection and
 * interleave with the orphan's traffic. Fencing removes the hazard at the
 * source instead of paying for it with a leaked connection: the orphan
 * cannot issue anything more, so once the queries it *already* issued have
 * drained the connection is provably idle and safe to reset and release.
 *
 * The drain barrier is postgres.js's own per-connection ordering, not a
 * timer: a reserved connection executes its queries in order, so a `ROLLBACK`
 * enqueued after fencing necessarily completes after everything the orphan
 * had already put on the wire. See fenceAndRecycle below.
 *
 * The one case the `fenced` flag does not cover by itself is a query object
 * the orphan constructed just *before* fencing but that postgres.js has not
 * enqueued yet -- its Query only reaches the connection a microtask or two
 * later (postgres@3.4.9 src/query.js: `handle()` is async and awaits once
 * before calling the handler). That is still safe: microtasks all drain
 * before the next macrotask, and fenceAndRecycle's release only happens two
 * network round-trips (ROLLBACK, then RESET) later, so such a query is
 * always enqueued strictly before the connection goes back to the pool --
 * at worst it runs between the ROLLBACK and the RESET, which both still
 * follow it.
 */
function fenceReservedConnection(reserved: ReservedSql): ReservedConnectionFence {
  let fenced = false;
  const assertOpen = () => {
    if (fenced) throw new ConnectionFencedError();
  };
  const target = reserved as unknown as (...args: unknown[]) => unknown;
  const client = new Proxy(target, {
    apply(_target, _thisArg, args) {
      assertOpen();
      return Reflect.apply(target, reserved, args);
    },
    get(_target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value === "function" && FENCED_QUERY_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          assertOpen();
          return (value as (...a: unknown[]) => unknown).apply(reserved, args);
        };
      }
      return value;
    },
  }) as unknown as ReservedSql;
  return {
    client,
    close: () => {
      fenced = true;
    },
  };
}

// DUR-3931: how long fenceAndRecycle waits for the fenced connection to
// quiesce before it stops blocking the (already-finished) request scope.
// Only reached when the orphaned handler had a genuinely long-running query
// on the wire at abort time -- the teardown is queued behind it. Hitting the
// bound does NOT abandon the connection: the teardown keeps running in the
// background and releases it as soon as that query finishes, so the worst
// case is a delayed reclaim rather than the permanent leak this replaces.
const FENCED_TEARDOWN_TIMEOUT_MS = 30_000;

/**
 * DUR-3931: fence the connection, then roll back and reset it behind
 * whatever the orphaned handler already had in flight, then release it.
 *
 * `ROLLBACK` is unconditional: the orphan may have been inside a
 * runOnReservedScope() BEGIN/SAVEPOINT, and a connection must never go back
 * to the pool mid-transaction. On a connection with no open transaction it is
 * a no-op that emits a 25P01 notice, which createDb() filters out (see
 * client.ts).
 */
async function fenceAndRecycle(fence: ReservedConnectionFence, reserved: ReservedSql, reason: string): Promise<void> {
  // Synchronous, before anything is enqueued: from here on the orphan's
  // queries throw instead of reaching the wire, so the statements below are
  // guaranteed to be the last traffic this connection ever sees under this
  // scope.
  fence.close();

  let settled = false;
  const teardown = (async () => {
    try {
      await reserved`ROLLBACK`;
      await reserved`RESET app.current_company_id`;
      reserved.release();
    } catch (err) {
      // Same "never recycle with unknown state" precedent as
      // resetClaimAndRelease's catch branch: the claim state is unknown, so
      // the connection is abandoned rather than handed to another tenant.
      // postgres.js destroys a connection whose query errored at the
      // transport level anyway, so this is not the routine path.
      console.error(`company-scope: ${reason}: failed to reset the fenced connection before recycling it`, err);
    } finally {
      settled = true;
    }
  })();

  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    teardown,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FENCED_TEARDOWN_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (!settled) {
    console.error(
      `company-scope: ${reason}: the fenced connection is still queued behind an in-flight query after ` +
        `${FENCED_TEARDOWN_TIMEOUT_MS}ms; it will be reset and released in the background once that query finishes`,
    );
  }
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
  const fence = fenceReservedConnection(reserved);
  const liveness: ReservedScopeLiveness = { released: false, inFlight: 0, onDrained: null };
  let unsafeToRelease = false;
  try {
    await reserved`select set_config('app.current_company_id', ${companyId}, false)`;
    const scopedDb = drizzlePg(fence.client, { schema });
    return await requestCompanyScopeStorage.run({ kind: "scoped", companyId, scopedDb, liveness }, fn);
  } catch (err) {
    if (err instanceof ConnectionReleaseUnsafeError) {
      unsafeToRelease = true;
      return undefined as T;
    }
    throw err;
  } finally {
    // Flip this before the connection actually goes back to the pool, not
    // after -- withCompanyScope reads it from other (possibly still
    // in-flight) continuations of this same scope, and must never see
    // "still safe to reuse" once release has been kicked off. New calls
    // stop reusing this connection right here; DUR-920: any call that
    // already committed to reusing it (read `released === false` a moment
    // earlier, e.g. a fire-and-forget continuation) is tracked in
    // `liveness.inFlight` and must be waited out -- bounded -- before the
    // connection actually goes back to the pool, or it could be handed to
    // an unrelated request while still mid-transaction.
    //
    // DUR-3931: this is now also set on the aborted-response path. It used
    // to deliberately stay `false` there so an orphaned continuation could
    // keep using the (permanently abandoned) connection. That traded a
    // guaranteed connection leak for the convenience of an orphan whose
    // response socket is already gone -- not a trade worth making, and the
    // reason ten browser reloads could wedge the server.
    liveness.released = true;
    if (unsafeToRelease) {
      // The response was aborted while the handler chain may still be
      // running. Fence the connection so the orphan can issue nothing more,
      // then roll back/reset it behind whatever it already had in flight and
      // recycle it. See fenceAndRecycle.
      await fenceAndRecycle(fence, reserved, "response closed before its handler finished");
    } else {
      await waitForInFlightDrain(liveness);
      if (liveness.inFlight > 0) {
        // Bound hit while calls were still in flight. DUR-3931: fence and
        // recycle rather than abandon -- the fence is what makes recycling
        // safe here, exactly as on the aborted-response path above.
        console.error(
          `company-scope: ${liveness.inFlight} runOnReservedScope() call(s) still in flight ` +
            `${IN_FLIGHT_DRAIN_TIMEOUT_MS}ms after release was requested; fencing them off the reserved ` +
            "connection so it can be reset and recycled instead of leaked",
        );
        await fenceAndRecycle(fence, reserved, "in-flight calls blew the drain bound");
      } else {
        await resetClaimAndRelease(reserved);
      }
    }
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
  const fence = fenceReservedConnection(reserved);
  const liveness: ReservedScopeLiveness = { released: false, inFlight: 0, onDrained: null };
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

    const scopedDb = drizzlePg(fence.client, { schema });
    await scopedDb.insert(crossCompanyAccessLog).values({
      reason: opts.reason,
      actorType: opts.actorType ?? null,
      actorId: opts.actorId ?? null,
      route: opts.route ?? null,
      companyIdsTouched: opts.companyIdsTouched ?? null,
    });

    return await requestCompanyScopeStorage.run({ kind: "bypass", scopedDb, liveness }, fn);
  } finally {
    // DUR-920: see the matching comment in runInCompanyScope -- wait for any
    // call that already committed to reusing this connection to drain
    // (bounded) before releasing it, instead of releasing underneath it.
    liveness.released = true;
    await waitForInFlightDrain(liveness);
    if (liveness.inFlight > 0) {
      // DUR-3931: fence and recycle rather than abandon -- see the matching
      // branch in runInCompanyScope.
      console.error(
        `company-scope: ${liveness.inFlight} runOnReservedScope() call(s) still in flight ` +
          `${IN_FLIGHT_DRAIN_TIMEOUT_MS}ms after release was requested; fencing them off the reserved ` +
          "connection so it can be reset and recycled instead of leaked",
      );
      await fenceAndRecycle(fence, reserved, "in-flight bypass calls blew the drain bound");
    } else {
      await resetClaimAndRelease(reserved);
    }
  }
}

/**
 * DUR-3952: run `fn` on the shared pool, detached from whatever request/tick
 * scope is active, for as long as it takes.
 *
 * This exists for the one class of work runInCompanyScope/runInCompanyScopeBypass
 * are the wrong tool for: a continuation that is *meant* to outlive the
 * request or scheduler tick that started it. The canonical case is a
 * dispatched heartbeat run -- startNextQueuedRunForAgent() fires executeRun()
 * and returns, the tick's bypass scope is released seconds later, and the run
 * keeps issuing queries for minutes or hours. Reserving a connection for that
 * long (one per in-flight run) would pin the pool; leaving the run in the
 * tick's AsyncLocalStorage context made every query after release hit the
 * DUR-932 liveness guard (the 2026-09-06 fleet outage: every run "Process
 * lost", ~1160 ConnectionFencedError lines in 45 minutes), and before that
 * guard existed the same queries silently ran on the tick's already-recycled
 * connection, interleaved with whichever request the pool handed it to next.
 *
 * Inside `fn`, createRequestScopedDb resolves straight to the raw pool (no
 * company claim on the session -- set per transaction by withCompanyScope,
 * which opens its own `db.transaction()` here rather than trying to BEGIN on
 * "the reserved connection", see its pooled-scope branch). `rawDb` may be the
 * request-scoped proxy itself: it is unwrapped to the pool behind it, so a
 * service constructed with only the proxy can still detach safely.
 */
export function runInPooledScope<T>(rawDb: Db, fn: () => Promise<T>): Promise<T> {
  const pool = unwrapRequestScopedDb(rawDb);
  const liveness: ReservedScopeLiveness = { released: false, inFlight: 0, onDrained: null };
  return requestCompanyScopeStorage.run({ kind: "pooled", scopedDb: pool, liveness }, fn);
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
// DUR-257/DUR-381: lets withCompanyScope()/withCompanyScopeBypass() reach the
// raw pooled Db behind a request-scoped proxy once the proxy's scope has been
// released, so a continuation that outlives its request (executeRun after
// the scheduler tick, a route's fire-and-forget wakeup) can open its own
// connection instead of hitting the proxy's `.transaction()` refusal. Direct
// `proxy.transaction()` calls are still refused -- only these two helpers,
// which set the company claim on the connection they open, unwrap.
const REQUEST_SCOPED_RAW_DB = Symbol.for("paperclip.requestScopedRawDb");

export function unwrapRequestScopedDb(db: Db): Db {
  const raw = (db as unknown as Record<PropertyKey, unknown>)[REQUEST_SCOPED_RAW_DB];
  return (raw as Db | undefined) ?? db;
}

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
        if (path.length === 0 && prop === REQUEST_SCOPED_RAW_DB) return rawDb;
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
        // DUR-932 (re-landed by DUR-3952): a fire-and-forget continuation
        // spawned from inside a runInCompanyScope()-wrapped handler or
        // scheduler tick (`void someCall()`, a `.then()` chain never awaited,
        // a dispatched heartbeat run) keeps this same AsyncLocalStorage
        // context alive after the handler itself returns. If the outer
        // runInCompanyScope has already reset+released the reserved
        // connection by then (`store.liveness.released`), calling straight
        // through to `store.scopedDb` here -- unlike withCompanyScope/
        // tx.transaction(), which route through runOnReservedScope and get
        // DUR-926/DUR-920's liveness check -- would hand back a query bound
        // to an already-recycled physical connection. A second, unrelated
        // request can already be issuing its own queries on that same
        // connection by the time this one lands, corrupting Postgres's
        // extended-query protocol for both (surfaced as "bind message
        // supplies N parameters, but prepared statement requires M") instead
        // of failing loudly here.
        //
        // Thrown as ConnectionFencedError so it is the same error type the
        // connection-level fence (DUR-3931, fenceReservedConnection) raises:
        // this proxy check simply fires first, with a more precise message.
        // `liveness` is optional-chained: server test doubles enter the ALS
        // with a bare `{ kind, companyId, scopedDb }` store, and a missing
        // liveness must mean "not released", not a TypeError-turned-500.
        //
        // The first landing of this guard (PR #229) took the whole fleet down
        // because the scheduler's executeRun() legitimately outlives its
        // tick's scope and was still parked in that context. Work that is
        // meant to outlive its request/tick must run under runInPooledScope
        // (whose liveness never flips) -- see that helper and DUR-3952.
        if (store.liveness?.released) {
          throw new ConnectionFencedError(
            `createRequestScopedDb: attempted to use "${describePath(path, prop)}" after the ` +
              "runInCompanyScope/runInCompanyScopeBypass call that reserved this connection already " +
              "released it (DUR-932) -- this db reference outlived its request/scheduler scope, most " +
              "likely via a fire-and-forget continuation the handler never awaited. Await it inside the " +
              "scope, detach it with runInPooledScope(rawDb, ...), or run it through " +
              "withCompanyScope(rawDb, ...) on its own connection.",
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
