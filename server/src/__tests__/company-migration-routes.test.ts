import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companySecrets,
  createDb,
  projects,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let companyMigrationRoutes: typeof import("../routes/company-migration.js").companyMigrationRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company-migration route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Actor = Record<string, unknown>;

function boardActor(companyId: string, role: "owner" | "admin" | "operator" | "viewer"): Actor {
  return {
    type: "board",
    source: "session",
    userId: `user-${role}`,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  };
}

describeEmbeddedPostgres("company migration cutover routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-migration-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/company-migration.js")>("../routes/company-migration.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    companyMigrationRoutes = routes.companyMigrationRoutes;
    errorHandler = middleware.errorHandler;
    // The Claude check must not pick up a token from the machine running the tests.
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL"]) {
      vi.stubEnv(key, "");
    }
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companySecrets);
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
    app.use("/api", companyMigrationRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(name = "Nordlys AS") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const secretId = randomUUID();
    await db.insert(companySecrets).values({ id: secretId, companyId, key: "shop-token", name: "Shop token" });
    const workerId = randomUUID();
    const ownTokenId = randomUUID();
    const pausedId = randomUUID();
    await db.insert(agents).values([
      {
        id: workerId,
        companyId,
        name: "Worker",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: { env: { SHOP_TOKEN: { type: "secret_ref", secretId } } },
      },
      {
        id: ownTokenId,
        companyId,
        name: "Own Token",
        status: "running",
        adapterType: "claude_local",
        // Points at a secret that did not travel with the import.
        adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: randomUUID() } } },
      },
      {
        id: pausedId,
        companyId,
        name: "Already Paused",
        status: "paused",
        pauseReason: "manual",
        adapterType: "process",
      },
    ]);
    await db.insert(projects).values({ companyId, name: "Webshop" });
    const activeRoutineId = randomUUID();
    const pausedRoutineId = randomUUID();
    await db.insert(routines).values([
      { id: activeRoutineId, companyId, title: "Daily sales report", status: "active", assigneeAgentId: workerId },
      { id: pausedRoutineId, companyId, title: "Old routine", status: "paused", assigneeAgentId: workerId },
    ]);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: workerId,
      source: "timer",
      status: "queued",
    });
    return { companyId, workerId, ownTokenId, pausedId, activeRoutineId, pausedRoutineId, secretId };
  }

  async function snapshot(companyId: string) {
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    const agentRows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const routineRows = await db.select().from(routines).where(eq(routines.companyId, companyId));
    const projectRows = await db.select().from(projects).where(eq(projects.companyId, companyId));
    const secretRows = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    return { company, agentRows, routineRows, projectRows, secretRows, activity };
  }

  describe("verify destination", () => {
    it("reports what arrived and what is missing, with plain fix hints, and changes nothing", async () => {
      const seeded = await seedCompany();
      const before = await snapshot(seeded.companyId);

      const res = await request(createApp(boardActor(seeded.companyId, "viewer")))
        .get(`/api/companies/${seeded.companyId}/migration/verify`);

      expect(res.status).toBe(200);
      expect(res.body.companyId).toBe(seeded.companyId);
      const byKey = Object.fromEntries(res.body.sections.map((s: any) => [s.key, s]));
      expect(Object.keys(byKey)).toEqual([
        "agents",
        "claude_login",
        "secrets",
        "projects",
        "routines",
        "data_connections",
      ]);
      expect(byKey.agents.summary).toContain("3 agents");
      // No shared sign-in and no server token: the inheriting agent cannot start.
      const worker = byKey.claude_login.items.find((i: any) => i.label === "Worker");
      expect(worker.status).toBe("problem");
      expect(worker.fixHint).toContain("Claude sign-in");
      // Own token that did not arrive.
      const own = byKey.claude_login.items.find((i: any) => i.label === "Own Token");
      expect(own.status).toBe("problem");
      expect(own.detail).toContain("did not arrive");
      // The secret check flags the missing token binding and accepts the present one.
      expect(byKey.secrets.status).toBe("problem");
      expect(byKey.secrets.items.map((i: any) => i.label)).toEqual(["Own Token: CLAUDE_CODE_OAUTH_TOKEN"]);
      expect(byKey.projects.status).toBe("ok");
      expect(byKey.routines.items.find((i: any) => i.label === "Old routine").status).toBe("warning");
      expect(byKey.data_connections.status).toBe("warning");
      expect(res.body.status).toBe("problem");

      const after = await snapshot(seeded.companyId);
      expect(after).toEqual(before);
    });

    it("is company-scoped: a member of another company is refused and sees nothing", async () => {
      const a = await seedCompany("Company A");
      const b = await seedCompany("Company B");
      const res = await request(createApp(boardActor(b.companyId, "owner")))
        .get(`/api/companies/${a.companyId}/migration/verify`);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain("Worker");

      const own = await request(createApp(boardActor(b.companyId, "owner")))
        .get(`/api/companies/${b.companyId}/migration/verify`);
      expect(own.status).toBe(200);
      expect(own.body.companyName).toBe("Company B");
    });

    it("refuses agents", async () => {
      const seeded = await seedCompany();
      const res = await request(createApp({ type: "agent", agentId: seeded.workerId, companyId: seeded.companyId }))
        .get(`/api/companies/${seeded.companyId}/migration/verify`);
      expect(res.status).toBe(403);
    });
  });

  describe("mark as migrated", () => {
    const destinationUrl = "https://paperclip.example.com/NOR";

    it("pauses agents and active routines, records who and when, deletes nothing, and undo resumes exactly those", async () => {
      const seeded = await seedCompany();
      const before = await snapshot(seeded.companyId);
      const app = createApp(boardActor(seeded.companyId, "admin"));

      const res = await request(app)
        .post(`/api/companies/${seeded.companyId}/migration/mark-migrated`)
        .send({ destinationUrl, confirmCompanyName: "  nordlys as " });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ migratedToUrl: destinationUrl, agentsPaused: 2, routinesPaused: 1 });

      const moved = await snapshot(seeded.companyId);
      expect(moved.company?.migratedToUrl).toBe(destinationUrl);
      expect(moved.company?.migratedByUserId).toBe("user-admin");
      expect(moved.company?.migratedAt).toBeInstanceOf(Date);
      const status = (rows: typeof moved.agentRows) =>
        Object.fromEntries(rows.map((row) => [row.name, `${row.status}/${row.pauseReason ?? ""}`]));
      expect(status(moved.agentRows)).toEqual({
        Worker: "paused/company_migrated",
        "Own Token": "paused/company_migrated",
        "Already Paused": "paused/manual",
      });
      expect(Object.fromEntries(moved.routineRows.map((r) => [r.title, r.status]))).toEqual({
        "Daily sales report": "paused",
        "Old routine": "paused",
      });
      // Nothing deleted.
      expect(moved.agentRows).toHaveLength(before.agentRows.length);
      expect(moved.routineRows).toHaveLength(before.routineRows.length);
      expect(moved.projectRows).toHaveLength(before.projectRows.length);
      expect(moved.secretRows).toHaveLength(before.secretRows.length);
      const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, seeded.companyId));
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]?.status).toBe("cancelled");
      expect(moved.activity.map((row) => row.action)).toEqual(["company.marked_migrated"]);
      expect(moved.activity[0]).toMatchObject({ actorType: "user", actorId: "user-admin" });
      expect(moved.activity[0]?.details).toMatchObject({ destinationUrl, agentsPaused: 2, routinesPaused: 1 });

      // A second mark is refused instead of overwriting the address.
      const again = await request(app)
        .post(`/api/companies/${seeded.companyId}/migration/mark-migrated`)
        .send({ destinationUrl, confirmCompanyName: "Nordlys AS" });
      expect(again.status).toBe(409);

      const undo = await request(app).post(`/api/companies/${seeded.companyId}/migration/undo`).send({});
      expect(undo.status).toBe(200);
      expect(undo.body).toMatchObject({ agentsResumed: 2, routinesResumed: 1, migratedToUrl: null });

      const back = await snapshot(seeded.companyId);
      expect(back.company?.migratedToUrl).toBeNull();
      expect(back.company?.migratedAt).toBeNull();
      expect(back.company?.migrationPausedRoutineIds).toBeNull();
      expect(status(back.agentRows)).toEqual({
        Worker: "idle/",
        "Own Token": "idle/",
        "Already Paused": "paused/manual",
      });
      expect(Object.fromEntries(back.routineRows.map((r) => [r.title, r.status]))).toEqual({
        "Daily sales report": "active",
        "Old routine": "paused",
      });
      expect(back.activity.map((row) => row.action).sort()).toEqual(["company.marked_migrated", "company.migration_undone"]);
    });

    it("requires the company's name as a second confirmation", async () => {
      const seeded = await seedCompany();
      const res = await request(createApp(boardActor(seeded.companyId, "owner")))
        .post(`/api/companies/${seeded.companyId}/migration/mark-migrated`)
        .send({ destinationUrl, confirmCompanyName: "Wrong name" });
      expect(res.status).toBe(422);
      const after = await snapshot(seeded.companyId);
      expect(after.company?.migratedToUrl).toBeNull();
      expect(after.agentRows.filter((row) => row.pauseReason === "company_migrated")).toHaveLength(0);
    });

    it("rejects a destination that is not a web address", async () => {
      const seeded = await seedCompany();
      const res = await request(createApp(boardActor(seeded.companyId, "owner")))
        .post(`/api/companies/${seeded.companyId}/migration/mark-migrated`)
        .send({ destinationUrl: "javascript:alert(1)", confirmCompanyName: "Nordlys AS" });
      expect(res.status).toBe(400);
    });

    it.each(["operator", "viewer"] as const)("refuses a %s", async (role) => {
      const seeded = await seedCompany();
      const app = createApp(boardActor(seeded.companyId, role));
      const res = await request(app)
        .post(`/api/companies/${seeded.companyId}/migration/mark-migrated`)
        .send({ destinationUrl, confirmCompanyName: "Nordlys AS" });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("owner or an admin");
      const undo = await request(app).post(`/api/companies/${seeded.companyId}/migration/undo`).send({});
      expect(undo.status).toBe(403);
      const after = await snapshot(seeded.companyId);
      expect(after.company?.migratedToUrl).toBeNull();
    });

    it("refuses agents, even the company's own CEO", async () => {
      const seeded = await seedCompany();
      const app = createApp({ type: "agent", agentId: seeded.workerId, companyId: seeded.companyId });
      const res = await request(app)
        .post(`/api/companies/${seeded.companyId}/migration/mark-migrated`)
        .send({ destinationUrl, confirmCompanyName: "Nordlys AS" });
      expect(res.status).toBe(403);
      const undo = await request(app).post(`/api/companies/${seeded.companyId}/migration/undo`).send({});
      expect(undo.status).toBe(403);
      const after = await snapshot(seeded.companyId);
      expect(after.company?.migratedToUrl).toBeNull();
    });

    it("refuses an owner of a different company", async () => {
      const a = await seedCompany("Company A");
      const b = await seedCompany("Company B");
      const res = await request(createApp(boardActor(b.companyId, "owner")))
        .post(`/api/companies/${a.companyId}/migration/mark-migrated`)
        .send({ destinationUrl, confirmCompanyName: "Company A" });
      expect(res.status).toBe(403);
    });

    it("undo on a company that was never marked is a plain conflict", async () => {
      const seeded = await seedCompany();
      const res = await request(createApp(boardActor(seeded.companyId, "owner")))
        .post(`/api/companies/${seeded.companyId}/migration/undo`)
        .send({});
      expect(res.status).toBe(409);
    });
  });
});
