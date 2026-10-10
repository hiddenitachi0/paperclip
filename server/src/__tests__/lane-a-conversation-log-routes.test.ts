import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  laneAConversations,
  laneAMessages,
  telegramMessageReactions,
  type LaneAStoredToolCall,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.setConfig({ testTimeout: 20_000 });

/**
 * Conversations review on a quick agent's page: owners and admins see every
 * conversation of the company's quick agent, other members only their own,
 * agents never, and nothing crosses companies. An Employee (light) member's
 * chat stays private (DUR-4094): a row without content, never matched by a
 * search, and refused when opened. Shown text is masked.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres conversation-log tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type Role = "owner" | "admin" | "operator" | "viewer" | "employee";

describeEmbeddedPostgres("quick agent conversations review", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyId!: string;
  let otherCompanyId!: string;
  let agentId!: string;
  let otherAgentId!: string;
  let foreignAgentId!: string;
  let colleagueAgentId!: string;
  const users = {
    owner: "",
    admin: "",
    operator: "",
    viewer: "",
    employee: "",
  } as Record<Role, string>;
  const conv = {} as Record<"ownerChat" | "operatorChat" | "employeeChat" | "agentChat" | "otherAgentChat" | "foreignChat", string>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-conversation-log-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(telegramMessageReactions);
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  async function company(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `${name} ${id}`,
      issuePrefix: `C${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return id;
  }

  async function agent(company: string, name: string, laneAEnabled = true) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId: company, name, role: "general", status: "idle", laneAEnabled });
    return id;
  }

  async function conversation(params: {
    company: string;
    agent: string;
    userId?: string | null;
    byAgentId?: string | null;
    createdAt: Date;
    lastMessageAt?: Date;
    messages: Array<{ role: "user" | "assistant" | "recap"; content: string; toolCalls?: LaneAStoredToolCall[] }>;
  }) {
    const id = randomUUID();
    await db.insert(laneAConversations).values({
      id,
      companyId: params.company,
      agentId: params.agent,
      requestedByUserId: params.userId ?? null,
      requestedByAgentId: params.byAgentId ?? null,
      turnCount: params.messages.filter((m) => m.role === "user").length,
      createdAt: params.createdAt,
      lastMessageAt: params.lastMessageAt ?? params.createdAt,
    });
    let at = params.createdAt.getTime();
    for (const message of params.messages) {
      at += 1000;
      await db.insert(laneAMessages).values({
        companyId: params.company,
        conversationId: id,
        agentId: params.agent,
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls ?? null,
        createdAt: new Date(at),
      });
    }
    return id;
  }

  async function seed() {
    companyId = await company("Acme");
    otherCompanyId = await company("Other");
    agentId = await agent(companyId, "Secretary");
    otherAgentId = await agent(companyId, "Maja");
    colleagueAgentId = await agent(companyId, "Fork Lead", false);
    foreignAgentId = await agent(otherCompanyId, "Foreign secretary");

    const now = new Date();
    for (const role of ["owner", "admin", "operator", "viewer", "employee"] as Role[]) {
      const id = `user-${role}-${randomUUID()}`;
      users[role] = id;
      await db.insert(authUsers).values({
        id,
        name: role === "owner" ? "Filip" : role === "operator" ? "Olga" : role === "employee" ? "Emma" : `${role} person`,
        email: `${id}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: id,
        status: "active",
        membershipRole: role,
      });
    }

    const day = (n: number) => new Date(Date.UTC(2026, 9, n, 10, 0, 0));
    conv.ownerChat = await conversation({
      company: companyId,
      agent: agentId,
      userId: users.owner,
      createdAt: day(1),
      lastMessageAt: day(1),
      messages: [
        { role: "user", content: "Please make a picture of a red sofa. My key is sk-ant-abcdef1234567890" },
        {
          role: "assistant",
          content: "Here is your red sofa.",
          toolCalls: [
            {
              tool: "paperclip.media-studio:generate-image",
              summary: "Made a picture of a red sofa.",
              ok: true,
              image: { fileId: randomUUID(), contentPath: "/api/attachments/abc/content", contentType: "image/png", seed: 7, issueId: null },
            },
            { tool: "action_claim_check", summary: "internal", ok: true },
          ],
        },
      ],
    });
    conv.operatorChat = await conversation({
      company: companyId,
      agent: agentId,
      userId: users.operator,
      createdAt: day(3),
      lastMessageAt: day(4),
      messages: [
        { role: "user", content: "How were sales last week? 100% honest please" },
        {
          role: "assistant",
          content: "Sales were fine. I asked Fork Lead to look closer.",
          toolCalls: [
            { tool: "read_business_data", summary: "Read sales for last week.", ok: true },
            {
              tool: "route_to_agent",
              summary: "Handed to Fork Lead as task DUR-12.",
              ok: true,
              task: { issueId: randomUUID(), identifier: "DUR-12", title: "Look at sales" },
            },
          ],
        },
      ],
    });
    conv.employeeChat = await conversation({
      company: companyId,
      agent: agentId,
      userId: users.employee,
      createdAt: day(5),
      messages: [
        { role: "user", content: "Private sofa question about my salary" },
        {
          role: "assistant",
          content: "Answered.",
          toolCalls: [{ tool: "route_to_agent", summary: "Handed to Fork Lead as task DUR-13.", ok: true }],
        },
      ],
    });
    conv.agentChat = await conversation({
      company: companyId,
      agent: agentId,
      byAgentId: colleagueAgentId,
      createdAt: day(6),
      messages: [
        { role: "user", content: "Summarise the inbox" },
        { role: "assistant", content: "Done." },
      ],
    });
    conv.otherAgentChat = await conversation({
      company: companyId,
      agent: otherAgentId,
      userId: users.owner,
      createdAt: day(7),
      messages: [{ role: "user", content: "Another agent's sofa chat" }],
    });
    conv.foreignChat = await conversation({
      company: otherCompanyId,
      agent: foreignAgentId,
      userId: users.owner,
      createdAt: day(8),
      messages: [{ role: "user", content: "Foreign sofa" }],
    });
    await db.insert(telegramMessageReactions).values({
      companyId,
      agentId,
      telegramUserId: "42",
      telegramChatId: "42",
      telegramMessageId: 1,
      conversationId: conv.operatorChat,
      emoji: "👍",
    });
  }

  async function createApp(actor: { kind: "board"; role: Role } | { kind: "agent" } | { kind: "local" }) {
    const { laneARoutes } = await import("../routes/lane-a.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (actor.kind === "agent") {
        req.actor = { type: "agent", agentId, companyId, source: "agent_key" } as typeof req.actor;
      } else if (actor.kind === "local") {
        req.actor = { type: "board", source: "local_implicit", userId: "local-board" } as typeof req.actor;
      } else {
        req.actor = {
          type: "board",
          source: "session",
          userId: users[actor.role],
          companyIds: [companyId],
          memberships: [{ companyId, membershipRole: actor.role, status: "active" }],
        } as typeof req.actor;
      }
      next();
    });
    app.use("/api", laneARoutes(db));
    app.use(errorHandler);
    return app;
  }

  const listUrl = (agent = agentId, company = companyId) => `/api/companies/${company}/lane-a/agents/${agent}/conversations`;

  it("an owner sees every conversation of the agent, newest activity first, with who/when/how many/what it did", async () => {
    await seed();
    const app = await createApp({ kind: "board", role: "owner" });
    const res = await request(app).get(listUrl());
    expect(res.status).toBe(200);
    expect(res.body.canSeeAll).toBe(true);
    const ids = res.body.conversations.map((row: { id: string }) => row.id);
    expect(ids).toEqual([conv.agentChat, conv.employeeChat, conv.operatorChat, conv.ownerChat]);

    const byId = Object.fromEntries(res.body.conversations.map((row: { id: string }) => [row.id, row]));
    const operator = byId[conv.operatorChat];
    expect(operator.person).toEqual({ kind: "user", id: users.operator, name: "Olga" });
    expect(operator.channel).toBe("telegram");
    expect(operator.messageCount).toBe(2);
    expect(operator.firstQuestion).toBe("How were sales last week? 100% honest please");
    expect(operator.handoffCount).toBe(1);
    expect(operator.toolUse.map((tool: { label: string }) => tool.label).sort()).toEqual(["Handed to Fork Lead", "Read business data"]);
    expect(operator.startedAt).toBe(new Date(Date.UTC(2026, 9, 3, 10)).toISOString());
    expect(operator.lastMessageAt).toBe(new Date(Date.UTC(2026, 9, 4, 10)).toISOString());

    const own = byId[conv.ownerChat];
    expect(own.mine).toBe(true);
    expect(own.channel).toBeNull();
    expect(own.firstQuestion).not.toContain("sk-ant");
    expect(own.firstQuestion).toContain("[hidden]");
    expect(own.toolUse).toEqual([{ label: "Made a picture", count: 1 }]);

    expect(byId[conv.agentChat].person).toEqual({ kind: "agent", id: colleagueAgentId, name: "Fork Lead" });

    // The Employee (light) chat is listed, but nothing from inside it.
    const employee = byId[conv.employeeChat];
    expect(employee.private).toBe(true);
    expect(employee.person.name).toBe("Emma");
    expect(employee.messageCount).toBe(2);
    expect(employee.firstQuestion).toBeNull();
    expect(employee.toolUse).toEqual([]);
    expect(employee.handoffCount).toBe(0);

    expect(res.body.people.map((person: { name: string }) => person.name)).toEqual(["Emma", "Filip", "Olga"]);
  });

  it("an admin and the local board also see all conversations", async () => {
    await seed();
    for (const actor of [{ kind: "board", role: "admin" } as const, { kind: "local" } as const]) {
      const res = await request(await createApp(actor)).get(listUrl());
      expect(res.status).toBe(200);
      expect(res.body.conversations).toHaveLength(4);
    }
  });

  it("other members see only their own conversations and cannot open anyone else's", async () => {
    await seed();
    const app = await createApp({ kind: "board", role: "operator" });
    const res = await request(app).get(listUrl());
    expect(res.status).toBe(200);
    expect(res.body.canSeeAll).toBe(false);
    expect(res.body.people).toEqual([]);
    expect(res.body.conversations.map((row: { id: string }) => row.id)).toEqual([conv.operatorChat]);

    // Filtering by someone else does not widen the view.
    const filtered = await request(app).get(listUrl()).query({ userId: users.owner });
    expect(filtered.body.conversations).toEqual([]);

    const mine = await request(app).get(`${listUrl()}/${conv.operatorChat}`);
    expect(mine.status).toBe(200);
    const theirs = await request(app).get(`${listUrl()}/${conv.ownerChat}`);
    expect(theirs.status).toBe(404);

    const viewer = await request(await createApp({ kind: "board", role: "viewer" })).get(listUrl());
    expect(viewer.body.conversations).toEqual([]);
  });

  it("agents cannot use these routes", async () => {
    await seed();
    const app = await createApp({ kind: "agent" });
    expect((await request(app).get(listUrl())).status).toBe(403);
    expect((await request(app).get(`${listUrl()}/${conv.ownerChat}`)).status).toBe(403);
  });

  it("an Employee (light) member is refused, like on the other quick-agent routes", async () => {
    await seed();
    const res = await request(await createApp({ kind: "board", role: "employee" })).get(listUrl());
    expect(res.status).toBe(403);
  });

  it("nothing crosses companies or agents", async () => {
    await seed();
    const app = await createApp({ kind: "board", role: "owner" });
    // Another company's agent under this company's path: not found.
    expect((await request(app).get(listUrl(foreignAgentId))).status).toBe(404);
    // Another company's path: no access at all.
    expect((await request(app).get(listUrl(foreignAgentId, otherCompanyId))).status).toBe(403);
    // Another company's conversation, or another agent's, under this agent: not found.
    expect((await request(app).get(`${listUrl()}/${conv.foreignChat}`)).status).toBe(404);
    expect((await request(app).get(`${listUrl()}/${conv.otherAgentChat}`)).status).toBe(404);
    // A malformed id is a 404, not a database error.
    expect((await request(app).get(`${listUrl()}/not-a-uuid`)).status).toBe(404);
    expect((await request(app).get(listUrl("not-a-uuid"))).status).toBe(404);

    const other = await request(app).get(listUrl(otherAgentId));
    expect(other.body.conversations.map((row: { id: string }) => row.id)).toEqual([conv.otherAgentChat]);
  });

  it("pages through conversations with a cursor, without gaps or repeats", async () => {
    await seed();
    const app = await createApp({ kind: "board", role: "owner" });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await request(app)
        .get(listUrl())
        .query({ limit: "3", ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      expect(res.body.conversations.length).toBeLessThanOrEqual(3);
      seen.push(...res.body.conversations.map((row: { id: string }) => row.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(2);
    expect(seen).toEqual([conv.agentChat, conv.employeeChat, conv.operatorChat, conv.ownerChat]);

    expect((await request(app).get(listUrl()).query({ cursor: "garbage" })).status).toBe(400);
    expect((await request(app).get(listUrl()).query({ limit: "1000" })).status).toBe(400);
  });

  it("searches message text, never inside a private chat, and validates the search", async () => {
    await seed();
    const app = await createApp({ kind: "board", role: "owner" });
    const sofa = await request(app).get(listUrl()).query({ q: "SOFA" });
    expect(sofa.status).toBe(200);
    // The employee's chat says "sofa" too, but its content never answers a search.
    expect(sofa.body.conversations.map((row: { id: string }) => row.id)).toEqual([conv.ownerChat]);

    const answer = await request(app).get(listUrl()).query({ q: "look closer" });
    expect(answer.body.conversations.map((row: { id: string }) => row.id)).toEqual([conv.operatorChat]);

    // LIKE wildcards are literal.
    const percent = await request(app).get(listUrl()).query({ q: "100%" });
    expect(percent.body.conversations.map((row: { id: string }) => row.id)).toEqual([conv.operatorChat]);
    const underscore = await request(app).get(listUrl()).query({ q: "s_fa" });
    expect(underscore.body.conversations).toEqual([]);

    expect((await request(app).get(listUrl()).query({ q: "a" })).status).toBe(400);
    expect((await request(app).get(listUrl()).query({ q: "x".repeat(201) })).status).toBe(400);

    // A member's search only ever looks at their own chats.
    const operatorApp = await createApp({ kind: "board", role: "operator" });
    const operatorSofa = await request(operatorApp).get(listUrl()).query({ q: "sofa" });
    expect(operatorSofa.body.conversations).toEqual([]);
  });

  it("filters by person, date range and hand-offs", async () => {
    await seed();
    const app = await createApp({ kind: "board", role: "owner" });
    const ids = (res: request.Response) => res.body.conversations.map((row: { id: string }) => row.id);

    expect(ids(await request(app).get(listUrl()).query({ userId: users.operator }))).toEqual([conv.operatorChat]);
    // Hand-offs: the employee's private chat has one, but its content does not answer filters.
    expect(ids(await request(app).get(listUrl()).query({ hasHandoffs: "true" }))).toEqual([conv.operatorChat]);
    // Active on/after 4 Oct and started on/before 5 Oct.
    expect(ids(await request(app).get(listUrl()).query({ from: "2026-10-04", to: "2026-10-05" }))).toEqual([
      conv.employeeChat,
      conv.operatorChat,
    ]);
    expect((await request(app).get(listUrl()).query({ from: "4 Oct" })).status).toBe(400);
  });

  it("opens a transcript with masked text, plain-word actions and picture thumbnails", async () => {
    await seed();
    const app = await createApp({ kind: "board", role: "owner" });
    const res = await request(app).get(`${listUrl()}/${conv.ownerChat}`);
    expect(res.status).toBe(200);
    expect(res.body.conversation.id).toBe(conv.ownerChat);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].role).toBe("user");
    expect(res.body.messages[0].content).not.toContain("sk-ant-abcdef");
    const actions = res.body.messages[1].actions;
    expect(actions[0]).toMatchObject({
      label: "Made a picture",
      ok: true,
      image: { contentPath: "/api/attachments/abc/content", contentType: "image/png" },
    });
    expect(actions[1]).toMatchObject({ tool: "action_claim_check", label: "Checked its own claim" });

    // An owner may read a member's chat, with the hand-over shown plainly.
    const member = await request(app).get(`${listUrl()}/${conv.operatorChat}`);
    expect(member.status).toBe(200);
    expect(member.body.messages[1].actions[1]).toMatchObject({
      label: "Handed to Fork Lead",
      task: { identifier: "DUR-12", title: "Look at sales" },
    });

    // An Employee (light) chat stays behind emergency access.
    const privateChat = await request(app).get(`${listUrl()}/${conv.employeeChat}`);
    expect(privateChat.status).toBe(403);
    expect(privateChat.body.details?.code ?? privateChat.body.code).toBe("LANE_A_CONVERSATION_PRIVATE");
    expect(JSON.stringify(privateChat.body)).not.toContain("salary");
  });
});
