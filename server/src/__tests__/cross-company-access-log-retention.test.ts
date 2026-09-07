import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, crossCompanyAccessLog } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pruneCrossCompanyAccessLog } from "../services/cross-company-access-log-retention.js";
import {
  resolveCrossCompanyAccessLogRetention,
  resolveSchedulerBypassAuditCoalesceMs,
} from "../config.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cross-company access log retention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("cross-company access log retention config (DUR-386)", () => {
  it("defaults to enabled, 30 days, hourly", () => {
    expect(resolveCrossCompanyAccessLogRetention({})).toEqual({ enabled: true, retentionDays: 30, intervalMinutes: 60 });
  });

  it("can be switched off with an explicit false/0", () => {
    expect(resolveCrossCompanyAccessLogRetention({ PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_ENABLED: "false" }).enabled).toBe(false);
    expect(resolveCrossCompanyAccessLogRetention({ PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_ENABLED: "0" }).enabled).toBe(false);
    expect(resolveCrossCompanyAccessLogRetention({ PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_ENABLED: "true" }).enabled).toBe(true);
  });

  it("clamps the window and cadence to at least one day / one minute and ignores garbage", () => {
    expect(
      resolveCrossCompanyAccessLogRetention({
        PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS: "7",
        PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_INTERVAL_MINUTES: "15",
      }),
    ).toMatchObject({ retentionDays: 7, intervalMinutes: 15 });
    expect(
      resolveCrossCompanyAccessLogRetention({
        PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS: "0",
        PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_INTERVAL_MINUTES: "-3",
      }),
    ).toMatchObject({ retentionDays: 30, intervalMinutes: 1 });
    expect(
      resolveCrossCompanyAccessLogRetention({ PAPERCLIP_CROSS_COMPANY_ACCESS_LOG_RETENTION_DAYS: "lots" }),
    ).toMatchObject({ retentionDays: 30 });
  });

  it("scheduler audit coalescing defaults to one row per chain per hour, 0 disables it", () => {
    expect(resolveSchedulerBypassAuditCoalesceMs({})).toBe(60 * 60 * 1000);
    expect(resolveSchedulerBypassAuditCoalesceMs({ PAPERCLIP_SCHEDULER_BYPASS_AUDIT_COALESCE_MINUTES: "0" })).toBe(0);
    expect(resolveSchedulerBypassAuditCoalesceMs({ PAPERCLIP_SCHEDULER_BYPASS_AUDIT_COALESCE_MINUTES: "5" })).toBe(5 * 60 * 1000);
    expect(resolveSchedulerBypassAuditCoalesceMs({ PAPERCLIP_SCHEDULER_BYPASS_AUDIT_COALESCE_MINUTES: "-1" })).toBe(60 * 60 * 1000);
    expect(resolveSchedulerBypassAuditCoalesceMs({ PAPERCLIP_SCHEDULER_BYPASS_AUDIT_COALESCE_MINUTES: "soon" })).toBe(60 * 60 * 1000);
  });
});

describeEmbeddedPostgres("cross-company access log retention sweep (DUR-386)", () => {
  let db!: ReturnType<typeof createDb>;
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

  async function seedRow(occurredAt: Date, reason = "scheduler tick") {
    const [row] = await db
      .insert(crossCompanyAccessLog)
      .values({ reason, route: "heartbeat-scheduler:test", occurredAt })
      .returning({ id: crossCompanyAccessLog.id });
    return row!.id;
  }

  function daysAgo(days: number) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  it("deletes rows older than the retention window and leaves recent rows alone", async () => {
    const oldId = await seedRow(daysAgo(40));
    const recentId = await seedRow(daysAgo(5));
    const todayId = await seedRow(new Date());

    const deleted = await pruneCrossCompanyAccessLog(db, 30);
    expect(deleted).toBe(1);

    const remaining = (await db.select({ id: crossCompanyAccessLog.id }).from(crossCompanyAccessLog)).map((r) => r.id).sort();
    expect(remaining).toEqual([recentId, todayId].sort());
    expect(remaining).not.toContain(oldId);
  });

  it("honours a shorter configured window", async () => {
    await seedRow(daysAgo(10));
    await seedRow(daysAgo(2));
    const deleted = await pruneCrossCompanyAccessLog(db, 7);
    expect(deleted).toBe(1);
    const count = (await db.execute(sql`select count(*)::int as count from cross_company_access_log`)) as unknown as {
      count: number;
    }[];
    expect(count[0]?.count).toBe(1);
  });

  it("batches deletes instead of issuing one unbounded DELETE", async () => {
    await Promise.all(Array.from({ length: 7 }, () => seedRow(daysAgo(45))));
    // batchSize=3 over 7 stale rows forces 3 iterations (3 + 3 + 1).
    const deleted = await pruneCrossCompanyAccessLog(db, 30, 3);
    expect(deleted).toBe(7);
    const remaining = await db.select({ id: crossCompanyAccessLog.id }).from(crossCompanyAccessLog);
    expect(remaining).toHaveLength(0);
  });

  it("is a no-op on an empty or fully-recent table", async () => {
    expect(await pruneCrossCompanyAccessLog(db, 30)).toBe(0);
    await seedRow(new Date());
    expect(await pruneCrossCompanyAccessLog(db, 30)).toBe(0);
  });
});
