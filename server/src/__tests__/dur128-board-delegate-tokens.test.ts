import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authUsers, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { boardAuthService } from "../services/board-auth.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createActorEchoApp(db: Db) {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

describeEmbeddedPostgres("DUR-128: board_delegate token lifecycle", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dur128-delegate-tokens-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedOperator() {
    const userId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: userId,
      name: "Operator",
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return userId;
  }

  it("authenticates a live token as board_delegate, never as board", async () => {
    const userId = await seedOperator();
    const boardAuth = boardAuthService(db);
    const created = await boardAuth.createNamedDelegateToken({
      userId,
      name: "Telegram recovery bot",
      scopes: ["agent.clear_error", "agent.resume"],
    });

    const app = await createActorEchoApp(db);
    const res = await request(app).get("/actor").set("authorization", `Bearer ${created.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board_delegate",
      userId,
      isInstanceAdmin: false,
      delegateTokenId: created.id,
      delegateName: "Telegram recovery bot",
      delegateScopes: ["agent.clear_error", "agent.resume"],
      source: "board_delegate_key",
    });
  });

  it("fails closed once the token is revoked", async () => {
    const userId = await seedOperator();
    const boardAuth = boardAuthService(db);
    const created = await boardAuth.createNamedDelegateToken({
      userId,
      name: "Telegram recovery bot",
      scopes: ["agent.resume"],
    });

    const app = await createActorEchoApp(db);

    const beforeRevoke = await request(app).get("/actor").set("authorization", `Bearer ${created.token}`);
    expect(beforeRevoke.body.type).toBe("board_delegate");

    const revoked = await boardAuth.revokeDelegateToken(created.id, userId);
    expect(revoked).not.toBeNull();

    const afterRevoke = await request(app).get("/actor").set("authorization", `Bearer ${created.token}`);
    expect(afterRevoke.body.type).not.toBe("board_delegate");
    expect(afterRevoke.body.type).not.toBe("board");
  });

  it("fails closed once the token has expired", async () => {
    const userId = await seedOperator();
    const boardAuth = boardAuthService(db);
    const created = await boardAuth.createNamedDelegateToken({
      userId,
      name: "Telegram recovery bot",
      scopes: ["agent.resume"],
      expiresAt: new Date(Date.now() - 60_000),
    });

    const app = await createActorEchoApp(db);
    const res = await request(app).get("/actor").set("authorization", `Bearer ${created.token}`);
    expect(res.body.type).not.toBe("board_delegate");
    expect(res.body.type).not.toBe("board");
  });

  it("drops unknown scopes at creation time instead of persisting them", async () => {
    const userId = await seedOperator();
    const boardAuth = boardAuthService(db);
    const created = await boardAuth.createNamedDelegateToken({
      userId,
      name: "Telegram recovery bot",
      scopes: ["agent.resume", "approvals:decide" as any, "not_a_real_scope" as any],
    });
    expect(created.scopes).toEqual(["agent.resume"]);
  });
});
