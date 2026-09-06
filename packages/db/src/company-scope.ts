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
  const activeScope = requestCompanyScopeStorage.getStore();
  if (activeScope && !activeScope.liveness.released) {
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
  // DUR-3941: set when this scope's reserved connection has been taken away
  // from everything that could still reach it (see gateReservedConnection).
  // `released` says "do not START new work on this connection"; `revoked`
  // says "this connection is gone -- every query issued through this scope
  // from here on fails loudly instead of reaching the wire", which is what
  // makes a connection whose safety is unknown reclaimable rather than
  // permanently leaked. See reclaimUnsafeConnection.
  revoked: boolean;
}

function newReservedScopeLiveness(): ReservedScopeLiveness {
  return { released: false, inFlight: 0, onDrained: null, revoked: false };
}

/**
 * DUR-3941: thrown when anything tries to issue a query on a reserved
 * connection after that connection has been revoked and handed back to the
 * pool. Only reachable from code that outlived the request/tick whose scope
 * reserved the connection (an orphaned handler continuation after a client
 * abort, or a captured `tx`/`scopedDb` reference) -- exactly the code whose
 * queries must never land on a connection somebody else now owns.
 */
export class ReservedConnectionRevokedError extends Error {
  constructor() {
    super(
      "company-scope: this query was issued on a reserved connection that its owning request/tick scope has " +
        "already given up (the response was aborted, or the scope could not be closed cleanly). The physical " +
        "connection has been reclaimed by the pool and may now be serving an unrelated company, so the query " +
        "is refused instead of being put on that connection's wire. Do not keep using a request's db/tx " +
        "reference after the request itself is over.",
    );
    this.name = "ReservedConnectionRevokedError";
  }
}

/**
 * DUR-3941: wraps the reserved connection handed to drizzle so that every
 * query issued through this scope -- by the createRequestScopedDb proxy, by
 * withCompanyScope's reuse of `scopedDb`, or by a `tx` reference somebody
 * captured -- passes through one chokepoint that can be shut off.
 *
 * That chokepoint is what makes reclaiming an unsafe connection possible at
 * all. Before it existed, "an orphaned handler might still issue queries on
 * this connection" could only be answered by never handing the connection
 * back (see reclaimUnsafeConnection for why that was worse). With it, the
 * answer is "it cannot -- it gets a ReservedConnectionRevokedError instead."
 *
 * `reserved` itself (the ungated handle) stays private to this module, so
 * runInCompanyScope can still issue its own close-out statements after the
 * gate is shut.
 */
function gateReservedConnection(reserved: ReservedSql, liveness: ReservedScopeLiveness): ReservedSql {
  const assertUsable = (): void => {
    if (liveness.revoked) throw new ReservedConnectionRevokedError();
  };
  return new Proxy(reserved as unknown as (...args: unknown[]) => unknown, {
    // Tagged-template calls: sql`select ...`
    apply(target, thisArg, args: unknown[]) {
      assertUsable();
      return Reflect.apply(target, thisArg === undefined ? reserved : thisArg, args);
    },
    // Everything drizzle's postgres-js driver reaches for: `.unsafe(...)`,
    // `.options`, `.types`, ... Data properties pass straight through;
    // callables are wrapped so they cannot fire after the revoke.
    get(_target, prop) {
      const value = (reserved as unknown as Record<PropertyKey, unknown>)[prop];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        assertUsable();
        return (value as (...args: unknown[]) => unknown).apply(reserved, args);
      };
    },
  }) as unknown as ReservedSql;
}

// DUR-920: how long runInCompanyScope's finally block waits for in-flight
// runOnReservedScope() calls to drain before releasing the reserved
// connection. Bounded, not unbounded -- an in-flight fire-and-forget call
// that itself never resolves (e.g. it's stuck on a downstream call with no
// timeout of its own) must not block this request's connection from ever
// being released. If the bound is hit, the connection is abandoned instead
// of released (same "never recycle with unknown/unsafe state" precedent as
// resetClaimAndRelease's own catch branch below) rather than risk handing a
// connection with a still-open transaction to an unrelated request.
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
// Throwing this from `fn` signals runInCompanyScope to abandon the
// connection instead -- same "never recycle with unknown state" precedent as
// resetClaimAndRelease's own catch branch below.
export class ConnectionReleaseUnsafeError extends Error {
  constructor() {
    super(
      "company-scope: response stream closed before its handler finished; the handler may still be using this " +
        "connection, so it will not be recycled back to the pool",
    );
    this.name = "ConnectionReleaseUnsafeError";
  }
}

async function resetClaimAndRelease(
  reserved: ReservedSql,
  liveness: ReservedScopeLiveness,
): Promise<void> {
  try {
    await reserved`RESET app.current_company_id`;
    reserved.release();
  } catch (err) {
    // The connection's claim state is now unknown and must never go back to
    // the pool for something else to inherit. Hand it to the reclaim path
    // rather than dropping it on the floor -- see reclaimUnsafeConnection.
    // This never throws: it must not mask fn()'s own result or error from
    // the caller's finally block.
    console.error(
      "company-scope: failed to reset session claim before release; quarantining the connection instead of recycling it as-is",
      err,
    );
    reclaimUnsafeConnection(reserved, liveness, "the session-claim reset before release failed");
  }
}

// DUR-3941: how long a connection that cannot be recycled *right now* is left
// alone before it is taken away and reclaimed.
//
// The one case this window exists for is a client abort (see
// ConnectionReleaseUnsafeError): the response is gone but the route handler
// chain may still be running, and cutting it off mid-write for no reason
// would be gratuitous. Every handler wired through company scope is a plain
// request/response handler -- none of the long-lived SSE routes go through
// this middleware -- so a few seconds is far more than any of them needs to
// finish the work it had already started.
//
// Note what this window is NOT: it is not what makes the reclaim safe. Safety
// comes from revoking the connection (gateReservedConnection) before it is
// handed back, which holds no matter how long or short the window is. The
// window only decides how much of an aborted handler's remaining work still
// gets to happen.
const UNSAFE_CONNECTION_QUARANTINE_MS = 5_000;

/**
 * DUR-3941: reclaim a reserved connection that could not be released on the
 * normal path, instead of leaking it.
 *
 * Every "this connection is not safe to recycle" branch used to resolve the
 * same way: never call `.release()`. That is safe in isolation -- an
 * unreleased connection can never be handed to another request, so it can
 * never leak a claim or interleave wire traffic -- but it is also permanent.
 * postgres.js opens exactly `max` physical connections (10 by default) and
 * has no way to replace one that is simply never given back, so every such
 * branch costs the process one connection *for its whole lifetime*. A browser
 * SPA aborting in-flight fetches on navigation walks straight into that
 * branch as routine behaviour, so the slots drain one by one until
 * `sql.reserve()` blocks forever and the server stops answering any
 * company-scoped request at all -- a far worse failure than the interleaving
 * it was avoiding. (Observed in CI as the last e2e spec file failing 25/25
 * runs, with 3-10 abandoned connections logged per run against the cap of 10.)
 *
 * The blocker was never the connection, it was the orphaned code that might
 * still use it. So take that ability away instead of taking the connection
 * away from the pool:
 *
 *   1. wait out a short quarantine so an orphaned handler that is simply
 *      finishing normally gets to finish (UNSAFE_CONNECTION_QUARANTINE_MS);
 *   2. revoke the scope's gated handle -- from here on every query issued
 *      through this scope throws ReservedConnectionRevokedError instead of
 *      reaching the wire, so nothing can touch this connection again;
 *   3. flip `released` so withCompanyScope acquires its own pooled
 *      connection rather than trying to reuse this scope's;
 *   4. close the connection out and release it.
 *
 * Step 4 needs no in-flight bookkeeping: Postgres answers the statements on
 * one connection in the order it received them, so the `rollback`/`RESET`
 * issued in step 4 can only resolve after every statement already issued on
 * this connection has resolved. Awaiting them is therefore proof that the
 * connection is idle -- and, thanks to step 2, proof that it will stay idle.
 * The `rollback` is there because a revoked call may have been mid-transaction
 * (its own COMMIT/ROLLBACK now throws), and a connection must never go back
 * to the pool with a transaction still open; outside a transaction it is a
 * no-op.
 *
 * If even that fails the connection is genuinely unusable and is dropped the
 * way it always was -- no worse than before, just no longer the default.
 */
function reclaimUnsafeConnection(
  reserved: ReservedSql,
  liveness: ReservedScopeLiveness,
  reason: string,
): void {
  const timer = setTimeout(() => {
    liveness.revoked = true;
    liveness.released = true;
    void (async () => {
      try {
        await reserved`rollback`;
        await reserved`RESET app.current_company_id`;
        reserved.release();
      } catch (err) {
        console.error(
          `company-scope: could not reclaim the reserved connection quarantined because ${reason}; ` +
            "dropping it (one lost pool slot) rather than recycling it in an unknown state",
          err,
        );
      }
    })();
  }, UNSAFE_CONNECTION_QUARANTINE_MS);
  // Never hold the process open just to reclaim a connection: on shutdown the
  // whole pool goes away anyway.
  timer.unref?.();
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
  const liveness = newReservedScopeLiveness();
  let unsafeToRelease = false;
  try {
    await reserved`select set_config('app.current_company_id', ${companyId}, false)`;
    // DUR-3941: drizzle (and therefore everything downstream of it) only ever
    // sees the gated handle, never `reserved` itself.
    const scopedDb = drizzlePg(gateReservedConnection(reserved, liveness), { schema });
    return await requestCompanyScopeStorage.run({ kind: "scoped", companyId, scopedDb, liveness }, fn);
  } catch (err) {
    if (err instanceof ConnectionReleaseUnsafeError) {
      unsafeToRelease = true;
      return undefined as T;
    }
    throw err;
  } finally {
    if (unsafeToRelease) {
      // The connection cannot be recycled right now: the response is gone but
      // the handler chain may still be running on it, so `liveness.released`
      // deliberately stays `false` for the length of the quarantine and the
      // orphaned continuation keeps working on a connection nothing else can
      // acquire. DUR-3941: it is then revoked and reclaimed rather than lost
      // forever -- see reclaimUnsafeConnection for why leaking it was the
      // worse of the two failures.
      console.error(
        "company-scope: response closed before its handler finished; quarantining the reserved connection " +
          `for ${UNSAFE_CONNECTION_QUARANTINE_MS}ms instead of recycling it now, since the handler may still ` +
          "be using it",
      );
      reclaimUnsafeConnection(reserved, liveness, "the response closed before its handler finished");
    } else {
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
      liveness.released = true;
      await waitForInFlightDrain(liveness);
      if (liveness.inFlight > 0) {
        // Bound hit while calls were still in flight: recycling now could hand
        // an unrelated request a connection that is still mid-transaction.
        // DUR-3941: quarantine and reclaim it instead of losing the pool slot.
        console.error(
          `company-scope: ${liveness.inFlight} runOnReservedScope() call(s) still in flight ` +
            `${IN_FLIGHT_DRAIN_TIMEOUT_MS}ms after release was requested; quarantining the reserved connection ` +
            "instead of recycling it now, since it may still be mid-transaction",
        );
        reclaimUnsafeConnection(reserved, liveness, "in-flight calls did not drain before release");
      } else {
        await resetClaimAndRelease(reserved, liveness);
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
  const liveness = newReservedScopeLiveness();
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

    // DUR-3941: see runInCompanyScope -- drizzle only ever sees the gated handle.
    const scopedDb = drizzlePg(gateReservedConnection(reserved, liveness), { schema });
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
      console.error(
        `company-scope: ${liveness.inFlight} runOnReservedScope() call(s) still in flight ` +
          `${IN_FLIGHT_DRAIN_TIMEOUT_MS}ms after release was requested; quarantining the reserved connection ` +
          "instead of recycling it now, since it may still be mid-transaction",
      );
      reclaimUnsafeConnection(reserved, liveness, "in-flight calls did not drain before release");
    } else {
      await resetClaimAndRelease(reserved, liveness);
    }
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
