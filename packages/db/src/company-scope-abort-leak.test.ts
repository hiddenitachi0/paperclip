import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { createDb } from "./client.js";
import {
  ConnectionFencedError,
  ConnectionReleaseUnsafeError,
  createRequestScopedDb,
  requestCompanyScopeStorage,
  runInCompanyScope,
  withCompanyScope,
} from "./company-scope.js";
import { companies } from "./schema/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

/**
 * DUR-3931: a client abort (browser navigating away mid-fetch) used to burn
 * the request's reserved connection permanently -- `runInCompanyScope`'s
 * `unsafeToRelease` branch logged and returned without ever calling
 * `reserved.release()`. With the app pool's default `max` of 10, ten aborts
 * wedged the whole server: postgres.js's `reserve()` awaits a promise with no
 * timeout, so every later company-scoped request hung forever.
 */
describeEmbeddedPostgres("DUR-3931: aborted requests must not permanently burn reserved connections", () => {
  let db!: Db;
  let connectionString!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-abort-leak-");
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
    const [company] = await db
      .insert(companies)
      .values({
        name: "DUR-3931 abort leak",
        issuePrefix: `ABL${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      })
      .returning();
    companyId = company!.id;
  }, 60_000);

  afterAll(async () => {
    // Stopping embedded Postgres routinely takes longer than vitest's 10s
    // default hook timeout on a loaded machine.
    await tempDb?.cleanup();
  }, 60_000);

  /** A tiny pool, so "all connections burned" is reachable in a few iterations rather than ten. */
  function createTinyPoolDb(max: number): { db: Db; end: () => Promise<void> } {
    const client = postgres(connectionString, { max, onnotice: () => {} });
    return {
      db: drizzlePg(client, {}) as unknown as Db,
      end: () => client.end({ timeout: 5 }),
    };
  }

  async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  it("recycles the reserved connection after a client abort with no work still in flight", async () => {
    const pool = createTinyPoolDb(2);
    try {
      // Three aborts against a two-connection pool: if any of them burned its
      // connection permanently the third reserve() would hang forever.
      for (let i = 0; i < 3; i += 1) {
        await withTimeout(
          runInCompanyScope(pool.db, companyId, async () => {
            throw new ConnectionReleaseUnsafeError();
          }),
          5_000,
          `abort iteration ${i}`,
        );
      }

      // And the pool must still serve real work afterwards.
      const scoped = createRequestScopedDb(pool.db);
      const seen = await withTimeout(
        runInCompanyScope(pool.db, companyId, async () => {
          const rows = (await scoped.execute(
            drizzleSql`select current_setting('app.current_company_id', true) as claim`,
          )) as unknown as { claim: string | null }[];
          return rows[0]?.claim ?? null;
        }),
        5_000,
        "post-abort request",
      );
      expect(seen).toBe(companyId);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it("does not leak the reserved connection when the aborted handler is still mid-query", async () => {
    const pool = createTinyPoolDb(2);
    try {
      for (let i = 0; i < 3; i += 1) {
        const scoped = createRequestScopedDb(pool.db);
        let handlerSettled!: Promise<unknown>;
        await withTimeout(
          runInCompanyScope(pool.db, companyId, async () => {
            // Simulates an Express handler chain still running when `res`
            // emits `close` without `finish`: the middleware's promise
            // rejects while the handler is mid-query.
            handlerSettled = scoped
              .execute(drizzleSql`select pg_sleep(0.25)`)
              .then(
                () => "resolved" as const,
                () => "rejected" as const,
              );
            await new Promise((resolve) => setImmediate(resolve));
            throw new ConnectionReleaseUnsafeError();
          }),
          5_000,
          `mid-query abort iteration ${i}`,
        );
        // Whatever the orphan does, it must not corrupt the connection.
        await withTimeout(handlerSettled, 5_000, "orphaned query settle");
      }

      const scoped = createRequestScopedDb(pool.db);
      const ok = await withTimeout(
        runInCompanyScope(pool.db, companyId, async () => {
          const rows = (await scoped.execute(drizzleSql`select 1 as one`)) as unknown as { one: number }[];
          return rows[0]?.one;
        }),
        5_000,
        "post-mid-query-abort request",
      );
      expect(Number(ok)).toBe(1);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it("fences a late query from the orphaned handler instead of letting it reach the recycled connection", async () => {
    const pool = createTinyPoolDb(2);
    try {
      const scoped = createRequestScopedDb(pool.db);
      let capturedScope!: NonNullable<ReturnType<typeof requestCompanyScopeStorage.getStore>>;
      await withTimeout(
        runInCompanyScope(pool.db, companyId, async () => {
          // The request's own ALS scope, as any fire-and-forget continuation
          // spawned by the handler would still see it.
          capturedScope = requestCompanyScopeStorage.getStore()!;
          throw new ConnectionReleaseUnsafeError();
        }),
        5_000,
        "abort with captured scopedDb",
      );

      // The connection is back in the pool now, so the orphan's late query
      // must fail loudly rather than interleave with whoever holds it next.
      // drizzle wraps driver errors, so the fence shows up as the `cause`.
      const late = await requestCompanyScopeStorage
        .run(capturedScope, () => scoped.execute(drizzleSql`select 1 as one`))
        .then(
          () => null,
          (err: unknown) => err,
        );
      expect(late).not.toBeNull();
      const fenced = late instanceof ConnectionFencedError ? late : (late as { cause?: unknown }).cause;
      expect(fenced).toBeInstanceOf(ConnectionFencedError);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it("does not leak the reserved connection when the aborted handler left a transaction open", async () => {
    const pool = createTinyPoolDb(2);
    try {
      for (let i = 0; i < 3; i += 1) {
        const scoped = createRequestScopedDb(pool.db);
        let handlerSettled!: Promise<unknown>;
        await withTimeout(
          runInCompanyScope(pool.db, companyId, async () => {
            handlerSettled = withCompanyScope(pool.db, companyId, async (tx) => {
              await tx.execute(drizzleSql`select pg_sleep(0.25)`);
              await tx.execute(drizzleSql`select pg_sleep(0.25)`);
            }).then(
              () => "resolved" as const,
              () => "rejected" as const,
            );
            await new Promise((resolve) => setImmediate(resolve));
            throw new ConnectionReleaseUnsafeError();
          }),
          8_000,
          `open-tx abort iteration ${i}`,
        );
        await withTimeout(handlerSettled, 8_000, "orphaned transaction settle");
      }

      // The recycled connection must not still be inside a transaction, and
      // must not carry the previous request's company claim.
      const scoped = createRequestScopedDb(pool.db);
      const claim = await withTimeout(
        runInCompanyScope(pool.db, companyId, async () => {
          const rows = (await scoped.execute(
            drizzleSql`select current_setting('app.current_company_id', true) as claim, txid_current_if_assigned() is null as clean`,
          )) as unknown as { claim: string | null; clean: boolean }[];
          return rows[0];
        }),
        8_000,
        "post-open-tx-abort request",
      );
      expect(claim?.claim).toBe(companyId);
    } finally {
      await pool.end();
    }
  }, 40_000);
});
