// DUR-3991: regression tests for how postgres.js hands out reserved
// connections, run against a real (embedded) Postgres.
//
// Background: postgres@3.4.9 lost a queued `reserve()` request whenever a
// pool connection closed while requests were waiting (its onclose() took the
// request off the queue and handed it to a reconnect that never serves
// reserve requests). The promise never settled. In production that made the
// first scheduler tick after every restart hang for 5 minutes. The library
// is patched in patches/postgres@3.4.9.patch; these tests pin the patched
// behaviour, and the last one pins company-scope's time limit on reserve().
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  ConnectionReserveTimeoutError,
  RESERVE_CONNECTION_TIMEOUT_MS,
  reserveConnectionWithTimeout,
} from "./company-scope.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Tracked = { state: "pending" | "ok" | "error" };
function track(promise: Promise<unknown>): Tracked {
  const tracked: Tracked = { state: "pending" };
  promise.then(
    () => {
      tracked.state = "ok";
    },
    () => {
      tracked.state = "error";
    },
  );
  return tracked;
}

/** Waits until `done()` is true or `timeoutMs` passes, without failing on timeout. */
async function waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await sleep(50);
}

/**
 * A TCP forwarder to Postgres that can be taken down (refusing new
 * connections, like a database that is restarting) and brought back on the
 * same port. Connections already established are left alone.
 */
async function startProxy(targetConnectionString: string) {
  const target = new URL(targetConnectionString);
  const sockets = new Set<net.Socket>();
  let server: net.Server | null = null;
  let port = 0;

  const up = () =>
    new Promise<void>((resolve, reject) => {
      const s = net.createServer((client) => {
        const upstream = net.connect(Number(target.port), target.hostname);
        sockets.add(client);
        sockets.add(upstream);
        client.pipe(upstream);
        upstream.pipe(client);
        const closeBoth = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on("error", closeBoth);
        upstream.on("error", closeBoth);
        client.on("close", closeBoth);
        upstream.on("close", closeBoth);
      });
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => {
        port = (s.address() as net.AddressInfo).port;
        server = s;
        resolve();
      });
    });

  const down = async () => {
    const s = server;
    server = null;
    // close() stops accepting at once, but its callback only fires once the
    // already-open connections end, which the held one never does -- so do
    // not wait for it.
    s?.close();
    await sleep(50);
  };

  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await down();
  };

  await up();
  const viaProxy = new URL(targetConnectionString);
  viaProxy.hostname = "127.0.0.1";
  viaProxy.port = String(port);
  return { connectionString: viaProxy.toString(), up, down, stop };
}

describeEmbeddedPostgres("postgres.js reserve() pool behaviour (DUR-3991)", () => {
  let database: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-db-reserve-pool-");
  }, 120_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it(
    "serves every queued reservation when an idle connection closes as they arrive",
    async () => {
      // Same shape as the production pools (createDb: max 10), but with a
      // 2-second idle timeout instead of 30 so the test is quick. This
      // override only exists here; production settings are unchanged.
      const idleTimeoutSeconds = 2;
      const sql = postgres(database!.connectionString, {
        max: 10,
        idle_timeout: idleTimeoutSeconds,
        onnotice: () => {},
      });
      try {
        // Like start-up recovery: use one connection and hand it back, which
        // starts its idle timer.
        const first = await sql.reserve();
        await first`select 1`;
        first.release();

        // Like the first scheduler tick: exactly one idle timeout later
        // (registered after the idle timer, so it fires just after it, while
        // that connection is closing), more reservations than the pool holds.
        await sleep(idleTimeoutSeconds * 1000);
        const reservations = Array.from({ length: 16 }, () =>
          track(
            (async () => {
              const reserved = await sql.reserve();
              try {
                await reserved`select pg_sleep(0.05)`;
              } finally {
                reserved.release();
              }
            })(),
          ),
        );

        await waitUntil(() => reservations.every((r) => r.state !== "pending"), 10_000);
        // Unpatched postgres@3.4.9: ["pending", "ok" x 15] -- the first one is lost for good.
        expect(reservations.map((r) => r.state)).toEqual(Array(16).fill("ok"));
      } finally {
        await sql.end({ timeout: 1 });
      }
    },
    30_000,
  );

  it(
    "does not leak a pool slot when reconnecting fails while reservations are waiting",
    async () => {
      const proxy = await startProxy(database!.connectionString);
      const sql = postgres(proxy.connectionString, {
        max: 2,
        idle_timeout: 0,
        connect_timeout: 5,
        onnotice: () => {},
      });
      const held: postgres.ReservedSql[] = [];
      try {
        // Pool of 2, one connection held throughout the outage.
        const a = await sql.reserve();
        await a`select 1`;

        // Database unreachable while two more reservations wait.
        await proxy.down();
        const b = track(sql.reserve().then((r) => r.release()));
        const b2 = track(sql.reserve().then((r) => r.release()));
        await sleep(1500);

        // Database back.
        await proxy.up();
        await waitUntil(() => b.state !== "pending" && b2.state !== "pending", 5_000);
        a.release();

        // The pool must still be able to hand out both of its connections at
        // the same time. A patch that keeps a failed request in the queue
        // later hands it a connection nobody releases, and one of these two
        // then waits forever.
        const c = track(sql.reserve().then((r) => held.push(r)));
        const d = track(sql.reserve().then((r) => held.push(r)));
        await waitUntil(() => c.state !== "pending" && d.state !== "pending", 8_000);
        expect({ c: c.state, d: d.state, heldAtOnce: held.length }).toEqual({ c: "ok", d: "ok", heldAtOnce: 2 });
        // The requests made during the outage must have finished one way or
        // the other (failed, or served once the database was back) -- never
        // left hanging.
        expect(b.state).not.toBe("pending");
        expect(b2.state).not.toBe("pending");
      } finally {
        for (const r of held) r.release();
        await sql.end({ timeout: 1 });
        await proxy.stop();
      }
    },
    40_000,
  );

  it(
    "company-scope's reserve time limit rejects a reservation that cannot be served, and hands back a late connection",
    async () => {
      expect(RESERVE_CONNECTION_TIMEOUT_MS).toBe(30_000);

      const sql = postgres(database!.connectionString, { max: 1, idle_timeout: 0, onnotice: () => {} });
      try {
        // The only connection is taken, so the next reservation cannot be served.
        const holder = await sql.reserve();
        await holder`select 1`;

        const startedAt = Date.now();
        const attempt = reserveConnectionWithTimeout(sql, "test: pool of one already taken", 300);
        await expect(attempt).rejects.toBeInstanceOf(ConnectionReserveTimeoutError);
        await expect(attempt).rejects.toThrow(/gave up waiting for a free database connection after 300ms/);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(290);

        // The abandoned request is still queued inside postgres.js, so it is
        // the one that gets this connection next. It must hand it straight
        // back; otherwise this one-connection pool is gone for good.
        holder.release();
        const next = track(
          (async () => {
            const reserved = await sql.reserve();
            await reserved`select 1`;
            reserved.release();
          })(),
        );
        await waitUntil(() => next.state !== "pending", 5_000);
        expect(next.state).toBe("ok");

        // And a reservation that can be served is returned normally.
        const served = await reserveConnectionWithTimeout(sql, "test: free pool", 2_000);
        const [row] = await served`select 1 as one`;
        expect(row?.one).toBe(1);
        served.release();
      } finally {
        await sql.end({ timeout: 1 });
      }
    },
    20_000,
  );
});
