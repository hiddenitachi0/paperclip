import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, createDb, instanceSettings } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { quietModeAlertsService } from "../services/quiet-mode-alerts.js";
import { instanceSettingsService } from "../services/instance-settings.js";

// DUR-3965: on 2026-09-10 a failed deploy left the whole instance in quiet
// mode for 27 minutes. Both companies did zero work, 17 agents sat idle, and
// nothing anywhere said why. The deploy runner now retries its own undo, but
// the platform must not depend on that: if quiet mode has been on longer than
// the window, the operator gets told, in their own Activity feed, in words
// they can act on. The server never clears it itself -- someone may have
// switched it on deliberately.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

describeEmbeddedPostgres("DUR-3965: a quiet mode nobody turned off is never silent", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dur3965-quiet-mode-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  /** Puts the instance into quiet mode as of `activatedAt`, the way the deploy runner does. */
  async function setQuietMode(input: { activatedAt: string | null; actorType?: string; stuckNoticeAt?: string | null }) {
    const svc = instanceSettingsService(db);
    const general = await svc.getGeneral();
    const [row] = await db.select().from(instanceSettings);
    await db
      .update(instanceSettings)
      .set({
        general: {
          ...general,
          quietMode: {
            active: true,
            activatedAt: input.activatedAt,
            activatedBy: { actorType: input.actorType ?? "system", actorId: "deploy-runner", agentId: null },
            deactivatedAt: null,
            snapshot: [],
            stuckNoticeAt: input.stuckNoticeAt ?? null,
          },
        },
      })
      .where(eq(instanceSettings.id, row!.id));
  }

  async function noticeRows() {
    return db.select().from(activityLog).where(eq(activityLog.action, "instance.quiet_mode_stuck"));
  }

  it("writes one plain-language notice per company once quiet mode is past the window", async () => {
    const interior = await seedCompany("Interiørdesign AS");
    const mobler = await seedCompany("Møbler AS");
    const now = new Date("2026-09-10T13:47:00.000Z");
    await setQuietMode({ activatedAt: "2026-09-10T13:20:00.000Z" }); // 27 minutes

    const svc = quietModeAlertsService(db, { thresholdMs: 20 * 60 * 1000 });
    const result = await svc.tick(now);

    expect(result).toMatchObject({ active: true, stuck: true, alerted: 2, activeForMs: 27 * 60 * 1000 });

    const rows = await noticeRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.companyId).sort()).toEqual([interior, mobler].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ actorType: "system", actorId: "quiet-mode-alerts", entityType: "instance_settings" });
      const message = String((row.details as Record<string, unknown>).message ?? "");
      expect(message).toContain("Everything is paused.");
      expect(message).toContain("put in quiet mode for a deploy at");
      expect(message).toContain("(27 minutes ago) and never taken out of it");
      expect(message).toContain("no agent in any company will do any work until it is cleared");
      expect(message).toContain("Settings > Instance settings > General");
      // Operator-facing: no ids, no field names, no ticket numbers.
      expect(message).not.toMatch(/quietMode|activatedBy|actorType|DUR-|[0-9a-f]{8}-[0-9a-f]{4}/);
    }
  });

  it("says it once per activation, not on every scheduler tick", async () => {
    await seedCompany("Interiørdesign AS");
    const now = new Date("2026-09-10T13:47:00.000Z");
    await setQuietMode({ activatedAt: "2026-09-10T13:20:00.000Z" });

    const svc = quietModeAlertsService(db, { thresholdMs: 20 * 60 * 1000 });
    expect((await svc.tick(now)).alerted).toBe(1);
    expect((await svc.tick(new Date("2026-09-10T13:48:00.000Z"))).alerted).toBe(0);
    expect((await svc.tick(new Date("2026-09-10T14:30:00.000Z"))).alerted).toBe(0);
    expect(await noticeRows()).toHaveLength(1);
  });

  it("stays quiet while quiet mode is inside the window, and never clears it by itself", async () => {
    await seedCompany("Interiørdesign AS");
    await setQuietMode({ activatedAt: "2026-09-10T13:40:00.000Z" }); // 7 minutes

    const svc = quietModeAlertsService(db);
    const result = await svc.tick(new Date("2026-09-10T13:47:00.000Z"));

    expect(result).toMatchObject({ active: true, stuck: false, alerted: 0 });
    expect(await noticeRows()).toHaveLength(0);
    // Surfacing is the whole job: the switch itself is left exactly as it was.
    expect((await instanceSettingsService(db).getGeneral()).quietMode.active).toBe(true);
  });

  it("treats a quiet mode with no recorded start time as stuck rather than as fine", async () => {
    await seedCompany("Interiørdesign AS");
    await setQuietMode({ activatedAt: null });

    const result = await quietModeAlertsService(db).tick(new Date("2026-09-10T13:47:00.000Z"));

    expect(result).toMatchObject({ active: true, stuck: true, alerted: 1 });
    const [row] = await noticeRows();
    expect(String((row!.details as Record<string, unknown>).message)).toContain("Everything is paused.");
  });

  it("does nothing when quiet mode is off, and forgets it said anything so the next one is reported afresh", async () => {
    await seedCompany("Interiørdesign AS");
    const svc = quietModeAlertsService(db, { thresholdMs: 20 * 60 * 1000 });

    await setQuietMode({ activatedAt: "2026-09-10T13:20:00.000Z" });
    expect((await svc.tick(new Date("2026-09-10T13:47:00.000Z"))).alerted).toBe(1);

    // Someone (or the deploy runner's own retry) clears quiet mode.
    await instanceSettingsService(db).deactivateQuietMode({ actorType: "user", actorId: "u1", agentId: null });
    const off = await svc.tick(new Date("2026-09-10T13:50:00.000Z"));
    expect(off).toMatchObject({ active: false, stuck: false, alerted: 0 });
    expect((await instanceSettingsService(db).getGeneral()).quietMode.stuckNoticeAt).toBeNull();

    // The next deploy gets stuck too: that one must be reported again.
    await setQuietMode({ activatedAt: "2026-09-10T15:00:00.000Z" });
    expect((await svc.tick(new Date("2026-09-10T15:30:00.000Z"))).alerted).toBe(1);
    expect(await noticeRows()).toHaveLength(2);
  });

  it("defaults the window to 30 minutes", async () => {
    await seedCompany("Interiørdesign AS");
    const svc = quietModeAlertsService(db);
    await setQuietMode({ activatedAt: "2026-09-10T13:20:00.000Z" });

    const justUnder = new Date(new Date("2026-09-10T13:20:00.000Z").getTime() + THIRTY_MINUTES_MS - 60_000);
    expect((await svc.tick(justUnder)).stuck).toBe(false);
    const justOver = new Date(new Date("2026-09-10T13:20:00.000Z").getTime() + THIRTY_MINUTES_MS);
    expect((await svc.tick(justOver)).stuck).toBe(true);
  });

  it("activating quiet mode clears any previous notice bookkeeping", async () => {
    await seedCompany("Interiørdesign AS");
    const settings = instanceSettingsService(db);
    await settings.activateQuietMode({ actorType: "user", actorId: "u1", agentId: null });
    await settings.setQuietModeStuckNoticeAt(new Date("2026-09-10T13:47:00.000Z"));
    await settings.deactivateQuietMode({ actorType: "user", actorId: "u1", agentId: null });
    expect((await settings.getGeneral()).quietMode.stuckNoticeAt).toBeNull();

    await settings.activateQuietMode({ actorType: "user", actorId: "u1", agentId: null });
    expect((await settings.getGeneral()).quietMode.stuckNoticeAt).toBeNull();
  });
});
