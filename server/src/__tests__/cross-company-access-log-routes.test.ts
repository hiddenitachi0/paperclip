import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, createDb, crossCompanyAccessLog } from "@paperclipai/db";
import type { CrossCompanyAccessLogPage } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { crossCompanyAccessLogRoutes } from "../routes/cross-company-access-log.js";
import { buildCrossCompanyAccessLogPageQuery } from "../services/cross-company-access-log-view.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cross-company access log route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Actor = Record<string, unknown> & { type: string };

const ADMIN: Actor = { type: "board", source: "session", userId: "admin-user", isInstanceAdmin: true };

describeEmbeddedPostgres("GET /api/instance/cross-company-access (DUR-3983)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-company-access-log-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(crossCompanyAccessLog);
    await db.delete(agents);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Actor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", crossCompanyAccessLogRoutes(db));
    app.use(errorHandler);
    return app;
  }

  /** Inserts a row with an exact, microsecond-precision timestamp (a JS Date cannot carry one). */
  async function seed(input: {
    at: string;
    reason?: string;
    actorType?: string | null;
    actorId?: string | null;
    route?: string | null;
    companyIds?: string[] | null;
    id?: string;
  }) {
    const id = input.id ?? randomUUID();
    await db.execute(sql`
      insert into cross_company_access_log (id, occurred_at, reason, actor_type, actor_id, route, company_ids_touched)
      values (
        ${id}::uuid,
        ${input.at}::timestamptz,
        ${input.reason ?? "test reason"},
        ${input.actorType === undefined ? "user" : input.actorType},
        ${input.actorId ?? null},
        ${input.route === undefined ? "/board-api-keys" : input.route},
        ${input.companyIds ? JSON.stringify(input.companyIds) : null}::jsonb
      )
    `);
    return id;
  }

  async function logRowCount() {
    const rows = await db.select({ id: crossCompanyAccessLog.id }).from(crossCompanyAccessLog);
    return rows.length;
  }

  describe("only the instance admin can read it", () => {
    it("refuses a signed-in person who is not an instance admin, an agent and an anonymous caller", async () => {
      await seed({ at: "2026-09-18T10:00:00.000000Z" });

      const nonAdmin = await request(
        createApp({ type: "board", source: "session", userId: "someone", isInstanceAdmin: false }),
      ).get("/api/instance/cross-company-access");
      expect(nonAdmin.status).toBe(403);
      expect(nonAdmin.body.entries).toBeUndefined();

      const agent = await request(
        createApp({ type: "agent", agentId: randomUUID(), companyId: randomUUID(), source: "agent_key" }),
      ).get("/api/instance/cross-company-access");
      expect(agent.status).toBe(403);
      expect(agent.body.entries).toBeUndefined();

      const anonymous = await request(createApp({ type: "none", source: "none" })).get(
        "/api/instance/cross-company-access",
      );
      expect(anonymous.status).toBe(403);
      expect(anonymous.body.entries).toBeUndefined();
    });

    it("lets the instance admin and the local single-user board read it", async () => {
      await seed({ at: "2026-09-18T10:00:00.000000Z", reason: "board identity/session summary" });

      const admin = await request(createApp(ADMIN)).get("/api/instance/cross-company-access");
      expect(admin.status).toBe(200);
      expect((admin.body as CrossCompanyAccessLogPage).entries.map((e) => e.reason)).toEqual([
        "board identity/session summary",
      ]);

      const local = await request(createApp({ type: "board", source: "local_implicit", userId: "local-board" })).get(
        "/api/instance/cross-company-access",
      );
      expect(local.status).toBe(200);
      expect((local.body as CrossCompanyAccessLogPage).entries).toHaveLength(1);
    });

    it("does not add a row to the log just by looking at it", async () => {
      await seed({ at: "2026-09-18T10:00:00.000000Z" });
      expect(await logRowCount()).toBe(1);
      const res = await request(createApp(ADMIN)).get("/api/instance/cross-company-access");
      expect(res.status).toBe(200);
      expect(await logRowCount()).toBe(1);
    });
  });

  describe("pagination", () => {
    it("walks every entry exactly once, newest first, including rows apart by less than a millisecond", async () => {
      // Three rows inside the same millisecond (a Date-based cursor would lose
      // the ones between pages) and two rows in the very same microsecond
      // (only the id tie-break can order those).
      const sameMicrosecondIds = [randomUUID(), randomUUID()].sort();
      const seeded = [
        await seed({ at: "2026-09-18T12:00:00.000000Z", reason: "r1" }),
        await seed({ at: "2026-09-18T11:00:00.123900Z", reason: "r2" }),
        await seed({ at: "2026-09-18T11:00:00.123500Z", reason: "r3" }),
        await seed({ at: "2026-09-18T11:00:00.123100Z", reason: "r4" }),
        await seed({ at: "2026-09-18T10:00:00.000001Z", reason: "r5", id: sameMicrosecondIds[1] }),
        await seed({ at: "2026-09-18T10:00:00.000001Z", reason: "r6", id: sameMicrosecondIds[0] }),
        await seed({ at: "2026-09-17T09:00:00.000000Z", reason: "r7" }),
      ];

      const app = createApp(ADMIN);
      async function walk(limit: number) {
        const seen: string[] = [];
        const pageSizes: number[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 20; guard += 1) {
          const query: Record<string, string> = { limit: String(limit) };
          if (cursor) query.cursor = cursor;
          const res = await request(app).get("/api/instance/cross-company-access").query(query);
          expect(res.status).toBe(200);
          const page = res.body as CrossCompanyAccessLogPage;
          pageSizes.push(page.entries.length);
          seen.push(...page.entries.map((e) => e.reason));
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        return { seen, pageSizes };
      }

      // Every page size puts a different pair of neighbours on either side of
      // a page boundary; limit 1 puts every pair there.
      for (const limit of [1, 2, 3, 5]) {
        const { seen } = await walk(limit);
        expect(seen, `limit=${limit}`).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
        expect(new Set(seen).size).toBe(seeded.length);
      }
      expect((await walk(2)).pageSizes).toEqual([2, 2, 2, 1]);
    });

    it("reports no next page when the last page is exactly full", async () => {
      await seed({ at: "2026-09-18T12:00:00.000000Z" });
      await seed({ at: "2026-09-18T11:00:00.000000Z" });
      const res = await request(createApp(ADMIN)).get("/api/instance/cross-company-access").query({ limit: "2" });
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(2);
      expect(res.body.nextCursor).toBeNull();
    });

    it("keeps the date range while paging: from is inclusive, to is exclusive", async () => {
      await seed({ at: "2026-09-19T00:00:00.000000Z", reason: "at-to-boundary" });
      await seed({ at: "2026-09-18T23:59:59.999999Z", reason: "last-inside" });
      await seed({ at: "2026-09-18T12:00:00.000000Z", reason: "middle" });
      await seed({ at: "2026-09-18T00:00:00.000000Z", reason: "at-from-boundary" });
      await seed({ at: "2026-09-17T23:59:59.999999Z", reason: "before" });

      const app = createApp(ADMIN);
      const range = { from: "2026-09-18T00:00:00.000Z", to: "2026-09-19T00:00:00.000Z" };
      const first = await request(app).get("/api/instance/cross-company-access").query({ ...range, limit: "2" });
      expect(first.status).toBe(200);
      expect(first.body.entries.map((e: { reason: string }) => e.reason)).toEqual(["last-inside", "middle"]);
      const second = await request(app)
        .get("/api/instance/cross-company-access")
        .query({ ...range, limit: "2", cursor: first.body.nextCursor });
      expect(second.status).toBe(200);
      expect(second.body.entries.map((e: { reason: string }) => e.reason)).toEqual(["at-from-boundary"]);
      expect(second.body.nextCursor).toBeNull();
    });

    it("rejects a bad cursor, an inverted range and an out-of-range page size with a 400, not a 500", async () => {
      const app = createApp(ADMIN);
      const badCursor = await request(app).get("/api/instance/cross-company-access").query({ cursor: "not-a-cursor" });
      expect(badCursor.status).toBe(400);
      const injected = Buffer.from("2026-09-18T12:00:00.000000Z|x' or 1=1 --", "utf8").toString("base64url");
      const injectedCursor = await request(app).get("/api/instance/cross-company-access").query({ cursor: injected });
      expect(injectedCursor.status).toBe(400);
      const inverted = await request(app)
        .get("/api/instance/cross-company-access")
        .query({ from: "2026-09-19T00:00:00Z", to: "2026-09-18T00:00:00Z" });
      expect(inverted.status).toBe(400);
      const notADate = await request(app).get("/api/instance/cross-company-access").query({ from: "yesterday-ish" });
      expect(notADate.status).toBe(400);
      for (const limit of ["0", "201", "2.5", "abc"]) {
        const res = await request(app).get("/api/instance/cross-company-access").query({ limit });
        expect(res.status, `limit=${limit}`).toBe(400);
      }
    });
  });

  describe("what each entry says", () => {
    it("names the person, the agent and the companies involved", async () => {
      const companyA = randomUUID();
      const companyB = randomUUID();
      await db.insert(companies).values([
        { id: companyA, name: "Nordstrand Gruppen", issuePrefix: `A${companyA.slice(0, 4).toUpperCase()}` },
        { id: companyB, name: "Durkan", issuePrefix: `B${companyB.slice(0, 4).toUpperCase()}` },
      ]);
      const now = new Date();
      await db.insert(authUsers).values({
        id: "user-filip",
        name: "Filip",
        email: "filip@example.com",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      const agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId: companyA, name: "Fork Lead" });
      const goneCompany = randomUUID();

      await seed({
        at: "2026-09-18T12:00:00.000000Z",
        actorType: "user",
        actorId: "user-filip",
        route: "/cli-auth/me",
        companyIds: [companyA, companyB],
      });
      await seed({
        at: "2026-09-18T11:00:00.000000Z",
        actorType: "agent",
        actorId: agentId,
        route: "cross-company-instructions:deliver",
        companyIds: [companyB, goneCompany, "not-a-uuid"],
      });
      await seed({ at: "2026-09-18T10:00:00.000000Z", actorType: "agent", actorId: "not-a-uuid", route: null });

      const res = await request(createApp(ADMIN)).get("/api/instance/cross-company-access");
      expect(res.status).toBe(200);
      const [person, agent, malformed] = (res.body as CrossCompanyAccessLogPage).entries;
      expect(person).toMatchObject({
        occurredAt: "2026-09-18T12:00:00.000000Z",
        actorType: "user",
        actorName: "Filip",
        route: "/cli-auth/me",
        companies: [
          { id: companyA, name: "Nordstrand Gruppen" },
          { id: companyB, name: "Durkan" },
        ],
      });
      expect(agent).toMatchObject({
        actorType: "agent",
        actorName: "Fork Lead",
        companies: [
          { id: companyB, name: "Durkan" },
          { id: goneCompany, name: null },
          { id: "not-a-uuid", name: null },
        ],
      });
      expect(malformed).toMatchObject({ actorType: "agent", actorId: "not-a-uuid", actorName: null, route: null });
    });

    it("hides the routine scheduler ticks by default and shows them on request, but never hides anything unusual", async () => {
      await seed({
        at: "2026-09-16T12:00:00.000000Z",
        actorType: "scheduler",
        route: "heartbeat-scheduler:tickTimers",
        reason: "routine tick",
      });
      await seed({
        at: "2026-09-16T11:00:00.000000Z",
        actorType: "scheduler",
        route: "heartbeat-scheduler:startup-recovery",
        reason: "restart",
      });
      // Same route but no actor type: not provably routine, so it must stay visible.
      await seed({
        at: "2026-09-16T10:00:00.000000Z",
        actorType: null,
        route: "heartbeat-scheduler:tickTimers",
        reason: "no actor type",
      });
      await seed({ at: "2026-09-16T09:00:00.000000Z", actorType: "scheduler", route: null, reason: "no route" });

      const app = createApp(ADMIN);
      const hidden = await request(app).get("/api/instance/cross-company-access");
      expect(hidden.status).toBe(200);
      expect(hidden.body.entries.map((e: { reason: string }) => e.reason)).toEqual([
        "restart",
        "no actor type",
        "no route",
      ]);

      const shown = await request(app).get("/api/instance/cross-company-access").query({ routine: "show" });
      expect(shown.status).toBe(200);
      expect(shown.body.entries.map((e: { reason: string }) => e.reason)).toEqual([
        "routine tick",
        "restart",
        "no actor type",
        "no route",
      ]);
    });
  });

  it("the page query can be answered from the occurred_at index", async () => {
    await seed({ at: "2026-09-18T12:00:00.000000Z" });
    const query = buildCrossCompanyAccessLogPageQuery(db, {
      from: new Date("2026-09-01T00:00:00Z"),
      to: new Date("2026-09-19T00:00:00Z"),
      cursor: { occurredAt: "2026-09-18T12:00:00.000000Z", id: randomUUID() },
      limit: 50,
      hideRoutineScheduler: true,
    });
    const plan = await db.transaction(async (tx) => {
      // On a near-empty table the planner would rightly pick a sequential
      // scan; switching that off asks whether the index CAN serve the query.
      await tx.execute(sql`set local enable_seqscan = off`);
      return (await tx.execute(sql`explain ${query}`)) as unknown as Array<Record<string, string>>;
    });
    const text = plan.map((row) => Object.values(row).join(" ")).join("\n");
    expect(text).toContain("cross_company_access_log_occurred_at_idx");
  });
});
