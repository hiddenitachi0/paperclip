// Turn-taking for the withCompanyScope() calls that share one reserved
// connection (see company-scope.ts, runOnReservedScope).
//
// Why it exists (DUR-918)
// -----------------------
// Every withCompanyScope() call running inside a runInCompanyScope() or
// runInCompanyScopeBypass() scope reuses that scope's ONE physical connection.
// The outermost such call issues a real `BEGIN`; anything opened while it is
// still open issues a `SAVEPOINT` instead. Depth is assigned in call-start
// order, which is safe on its own -- but nothing about depth assignment stops
// two SIBLING calls (started via Promise.all, or a fire-and-forget
// continuation racing the handler that spawned it) from CLOSING out of order.
// A shallower call's COMMIT/ROLLBACK running while a deeper call's SAVEPOINT
// is still open ends the whole transaction out from under it.
//
// So a call may only issue its finalize statement once it is the DEEPEST call
// still open on the connection. That forces completion order back into the
// same LIFO order depth was assigned in.
//
// Why it is its own file (DUR-3991)
// ---------------------------------
// The first version of this kept one `depth` counter and inferred everything
// from it, and `releaseTurn` assigned `stack.depth = depth` unconditionally.
// Two overlapping siblings were enough to wedge it forever:
//
//   A opens  -> depth 0, counter 1
//   A's callback finishes; A is the deepest open call, so it awaits its COMMIT
//   B opens while that COMMIT is in flight -> depth 1, counter 2
//   A's finally runs releaseTurn(0)        -> counter = 0   <-- B's turn erased
//   B's callback finishes: it waits for the counter to say 2. It never will.
//
// B's promise could never settle. Its chain never returned, its connection
// stayed reserved, and with the DUR-385 single-flight guard in front of it
// every later tick of that scheduler chain was skipped. On production that
// meant no scheduled agent wake-up at all for over twelve hours on 2026-09-17,
// with an idle database -- no long query, no lock wait -- because the thing
// that was stuck was a promise, not a query.
//
// It lives here, separate from the connection handling, because the bug was in
// the bookkeeping and the bookkeeping is now driven directly by
// reserved-scope-turns.test.ts, one interleaving at a time, with no database
// and no timing race. The old logic fails that test.

/**
 * How long a call may wait to become the deepest open call before it gives up
 * and finalizes anyway.
 *
 * Sixty seconds is far longer than any sibling transaction on a single reserved
 * connection has a right to take, and far shorter than the five minutes the
 * scheduler's own wedge watchdog allows before it abandons a chain.
 */
export const DEFAULT_TURN_WAIT_TIMEOUT_MS = 60_000;

export interface ReservedScopeTurnsOptions {
  /** Override for tests. */
  timeoutMs?: number;
  /** Called instead of console.error when a wait gives up. Override for tests. */
  onTimeout?: (depth: number, timeoutMs: number) => void;
}

export interface ReservedScopeTurns {
  /** Register a new call and return its depth (0 = the outermost, real BEGIN). */
  acquire(): number;
  /**
   * Resolves once `depth` is the deepest call still open, so it may issue its
   * COMMIT / RELEASE SAVEPOINT. Always settles -- see the timeout below.
   */
  waitForTurn(depth: number): Promise<void>;
  /** This call has finalized: drop it and wake whoever is deepest now. */
  releaseTurn(depth: number): void;
  /** Depths with a BEGIN/SAVEPOINT outstanding, shallowest first. */
  openDepths(): number[];
  /** True while at least one call is waiting for its turn. */
  waitingCount(): number;
}

export function createReservedScopeTurns(options: ReservedScopeTurnsOptions = {}): ReservedScopeTurns {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_WAIT_TIMEOUT_MS;
  const onTimeout =
    options.onTimeout ??
    ((depth: number, ms: number) => {
      console.error(
        `company-scope: a withCompanyScope() call at depth ${depth} waited ${ms}ms to become the innermost open ` +
          "call on its reserved connection and gave up; finalizing out of order rather than waiting forever " +
          "(DUR-3991). A sibling call on this connection may now fail against an already-ended transaction -- " +
          "that is deliberate, and recoverable, unlike the hang it replaces.",
      );
    });

  /** Next depth to hand out; equals the number of calls currently open. */
  let nextDepth = 0;
  const open = new Set<number>();
  const waiters = new Map<number, () => void>();

  function deepestOpen(): number | null {
    let deepest: number | null = null;
    for (const depth of open) {
      if (deepest === null || depth > deepest) deepest = depth;
    }
    return deepest;
  }

  function acquire(): number {
    const depth = nextDepth;
    nextDepth = depth + 1;
    open.add(depth);
    return depth;
  }

  async function waitForTurn(depth: number): Promise<void> {
    if (deepestOpen() === depth) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        waiters.delete(depth);
        resolve();
      };
      waiters.set(depth, settle);
      // FAIL-OPEN, deliberately. If an ordering nobody has thought of still
      // leaves a call waiting, it gives up, says so loudly, and finalizes
      // anyway -- degrading to the pre-DUR-918 behaviour, where a sibling may
      // find the transaction already ended and fail. One failed chain that
      // runs again on the next tick is categorically better than a chain that
      // never returns. 2026-09-17 is the evidence for that ordering.
      timer = setTimeout(() => {
        onTimeout(depth, timeoutMs);
        settle();
      }, timeoutMs);
      // Never hold the process open during a graceful shutdown.
      if (typeof timer.unref === "function") timer.unref();
    });
  }

  function releaseTurn(depth: number): void {
    open.delete(depth);
    const deepest = deepestOpen();
    // The next depth to hand out sits just above whatever is still open: a call
    // that opens after this one closes reuses the depth it vacated, and a call
    // that opens while a deeper sibling is still open cannot collide with it.
    nextDepth = deepest === null ? 0 : deepest + 1;
    if (deepest === null) return;
    const nextWaiter = waiters.get(deepest);
    if (nextWaiter) {
      waiters.delete(deepest);
      nextWaiter();
    }
  }

  return {
    acquire,
    waitForTurn,
    releaseTurn,
    openDepths: () => [...open].sort((a, b) => a - b),
    waitingCount: () => waiters.size,
  };
}
