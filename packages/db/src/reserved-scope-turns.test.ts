import { describe, expect, it } from "vitest";
import { createReservedScopeTurns } from "./reserved-scope-turns.js";

// DUR-3991: production had no scheduled agent wake-up at all for over twelve
// hours on 2026-09-17. One `tickTimers` chain started after each restart and
// never finished -- the database idle the whole time, no long query, no lock
// wait, one bypass connection reserved and never released. The thing that was
// stuck was a promise: a withCompanyScope() call waiting for a turn on its
// reserved connection that could never come.
//
// Every test below drives one interleaving of the turn bookkeeping directly.
// No database, no timers, no race: the one that reproduces the wedge is the
// third, and the old single-counter logic hangs on it forever.

/** Resolves to "settled" or, after `ms` of real time, "hung". */
async function settlesWithin(promise: Promise<unknown>, ms = 50): Promise<"settled" | "hung"> {
  return Promise.race([
    promise.then(() => "settled" as const),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms)),
  ]);
}

describe("DUR-918 reserved-connection turn order", () => {
  it("lets a lone call finalize immediately", async () => {
    const turns = createReservedScopeTurns();
    const a = turns.acquire();
    expect(a).toBe(0);
    expect(await settlesWithin(turns.waitForTurn(a))).toBe("settled");
    turns.releaseTurn(a);
    expect(turns.openDepths()).toEqual([]);
  });

  it("reuses depth 0 for each call in a sequential run, so each one opens a real BEGIN", () => {
    const turns = createReservedScopeTurns();
    for (let call = 0; call < 5; call += 1) {
      const depth = turns.acquire();
      expect(depth).toBe(0);
      turns.releaseTurn(depth);
    }
  });

  it("holds a shallower call back until its deeper sibling has finalized (the DUR-918 guarantee)", async () => {
    const turns = createReservedScopeTurns();
    const outer = turns.acquire(); // 0 -- BEGIN
    const inner = turns.acquire(); // 1 -- SAVEPOINT

    // The outer call finishes first. It must NOT commit out from under the
    // inner call's still-open savepoint.
    const outerTurn = turns.waitForTurn(outer);
    expect(await settlesWithin(outerTurn)).toBe("hung");

    // The inner call finalizes; the outer one is released the moment it does.
    expect(await settlesWithin(turns.waitForTurn(inner))).toBe("settled");
    turns.releaseTurn(inner);
    expect(await settlesWithin(outerTurn)).toBe("settled");
    turns.releaseTurn(outer);
    expect(turns.openDepths()).toEqual([]);
  });
});

describe("DUR-3991 the wedge: a sibling opening mid-finalize", () => {
  // This is the 2026-09-17 interleaving, exactly. The window it needs is the
  // single database round trip between a call passing its turn and its
  // `finally` running -- which on a busy first tick after a restart is hit
  // routinely.
  it("does not strand a call that opened while another was finalizing", async () => {
    const turns = createReservedScopeTurns();

    // A opens and its callback finishes. A is the only open call, so it takes
    // its turn at once and issues its COMMIT -- which is an await.
    const a = turns.acquire();
    expect(await settlesWithin(turns.waitForTurn(a))).toBe("settled");

    // B opens while that COMMIT is still in flight.
    const b = turns.acquire();
    expect(b).toBe(1);

    // A's `finally` now runs. Under the old bookkeeping this reset the shared
    // counter to 0 and erased B's turn for good.
    turns.releaseTurn(a);

    // B must still be able to finalize. This is the assertion the old logic
    // fails: its promise never settled, its chain never returned, and the
    // scheduler skipped that chain until the server was restarted.
    expect(await settlesWithin(turns.waitForTurn(b))).toBe("settled");
    turns.releaseTurn(b);
    expect(turns.openDepths()).toEqual([]);
    expect(turns.waitingCount()).toBe(0);
  });

  it("survives the same thing happening repeatedly, as a busy tick would", async () => {
    const turns = createReservedScopeTurns();
    let previous = turns.acquire();
    await turns.waitForTurn(previous);

    for (let round = 0; round < 50; round += 1) {
      const next = turns.acquire();
      turns.releaseTurn(previous);
      expect(await settlesWithin(turns.waitForTurn(next))).toBe("settled");
      previous = next;
    }
    turns.releaseTurn(previous);
    expect(turns.openDepths()).toEqual([]);
  });

  it("wakes the call that becomes deepest, not a fixed depth below the one that left", async () => {
    const turns = createReservedScopeTurns();
    const a = turns.acquire(); // 0
    const b = turns.acquire(); // 1
    const c = turns.acquire(); // 2

    const aTurn = turns.waitForTurn(a);
    const bTurn = turns.waitForTurn(b);
    expect(await settlesWithin(aTurn)).toBe("hung");
    expect(await settlesWithin(bTurn)).toBe("hung");

    expect(await settlesWithin(turns.waitForTurn(c))).toBe("settled");
    turns.releaseTurn(c);
    expect(await settlesWithin(bTurn)).toBe("settled");
    expect(await settlesWithin(aTurn)).toBe("hung");
    turns.releaseTurn(b);
    expect(await settlesWithin(aTurn)).toBe("settled");
    turns.releaseTurn(a);
    expect(turns.openDepths()).toEqual([]);
  });
});

describe("DUR-3991 the backstop: a turn wait always ends", () => {
  it("gives up loudly after the timeout instead of waiting forever", async () => {
    const timedOut: Array<{ depth: number; timeoutMs: number }> = [];
    const turns = createReservedScopeTurns({
      timeoutMs: 20,
      onTimeout: (depth, timeoutMs) => timedOut.push({ depth, timeoutMs }),
    });

    const outer = turns.acquire();
    turns.acquire(); // a deeper call that never finalizes

    // Fail-open on purpose: the shallower call finalizes out of order rather
    // than hanging. A sibling may then fail against an ended transaction --
    // recoverable, unlike a chain that never returns.
    expect(await settlesWithin(turns.waitForTurn(outer), 500)).toBe("settled");
    expect(timedOut).toEqual([{ depth: 0, timeoutMs: 20 }]);
  });

  it("does not fire the timeout when the turn arrives normally", async () => {
    const timedOut: number[] = [];
    const turns = createReservedScopeTurns({ timeoutMs: 1_000, onTimeout: (depth) => timedOut.push(depth) });

    const outer = turns.acquire();
    const inner = turns.acquire();
    const outerTurn = turns.waitForTurn(outer);
    turns.releaseTurn(inner);
    expect(await settlesWithin(outerTurn)).toBe("settled");
    turns.releaseTurn(outer);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(timedOut).toEqual([]);
    expect(turns.waitingCount()).toBe(0);
  });
});
