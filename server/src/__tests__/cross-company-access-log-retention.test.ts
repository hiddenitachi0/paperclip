import { describe, expect, it } from "vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createDb, crossCompanyAccessLog } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS,
  pruneCrossCompanyAccessLog,
} from "../services/cross-company-access-log-retention.js";
import { resolveCrossCompanyAccessLogRetentionEnabled } from "../config.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cross-company access log retention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("cross-company access log retention settings (DUR-386)", () => {
  it("keeps the audit trail for a quarter by default", () => {
    expect(DEFAULT_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS).toBe(90);
  });

  it("is on by default, so the table cannot grow forever unattended", () => {
    expect(resolveCrossCompanyAccessLogRetentionEnabled({})).toBe(true);
  });

  it("can be switched off, and accepts the spellings an operator is likely to use", () => {
    for (const value of ["false", "FALSE", " false ", "0", "off", "no"]) {
      expect(
        resolveCrossCompanyAccessLogRetentionEnabled({
          PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_ENABLED: value,
        }),
        `"${value}" should disable the sweep`,
      ).toBe(false);
    }
    for (const value of ["true", "1", "yes", ""]) {
      expect(
        resolveCrossCompanyAccessLogRetentionEnabled({
          PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_ENABLED: value,
        }),
        `"${value}" should leave the sweep on`,
      ).toBe(true);
    }
  });
});

describeEmbeddedPostgres("cross-company access log retention sweep (DUR-386)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-company-access-log-retention-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(crossCompanyAccessLog);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedEntry(ageDays: number, reason: string) {
    const [row] = await db
      .insert(crossCompanyAccessLog)
      .values({
        reason,
        actorType: "user",
        route: "/board-api-keys",
        occurredAt: new Date(Date.now() - ageDays * DAY_MS),
      })
      .returning({ id: crossCompanyAccessLog.id });
    return row!.id;
  }

  async function remainingReasons(): Promise<string[]> {
    const rows = await db.select({ reason: crossCompanyAccessLog.reason }).from(crossCompanyAccessLog);
    return rows.map((row) => row.reason).sort();
  }

  it("deletes only entries older than the retention period", async () => {
    await seedEntry(120, "ancient");
    await seedEntry(91, "just-past-the-window");
    await seedEntry(89, "just-inside-the-window");
    await seedEntry(1, "yesterday");

    const deleted = await pruneCrossCompanyAccessLog(db, DEFAULT_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS);

    expect(deleted).toBe(2);
    expect(await remainingReasons()).toEqual(["just-inside-the-window", "yesterday"]);
  });

  it("never deletes anything when every entry is inside the window", async () => {
    await seedEntry(10, "recent-a");
    await seedEntry(80, "recent-b");

    expect(await pruneCrossCompanyAccessLog(db, DEFAULT_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS)).toBe(0);
    expect(await remainingReasons()).toEqual(["recent-a", "recent-b"]);
  });

  it("deletes in bounded batches rather than one unbounded DELETE", async () => {
    for (let i = 0; i < 7; i++) await seedEntry(120, `stale-${i}`);
    await seedEntry(1, "fresh");

    // Count the statements the sweep issues: 7 stale rows at batchSize 3 must
    // take 3 bounded deletes (3 + 3 + 1), not one statement over everything.
    let statements = 0;
    const countingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return (...args: unknown[]) => {
            statements++;
            return (target.execute as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;

    const deleted = await pruneCrossCompanyAccessLog(countingDb, 90, 3);

    expect(deleted).toBe(7);
    expect(statements).toBe(3);
    expect(await remainingReasons()).toEqual(["fresh"]);
  });

  it("honours a shorter configured retention period", async () => {
    await seedEntry(10, "ten-days-old");
    await seedEntry(2, "two-days-old");

    expect(await pruneCrossCompanyAccessLog(db, 7)).toBe(1);
    expect(await remainingReasons()).toEqual(["two-days-old"]);
  });

  it("honours a longer configured retention period", async () => {
    await seedEntry(200, "two-hundred-days-old");

    expect(await pruneCrossCompanyAccessLog(db, 365)).toBe(0);
    expect(await remainingReasons()).toEqual(["two-hundred-days-old"]);
  });
});
