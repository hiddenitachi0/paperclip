import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  projects,
  secretAccessEvents,
  telegramBots,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { telegramBotRoutes } from "../routes/telegram-bots.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";

/**
 * DUR-3978 slice 2: connecting a Telegram bot from the app.
 *
 * The properties worth a test are the ones a careless change would take away
 * quietly: that the token never comes back out of an ordinary route, that
 * another company's bot is invisible, that an agent cannot reach any of this,
 * and that the one route which does hand out a token refuses everyone except
 * an instance admin.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping Telegram bot route tests: ${support.reason ?? "unsupported environment"}`);
}

const TOKEN = "8100000001:AAHtestingtestingtestingtesting01";
const NEW_TOKEN = "8100000002:AAHsecondtokensecondtokensecond2";

function getMeOk(username = "durkan_ceo_bot") {
  return vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, result: { username } }), { status: 200 }),
  ) as unknown as typeof fetch;
}

function getMeUnauthorized() {
  return vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 401 })) as unknown as typeof fetch;
}

d("telegram bot routes", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `paperclip-telegram-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("telegram-bots");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(telegramBots);
    await db.delete(secretAccessEvents);
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = `A-${randomUUID().slice(0, 6)}`) {
    return agentService(db).create(companyId, {
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
  }

  /** An instance admin (what the on-box bridge authenticates as). */
  const adminActor = () => ({
    type: "board",
    source: "local_implicit",
    userId: "operator",
    isInstanceAdmin: true,
  });

  /** An ordinary board member of one company. */
  const memberActor = (companyIds: string[]) => ({
    type: "board",
    source: "session",
    userId: "member",
    isInstanceAdmin: false,
    companyIds,
    memberships: companyIds.map((companyId) => ({
      companyId,
      status: "active",
      membershipRole: "admin",
    })),
  });

  const agentActor = (companyId: string, agentId: string) => ({
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
    runId: null,
  });

  function createApp(actor: Record<string, unknown>, fetchImpl: typeof fetch = getMeOk()) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", telegramBotRoutes(db, { fetchImpl }));
    app.use(errorHandler);
    return app;
  }

  async function connectBot(
    app: express.Express,
    companyId: string,
    agentId: string,
    token = TOKEN,
    name = "Daglig leder",
  ) {
    return request(app).post(`/api/companies/${companyId}/telegram-bots`).send({ agentId, name, botToken: token });
  }

  // ── The happy path, and the token never coming back ───────────────────────

  it("connects a bot, and the token is never in the answer", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId, "Daglig leder");
    const app = createApp(adminActor());

    const created = await connectBot(app, companyId, agent.id);

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.name).toBe("Daglig leder");
    expect(created.body.agentName).toBe("Daglig leder");
    expect(created.body.tokenHint).toBe("8100000001:••••ng01");
    expect(JSON.stringify(created.body)).not.toContain(TOKEN);
    expect(JSON.stringify(created.body)).not.toContain("AAHtesting");

    const listed = await request(app).get(`/api/companies/${companyId}/telegram-bots`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(TOKEN);
    expect(JSON.stringify(listed.body)).not.toContain("AAHtesting");
  });

  it("stores the token as an ordinary saved password, bound to the bot", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const app = createApp(adminActor());

    const created = await connectBot(app, companyId, agent.id);

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, created.body.id));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ targetType: "telegram_bot", configPath: "bot_token" });

    const stored = await secretService(db).resolveSecretValue(companyId, bindings[0].secretId, "latest", {
      consumerType: "telegram_bot",
      consumerId: created.body.id,
      configPath: "bot_token",
      actorType: "system",
      actorId: "test",
    });
    expect(stored).toBe(TOKEN);
  });

  it("refuses a second bot for the same agent", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const app = createApp(adminActor());
    await connectBot(app, companyId, agent.id);

    const second = await connectBot(app, companyId, agent.id, NEW_TOKEN, "En til");

    expect(second.status).toBe(409);
  });

  it("refuses an agent from another company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const otherAgent = await seedAgent(otherCompanyId);
    const app = createApp(adminActor());

    const created = await connectBot(app, companyId, otherAgent.id);

    expect(created.status).toBe(404);
  });

  it("refuses something that is not a bot token, in plain language", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const app = createApp(adminActor());

    const created = await connectBot(app, companyId, agent.id, "@min_bot");

    expect(created.status).toBe(400);
    expect(JSON.stringify(created.body)).toContain("BotFather");
  });

  // ── Test, rotate, allowlist, remove ───────────────────────────────────────

  it("tests the bot against Telegram and reports the username", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const app = createApp(adminActor(), getMeOk("durkan_ceo_bot"));
    const created = await connectBot(app, companyId, agent.id);

    const tested = await request(app)
      .post(`/api/companies/${companyId}/telegram-bots/${created.body.id}/test`)
      .send({});

    expect(tested.status, JSON.stringify(tested.body)).toBe(200);
    expect(tested.body.ok).toBe(true);
    expect(tested.body.username).toBe("durkan_ceo_bot");
    const listed = await request(app).get(`/api/companies/${companyId}/telegram-bots`);
    expect(listed.body[0].lastCheckOk).toBe(true);
    expect(listed.body[0].lastCheckUsername).toBe("durkan_ceo_bot");
  });

  it("says what is wrong in plain language when Telegram rejects the token", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const app = createApp(adminActor(), getMeUnauthorized());
    const created = await connectBot(app, companyId, agent.id);

    const tested = await request(app)
      .post(`/api/companies/${companyId}/telegram-bots/${created.body.id}/test`)
      .send({});

    expect(tested.body.ok).toBe(false);
    expect(tested.body.message).toContain("BotFather");
    expect(JSON.stringify(tested.body)).not.toContain(TOKEN);
  });

  it("rotates the token, changes the hint, and forgets the old check", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const app = createApp(adminActor());
    const created = await connectBot(app, companyId, agent.id);
    await request(app).post(`/api/companies/${companyId}/telegram-bots/${created.body.id}/test`).send({});

    const rotated = await request(app)
      .post(`/api/companies/${companyId}/telegram-bots/${created.body.id}/token`)
      .send({ botToken: NEW_TOKEN });

    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(rotated.body.tokenHint).toBe("8100000002:••••ond2");
    expect(rotated.body.lastCheckOk).toBeNull();
    expect(JSON.stringify(rotated.body)).not.toContain(NEW_TOKEN);

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, created.body.id));
    const stored = await secretService(db).resolveSecretValue(companyId, bindings[0].secretId, "latest", {
      consumerType: "telegram_bot",
      consumerId: created.body.id,
      configPath: "bot_token",
      actorType: "system",
      actorId: "test",
    });
    expect(stored).toBe(NEW_TOKEN);
  });

  it("adds and removes the people allowed to use a bot", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const app = createApp(adminActor());
    const created = await connectBot(app, companyId, agent.id);

    const added = await request(app)
      .put(`/api/companies/${companyId}/telegram-bots/${created.body.id}/allowed-users`)
      .send({ telegramUserIds: ["111111", "222222", "111111"] });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.allowedTelegramUserIds).toEqual(["111111", "222222"]);

    const removed = await request(app)
      .put(`/api/companies/${companyId}/telegram-bots/${created.body.id}/allowed-users`)
      .send({ telegramUserIds: ["222222"] });
    expect(removed.body.allowedTelegramUserIds).toEqual(["222222"]);

    const refused = await request(app)
      .put(`/api/companies/${companyId}/telegram-bots/${created.body.id}/allowed-users`)
      .send({ telegramUserIds: ["not-an-id"] });
    expect(refused.status).toBe(400);
  });

  it("removes the bot and deletes its saved token", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const app = createApp(adminActor());
    const created = await connectBot(app, companyId, agent.id);
    const before = await db.select().from(companySecrets);
    expect(before).toHaveLength(1);

    const removed = await request(app).delete(`/api/companies/${companyId}/telegram-bots/${created.body.id}`);

    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(await db.select().from(telegramBots)).toHaveLength(0);
    expect(await db.select().from(companySecrets)).toHaveLength(0);
  });

  // ── Who may reach any of this ─────────────────────────────────────────────

  it("refuses an agent actor on every company route", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const adminApp = createApp(adminActor());
    const created = await connectBot(adminApp, companyId, agent.id);
    const app = createApp(agentActor(companyId, agent.id));

    const listed = await request(app).get(`/api/companies/${companyId}/telegram-bots`);
    const connected = await connectBot(app, companyId, agent.id, NEW_TOKEN, "Min egen bot");
    const tested = await request(app)
      .post(`/api/companies/${companyId}/telegram-bots/${created.body.id}/test`)
      .send({});
    const removedByAgent = await request(app).delete(
      `/api/companies/${companyId}/telegram-bots/${created.body.id}`,
    );

    for (const res of [listed, connected, tested, removedByAgent]) {
      expect(res.status).toBe(403);
    }
    expect(await db.select().from(telegramBots)).toHaveLength(1);
  });

  it("makes another company's bot invisible", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const agentB = await seedAgent(companyB);
    const adminApp = createApp(adminActor());
    const botB = await connectBot(adminApp, companyB, agentB.id);

    const app = createApp(memberActor([companyA]));

    const crossCompany = await request(app).get(`/api/companies/${companyB}/telegram-bots`);
    expect(crossCompany.status).toBe(403);

    // The same bot id, asked for under a company the member does belong to.
    const wrongCompany = await request(app).get(`/api/companies/${companyA}/telegram-bots`);
    expect(wrongCompany.status).toBe(200);
    expect(wrongCompany.body).toHaveLength(0);

    const stolen = await request(app)
      .post(`/api/companies/${companyA}/telegram-bots/${botB.body.id}/test`)
      .send({});
    expect(stolen.status).toBe(404);
  });

  // ── The gated token route ─────────────────────────────────────────────────

  it("gives the bridge its roster without any token", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const agentA = await seedAgent(companyA);
    const agentB = await seedAgent(companyB);
    const app = createApp(adminActor());
    await connectBot(app, companyA, agentA.id, TOKEN, "CEO");
    await connectBot(app, companyB, agentB.id, NEW_TOKEN, "Fork Lead");

    const roster = await request(app).get("/api/instance/telegram-bridge-config");

    expect(roster.status, JSON.stringify(roster.body)).toBe(200);
    expect(roster.body.bots).toHaveLength(2);
    expect(JSON.stringify(roster.body)).not.toContain(TOKEN);
    expect(JSON.stringify(roster.body)).not.toContain(NEW_TOKEN);
    expect(JSON.stringify(roster.body)).not.toContain("AAH");
  });

  it("hands one token to an instance admin, and to nobody else", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const adminApp = createApp(adminActor());
    const created = await connectBot(adminApp, companyId, agent.id);
    const tokenPath = `/api/companies/${companyId}/telegram-bots/${created.body.id}/bridge-token`;

    const asAdmin = await request(adminApp).get(tokenPath);
    expect(asAdmin.status, JSON.stringify(asAdmin.body)).toBe(200);
    expect(asAdmin.body.token).toBe(TOKEN);

    const asMember = await request(createApp(memberActor([companyId]))).get(tokenPath);
    expect(asMember.status).toBe(403);

    const asAgent = await request(createApp(agentActor(companyId, agent.id))).get(tokenPath);
    expect(asAgent.status).toBe(403);

    const asNobody = await request(createApp({ type: "none", source: "none" })).get(tokenPath);
    expect(asNobody.status).toBe(403);

    const rosterAsMember = await request(createApp(memberActor([companyId]))).get(
      "/api/instance/telegram-bridge-config",
    );
    expect(rosterAsMember.status).toBe(403);
  });

  it("records every token read in the credential audit", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const app = createApp(adminActor());
    const created = await connectBot(app, companyId, agent.id);

    await request(app).get(`/api/companies/${companyId}/telegram-bots/${created.body.id}/bridge-token`);

    const events = await db.select().from(secretAccessEvents);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]).toMatchObject({
      consumerType: "telegram_bot",
      consumerId: created.body.id,
      outcome: "success",
    });
  });

  // ── DUR-3980 still holds for this new secret ──────────────────────────────

  it("will not let an agent attach a bot token to itself (DUR-3980)", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const app = createApp(adminActor());
    const created = await connectBot(app, companyId, agent.id);
    const [binding] = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, created.body.id));

    await expect(
      agentService(db).update(
        agent.id,
        {
          adapterConfig: {
            command: "echo",
            env: { TELEGRAM_TOKEN: { type: "secret_ref", secretId: binding.secretId, version: "latest" } },
          },
        },
        { actor: { actorType: "agent", agentId: agent.id } },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // And the bot's own binding is untouched.
    const after = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, created.body.id));
    expect(after).toHaveLength(1);
  });
});
