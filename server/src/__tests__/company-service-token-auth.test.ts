import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyServiceTokens, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { companyServiceTokenService } from "../services/company-service-tokens.js";
import { assertBoard, assertBoardOrAgent, assertServiceOrBoard, getActorInfo } from "../routes/authz.js";
import { errorHandler } from "../middleware/index.js";

/**
 * DUR-3977: what a company service token actually is once it is presented on
 * a request. It must authenticate as the company it was issued to — and as
 * nothing else. Everything that grants board powers, agent identity or a user
 * identity has to keep refusing it.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function createProbeApp(db: Db) {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.get("/actor", (req, res) => res.json(req.actor));
  app.get("/needs-service-or-board", (req, res) => {
    assertServiceOrBoard(req);
    res.json({ ok: true });
  });
  app.get("/needs-board", (req, res) => {
    assertBoard(req);
    res.json({ ok: true });
  });
  app.get("/needs-board-or-agent", (req, res) => {
    assertBoardOrAgent(req);
    res.json({ ok: true });
  });
  app.get("/actor-identity", (req, res) => {
    res.json(getActorInfo(req));
  });
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("DUR-3977: company service token authentication", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dur3977-service-tokens-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(companyServiceTokens);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Nordstrand") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("authenticates a live token as its company, with no board or agent identity", async () => {
    const companyId = await seedCompany();
    const created = await companyServiceTokenService(db).createToken({
      companyId,
      name: "Nordstrand dashboard",
      createdByUserId: "user-1",
    });

    const res = await request(createProbeApp(db))
      .get("/actor")
      .set("authorization", `Bearer ${created.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "service",
      companyId,
      serviceTokenId: created.id,
      serviceTokenName: "Nordstrand dashboard",
      source: "company_service_token",
    });
    expect(res.body.userId).toBeUndefined();
    expect(res.body.agentId).toBeUndefined();
    expect(res.body.isInstanceAdmin).toBeUndefined();
    // The token value must not come back on the actor either.
    expect(JSON.stringify(res.body)).not.toContain(created.token);
  });

  it("reaches a route that opts in", async () => {
    const companyId = await seedCompany();
    const created = await companyServiceTokenService(db).createToken({
      companyId,
      name: "dash",
      createdByUserId: null,
    });

    const res = await request(createProbeApp(db))
      .get("/needs-service-or-board")
      .set("authorization", `Bearer ${created.token}`);

    expect(res.status).toBe(200);
  });

  it("is refused by every board-only route", async () => {
    const companyId = await seedCompany();
    const created = await companyServiceTokenService(db).createToken({
      companyId,
      name: "dash",
      createdByUserId: null,
    });

    const res = await request(createProbeApp(db))
      .get("/needs-board")
      .set("authorization", `Bearer ${created.token}`);

    expect(res.status).toBe(403);
  });

  // An agent must not be able to borrow this lane, and the service token must
  // not be able to borrow the agent lane either.
  it("is refused by routes that accept board or agent", async () => {
    const companyId = await seedCompany();
    const created = await companyServiceTokenService(db).createToken({
      companyId,
      name: "dash",
      createdByUserId: null,
    });

    const res = await request(createProbeApp(db))
      .get("/needs-board-or-agent")
      .set("authorization", `Bearer ${created.token}`);

    expect(res.status).toBe(403);
  });

  it("refuses to be attributed to a user or an agent", async () => {
    const companyId = await seedCompany();
    const created = await companyServiceTokenService(db).createToken({
      companyId,
      name: "dash",
      createdByUserId: null,
    });

    const res = await request(createProbeApp(db))
      .get("/actor-identity")
      .set("authorization", `Bearer ${created.token}`);

    expect(res.status).toBe(403);
  });

  it("fails closed once revoked", async () => {
    const companyId = await seedCompany();
    const service = companyServiceTokenService(db);
    const created = await service.createToken({ companyId, name: "dash", createdByUserId: null });
    await service.revokeToken({ tokenId: created.id, companyId, revokedByUserId: "user-1" });

    const res = await request(createProbeApp(db))
      .get("/actor")
      .set("authorization", `Bearer ${created.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "none" });
  });

  it("records that the token was used, without recording the token", async () => {
    const companyId = await seedCompany();
    const created = await companyServiceTokenService(db).createToken({
      companyId,
      name: "dash",
      createdByUserId: null,
    });

    await request(createProbeApp(db)).get("/actor").set("authorization", `Bearer ${created.token}`);

    const [row] = await db.select().from(companyServiceTokens);
    expect(row?.lastUsedAt).not.toBeNull();
  });
});
