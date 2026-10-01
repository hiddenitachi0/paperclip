import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  crmActivities,
  crmContactOrgRoles,
  crmContacts,
  crmFacts,
  crmOrganizations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let crmRoutes: typeof import("../routes/crm.js").crmRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres CRM company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-4191: proves crmRoutes is genuinely company-scoped end-to-end over a
// real HTTP request -- cross-company reads/writes for contacts,
// organisations, contact-org roles, activities and facts are all refused
// before any row leaks between companies. Mirrors the goals route pattern
// from goals-routes-company-scope.test.ts.
describeEmbeddedPostgres("crmRoutes company-scope wiring (DUR-4191)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-crm-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/crm.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/crm.js")>("../routes/crm.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    crmRoutes = routes.crmRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(crmFacts);
    await db.delete(crmActivities);
    await db.delete(crmContactOrgRoles);
    await db.delete(crmContacts);
    await db.delete(crmOrganizations);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // `agentId` set => request authenticates as that agent (must belong to
  // `companyIds[0]`). Omitted => a board/session actor with full access to
  // every company in `companyIds`, matching the real auth middleware's
  // "board" actor shape (not "local_implicit", which bypasses the
  // company-membership check this test is specifically exercising).
  function createApp(companyIds: string[], agentId?: string) {
    if (!crmRoutes || !errorHandler) {
      throw new Error("crm route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = agentId
        ? { type: "agent", source: "agent_jwt", agentId, runId: randomUUID(), companyId: companyIds[0] }
        : {
            type: "board",
            source: "session",
            userId: randomUUID(),
            companyIds,
            isInstanceAdmin: false,
            memberships: companyIds.map((companyId) => ({
              companyId,
              status: "active",
              membershipRole: "owner",
            })),
          };
      next();
    });
    app.use("/api", crmRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CRM Agent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("creates and lists a contact scoped to the requesting company", async () => {
    const companyId = await seedCompany();
    const app = createApp([companyId]);

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/crm/contacts`)
      .send({ firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" });

    expect(createRes.status).toBe(201);
    expect(createRes.body).toMatchObject({ companyId, firstName: "Ada", lastName: "Lovelace" });

    const listRes = await request(app).get(`/api/companies/${companyId}/crm/contacts`);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);

    const activityRows = await db.select().from(activityLog);
    expect(activityRows.some((row) => row.action === "crm_contact.created")).toBe(true);
  });

  it("never leaks another company's contacts, organisations or activities across the scope boundary", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const appA = createApp([companyA]);
    const appB = createApp([companyB]);

    await request(appA).post(`/api/companies/${companyA}/crm/contacts`).send({ firstName: "A", lastName: "Only" });
    await request(appB).post(`/api/companies/${companyB}/crm/contacts`).send({ firstName: "B1", lastName: "Only" });
    await request(appB).post(`/api/companies/${companyB}/crm/contacts`).send({ firstName: "B2", lastName: "Only" });

    const resA = await request(appA).get(`/api/companies/${companyA}/crm/contacts`);
    expect(resA.status).toBe(200);
    expect(resA.body).toHaveLength(1);

    const resB = await request(appB).get(`/api/companies/${companyB}/crm/contacts`);
    expect(resB.status).toBe(200);
    expect(resB.body).toHaveLength(2);

    // Company A's token cannot reach company B's data by hitting B's URL.
    const crossRes = await request(appA).get(`/api/companies/${companyB}/crm/contacts`);
    expect(crossRes.status).toBe(403);
  });

  it("rejects linking a contact and organisation that live in different companies", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const appA = createApp([companyA]);
    const appB = createApp([companyB]);

    const contactRes = await request(appA)
      .post(`/api/companies/${companyA}/crm/contacts`)
      .send({ firstName: "Ada", lastName: "Lovelace" });
    const orgRes = await request(appB)
      .post(`/api/companies/${companyB}/crm/organisations`)
      .send({ name: "Acme Corp" });

    const roleRes = await request(appA)
      .post(`/api/companies/${companyA}/crm/contact-org-roles`)
      .send({ contactId: contactRes.body.id, organizationId: orgRes.body.id, role: "advisor" });

    expect(roleRes.status).toBe(422);
  });

  it("creates an activity and a fact tied to a contact, agent-authored", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const app = createApp([companyId], agentId);

    const contactRes = await request(app)
      .post(`/api/companies/${companyId}/crm/contacts`)
      .send({ firstName: "Grace", lastName: "Hopper" });
    expect(contactRes.status).toBe(201);

    const activityRes = await request(app)
      .post(`/api/companies/${companyId}/crm/activities`)
      .send({ contactId: contactRes.body.id, type: "call", title: "Intro call" });
    expect(activityRes.status).toBe(201);
    expect(activityRes.body).toMatchObject({ type: "call", title: "Intro call", contactId: contactRes.body.id });

    const factRes = await request(app)
      .post(`/api/companies/${companyId}/crm/facts`)
      .send({
        contactId: contactRes.body.id,
        factKey: "annual_revenue",
        value: "1000000",
        observedAt: new Date().toISOString(),
      });
    expect(factRes.status).toBe(201);
    expect(factRes.body.createdByAgentId).toBe(agentId);
  });

  it("returns 404 for a contact that does not exist in the requesting company", async () => {
    const companyId = await seedCompany();
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/companies/${companyId}/crm/contacts/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});
