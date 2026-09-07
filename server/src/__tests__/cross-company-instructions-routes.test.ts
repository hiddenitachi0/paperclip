import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  crossCompanyAccessLog,
  crossCompanyInstructions,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

// The approve route wakes the liaison through the real heartbeat service;
// here we only need to see that the wake was asked for, not run an agent.
const wakeupCalls = vi.hoisted(() => [] as Array<{ agentId: string; opts: Record<string, unknown> }>);
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({
      wakeup: vi.fn(async (agentId: string, opts: Record<string, unknown>) => {
        wakeupCalls.push({ agentId, opts });
        return { id: randomUUID() };
      }),
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cross-company instruction channel tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

interface Company {
  id: string;
  name: string;
  agentId: string;
  liaisonId: string | null;
}

async function seedCompany(db: Db, label: string, opts: { liaisons?: number } = {}): Promise<Company> {
  const [company] = await db
    .insert(companies)
    .values({ name: `${label} ${randomUUID().slice(0, 6)}`, issuePrefix: `X${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}` })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({ companyId: company!.id, name: `${label} engineer`, role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
    .returning();
  let liaisonId: string | null = null;
  for (let i = 0; i < (opts.liaisons ?? 1); i++) {
    const [liaison] = await db
      .insert(agents)
      .values({ companyId: company!.id, name: `${label} tech boss ${i + 1}`, role: "tech_boss", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    liaisonId ??= liaison!.id;
  }
  return { id: company!.id, name: company!.name, agentId: agent!.id, liaisonId };
}

describeEmbeddedPostgres("guarded cross-company instruction channel", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  /** Set per request through a header so one app serves every actor shape. */
  const actorByToken = new Map<string, Express.Request["actor"]>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-company-instructions-");
    db = createDb(tempDb.connectionString);
    const [{ errorHandler }, { crossCompanyInstructionRoutes }, { approvalRoutes }] = await Promise.all([
      import("../middleware/index.js"),
      import("../routes/cross-company-instructions.js"),
      import("../routes/approvals.js"),
    ]);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const token = req.header("x-test-actor") ?? "";
      req.actor = actorByToken.get(token) ?? ({ type: "none" } as Express.Request["actor"]);
      next();
    });
    app.use("/api", crossCompanyInstructionRoutes(db));
    app.use("/api", approvalRoutes(db, {}));
    app.use(errorHandler);
  }, 60_000);

  afterEach(async () => {
    wakeupCalls.length = 0;
    actorByToken.clear();
    await db.delete(crossCompanyInstructions);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
    await db.delete(crossCompanyAccessLog);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setFlag(enabled: boolean) {
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableCrossCompanyInstructions: enabled } });
  }

  function agentActor(company: Company, agentId = company.agentId) {
    const token = `agent:${agentId}`;
    actorByToken.set(token, { type: "agent", agentId, companyId: company.id, source: "agent_key" } as Express.Request["actor"]);
    return token;
  }

  function boardActor(company: Company) {
    const userId = randomUUID();
    const token = `board:${userId}`;
    actorByToken.set(token, {
      type: "board",
      source: "session",
      userId,
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
    } as Express.Request["actor"]);
    return token;
  }

  /** The board user id behind a `boardActor` token (the sender must never learn it, so tests read it from here). */
  const userIdOf = (boardToken: string) => boardToken.slice("board:".length);

  const send = (token: string, from: Company, body: Record<string, unknown>) =>
    request(app).post(`/api/companies/${from.id}/cross-company-instructions`).set("x-test-actor", token).send(body);

  /** The receiving company's approval card id for an instruction -- read from the DB, since the sender is never told it. */
  async function approvalIdFor(instructionId: string) {
    const [row] = await db.select().from(crossCompanyInstructions).where(eq(crossCompanyInstructions.id, instructionId));
    expect(row?.approvalId).toBeTruthy();
    return row!.approvalId!;
  }

  const RECEIVING_SIDE_FIELDS = ["toAgentId", "approvalId", "deliveredIssueId", "decidedByUserId", "decisionNote"] as const;

  /** A sender-side view carries the sender's own side and the outcome, and NOTHING that belongs to the receiving company. */
  function expectSenderView(body: Record<string, unknown>, expected: { fromCompanyId: string; fromAgentId: string; toCompanyId: string; status: string }) {
    expect(body).toMatchObject(expected);
    expect(Object.keys(body).sort()).toEqual(
      ["createdAt", "decidedAt", "fromAgentId", "fromCompanyId", "id", "instruction", "status", "subject", "toCompanyId", "updatedAt"],
    );
    for (const field of RECEIVING_SIDE_FIELDS) {
      expect(body, `sender view must not carry ${field}`).not.toHaveProperty(field);
    }
  }

  /** Nothing from the receiving company's side of a decided instruction may appear anywhere in a sender-side response body. */
  function expectNoReceivingSideLeak(
    body: unknown,
    receiving: { decisionNote: string; deciderUserId: string; liaisonId: string | null; approvalId: string; issueId?: string | null },
    label: string,
  ) {
    const text = JSON.stringify(body);
    expect(text, `${label}: decision note leaked to the sender`).not.toContain(receiving.decisionNote);
    expect(text, `${label}: decider user id leaked to the sender`).not.toContain(receiving.deciderUserId);
    expect(text, `${label}: liaison agent id leaked to the sender`).not.toContain(String(receiving.liaisonId));
    expect(text, `${label}: approval card id leaked to the sender`).not.toContain(receiving.approvalId);
    if (receiving.issueId) {
      expect(text, `${label}: delivered issue id leaked to the sender`).not.toContain(receiving.issueId);
    }
    for (const field of RECEIVING_SIDE_FIELDS) {
      expect(text, `${label}: receiving-side field "${field}" present in a sender response`).not.toContain(`"${field}"`);
    }
  }

  it("is switched off by default: nothing can be sent and no row, card or log line is written", async () => {
    const A = await seedCompany(db, "Alpha");
    const B = await seedCompany(db, "Beta");
    const res = await send(agentActor(A), A, { toCompanyId: B.id, subject: "Set the deploy policy", instruction: "Please set deployPolicy on the dashboard project." });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("switched off");
    expect(await db.select().from(crossCompanyInstructions)).toHaveLength(0);
    expect(await db.select().from(approvals)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("with the flag on, an agent in A files an instruction that becomes a pending card in B's board, logged on both sides", async () => {
    await setFlag(true);
    const A = await seedCompany(db, "Alpha");
    const B = await seedCompany(db, "Beta");

    const res = await send(agentActor(A), A, {
      toCompanyId: B.id,
      subject: "Set the deploy policy",
      instruction: "Please set deployPolicy on the dashboard project so the shared deploy feature can run.",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // The sender gets its own side and the status -- not which of B's
    // agents is the liaison, nor B's approval card id.
    expectSenderView(res.body, { fromCompanyId: A.id, fromAgentId: A.agentId, toCompanyId: B.id, status: "pending_approval" });
    expect(JSON.stringify(res.body)).not.toContain(String(B.liaisonId));

    // In the DB the row is addressed to B's liaison and linked to B's card.
    const [stored] = await db.select().from(crossCompanyInstructions).where(eq(crossCompanyInstructions.id, res.body.id));
    expect(stored!.toAgentId).toBe(B.liaisonId);
    const approvalId = await approvalIdFor(res.body.id);
    expect(JSON.stringify(res.body)).not.toContain(approvalId);

    // The card is in B's board, in plain language, naming who asks and
    // what they ask, and saying nothing crosses -- and it is NOT attributed
    // to a requesting agent (the asker is not one of B's agents).
    const [card] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(card!.companyId).toBe(B.id);
    expect(card!.status).toBe("pending");
    expect(card!.requestedByAgentId).toBeNull();
    const payload = card!.payload as Record<string, unknown>;
    expect(payload.kind).toBe("cross_company_instruction");
    expect(payload.title).toBe(`Instruction from ${A.name} for Beta tech boss 1`);
    expect(String(payload.summary)).toContain(`Alpha engineer at ${A.name} asks Beta tech boss 1 to: Set the deploy policy`);
    expect(String(payload.summary)).toContain("Please set deployPolicy");
    expect(String(payload.nextActionOnApproval)).toContain("no data, files, keys or access are shared");

    // Nothing was delivered yet.
    expect(await db.select().from(issues)).toHaveLength(0);

    // Logged on both sides.
    const logs = await db.select().from(activityLog);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ companyId: A.id, action: "cross_company_instruction.sent", agentId: A.agentId }),
        expect.objectContaining({ companyId: B.id, action: "cross_company_instruction.received", agentId: B.liaisonId }),
      ]),
    );
    // And the one cross-company write is itself on record.
    const crossings = await db.select().from(crossCompanyAccessLog);
    expect(crossings.map((row) => row.reason)).toContain("cross_company_instruction.send");
  });

  it("refuses to send unless the receiving company has exactly one liaison, and never reveals whether a company id exists", async () => {
    await setFlag(true);
    const A = await seedCompany(db, "Alpha");
    const noLiaison = await seedCompany(db, "Gamma", { liaisons: 0 });
    const twoLiaisons = await seedCompany(db, "Delta", { liaisons: 2 });
    const body = { subject: "Hello", instruction: "Do the thing." };

    const none = await send(agentActor(A), A, { ...body, toCompanyId: noLiaison.id });
    expect(none.status).toBe(422);
    expect(none.body.error).toContain("no liaison agent");

    const two = await send(agentActor(A), A, { ...body, toCompanyId: twoLiaisons.id });
    expect(two.status).toBe(422);
    expect(two.body.error).toContain("more than one liaison");

    const missing = await send(agentActor(A), A, { ...body, toCompanyId: randomUUID() });
    expect(missing.status).toBe(422);
    expect(missing.body.error).toBe("The receiving company cannot receive instructions");

    const self = await send(agentActor(A), A, { ...body, toCompanyId: A.id });
    expect(self.status).toBe(422);

    expect(await db.select().from(crossCompanyInstructions)).toHaveLength(0);
    expect(await db.select().from(approvals)).toHaveLength(0);
  });

  it("an agent of company A cannot send on behalf of company B, and only plain text is accepted", async () => {
    await setFlag(true);
    const A = await seedCompany(db, "Alpha");
    const B = await seedCompany(db, "Beta");

    const asB = await request(app)
      .post(`/api/companies/${B.id}/cross-company-instructions`)
      .set("x-test-actor", agentActor(A))
      .send({ toCompanyId: A.id, subject: "x", instruction: "y" });
    expect(asB.status).toBe(403);

    const extraField = await send(agentActor(A), A, { toCompanyId: B.id, subject: "x", instruction: "y", attachmentIssueId: randomUUID() });
    expect(extraField.status).toBe(400);

    expect(await db.select().from(crossCompanyInstructions)).toHaveLength(0);
  });

  it("only company B's board can approve; approving delivers the instruction to the liaison as an issue, wakes it and logs both sides", async () => {
    await setFlag(true);
    const A = await seedCompany(db, "Alpha");
    const B = await seedCompany(db, "Beta");
    const sent = await send(agentActor(A), A, { toCompanyId: B.id, subject: "Set the deploy policy", instruction: "Please set deployPolicy on the dashboard project." });
    expect(sent.status).toBe(201);
    const approvalId = await approvalIdFor(sent.body.id);

    // Company A's board cannot decide company B's card; neither can A's agent.
    const aBoard = await request(app).post(`/api/approvals/${approvalId}/approve`).set("x-test-actor", boardActor(A)).send({});
    expect(aBoard.status).toBe(403);
    const aAgent = await request(app).post(`/api/approvals/${approvalId}/approve`).set("x-test-actor", agentActor(A)).send({});
    expect(aAgent.status).toBe(403);
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(wakeupCalls).toHaveLength(0);

    const bBoardToken = boardActor(B);
    const decisionNote = "BETA-PRIVATE-NOTE fine, go ahead; our client X is unhappy about the delay.";
    const approved = await request(app).post(`/api/approvals/${approvalId}/approve`).set("x-test-actor", bBoardToken).send({ decisionNote });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe("approved");

    const [row] = await db.select().from(crossCompanyInstructions).where(eq(crossCompanyInstructions.id, sent.body.id));
    expect(row!.status).toBe("delivered");
    expect(row!.decisionNote).toBe(decisionNote);
    expect(row!.decidedByUserId).toBe(userIdOf(bBoardToken));
    expect(row!.deliveredIssueId).toBeTruthy();

    // The sender sees the outcome and nothing from B's side: not the board's
    // note, not who decided, not B's liaison, card or task.
    const receivingSide = { decisionNote, deciderUserId: userIdOf(bBoardToken), liaisonId: B.liaisonId, approvalId, issueId: row!.deliveredIssueId };
    const listAsA = await request(app).get(`/api/companies/${A.id}/cross-company-instructions`).set("x-test-actor", agentActor(A));
    expect(listAsA.status).toBe(200);
    expect(listAsA.body).toHaveLength(1);
    expectSenderView(listAsA.body[0], { fromCompanyId: A.id, fromAgentId: A.agentId, toCompanyId: B.id, status: "delivered" });
    expect(listAsA.body[0].decidedAt).toBeTruthy();
    expectNoReceivingSideLeak(listAsA.body, receivingSide, "A's agent list after approval");
    const listAsABoard = await request(app).get(`/api/companies/${A.id}/cross-company-instructions`).set("x-test-actor", boardActor(A));
    expect(listAsABoard.status).toBe(200);
    expectNoReceivingSideLeak(listAsABoard.body, receivingSide, "A's board list after approval");
    // ...while the receiving company sees its own full record.
    const listAsB = await request(app).get(`/api/companies/${B.id}/cross-company-instructions`).set("x-test-actor", bBoardToken);
    expect(listAsB.status).toBe(200);
    expect(listAsB.body[0]).toMatchObject({
      toAgentId: B.liaisonId,
      approvalId,
      deliveredIssueId: row!.deliveredIssueId,
      decidedByUserId: userIdOf(bBoardToken),
      decisionNote,
      status: "delivered",
    });

    const [issue] = await db.select().from(issues).where(eq(issues.id, row!.deliveredIssueId!));
    expect(issue!.companyId).toBe(B.id);
    expect(issue!.assigneeAgentId).toBe(B.liaisonId);
    expect(issue!.title).toBe(`Instruction from ${A.name}: Set the deploy policy`);
    expect(issue!.description).toContain("Please set deployPolicy on the dashboard project.");
    expect(issue!.description).toContain("Do not share this company's data");
    expect(await db.select().from(issues).where(eq(issues.companyId, A.id))).toHaveLength(0);

    expect(wakeupCalls).toHaveLength(1);
    expect(wakeupCalls[0]!.agentId).toBe(B.liaisonId);
    expect(wakeupCalls[0]!.opts.reason).toBe("cross_company_instruction_approved");

    const logs = await db.select().from(activityLog);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ companyId: B.id, action: "cross_company_instruction.delivered", entityId: row!.id }),
        expect.objectContaining({ companyId: A.id, action: "cross_company_instruction.approved", entityId: row!.id }),
      ]),
    );
    // The line written back to A carries only the outcome, nothing from B.
    const backToA = logs.find((line) => line.companyId === A.id && line.action === "cross_company_instruction.approved");
    expect(JSON.stringify(backToA!.details)).not.toContain(issue!.id);
    expect(JSON.stringify(backToA!.details)).not.toContain(String(B.liaisonId));

    // Approving twice does not deliver twice.
    const again = await request(app).post(`/api/approvals/${approvalId}/approve`).set("x-test-actor", bBoardToken).send({});
    expect(again.status).toBe(200);
    expect(await db.select().from(issues).where(eq(issues.companyId, B.id))).toHaveLength(1);
    expect(wakeupCalls).toHaveLength(1);
  });

  it("rejecting delivers nothing, marks the instruction rejected and tells the sender only that it was declined", async () => {
    await setFlag(true);
    const A = await seedCompany(db, "Alpha");
    const B = await seedCompany(db, "Beta");
    const sent = await send(agentActor(A), A, { toCompanyId: B.id, subject: "Set the deploy policy", instruction: "Please set deployPolicy." });
    const approvalId = await approvalIdFor(sent.body.id);

    const bBoardToken = boardActor(B);
    const decisionNote = "BETA-PRIVATE-NOTE not now, we are mid-audit.";
    const rejected = await request(app).post(`/api/approvals/${approvalId}/reject`).set("x-test-actor", bBoardToken).send({ decisionNote });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    const [row] = await db.select().from(crossCompanyInstructions).where(eq(crossCompanyInstructions.id, sent.body.id));
    expect(row!.status).toBe("rejected");
    expect(row!.decisionNote).toBe(decisionNote);
    expect(row!.deliveredIssueId).toBeNull();
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(wakeupCalls).toHaveLength(0);

    const logs = await db.select().from(activityLog);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ companyId: B.id, action: "cross_company_instruction.rejected" }),
        expect.objectContaining({ companyId: A.id, action: "cross_company_instruction.rejected" }),
      ]),
    );
    const backToA = logs.find((line) => line.companyId === A.id && line.action === "cross_company_instruction.rejected");
    expect(JSON.stringify(backToA!.details)).not.toContain(decisionNote);

    // The sender learns "declined" and nothing else from B's side.
    const receivingSide = { decisionNote, deciderUserId: userIdOf(bBoardToken), liaisonId: B.liaisonId, approvalId };
    const listAsA = await request(app).get(`/api/companies/${A.id}/cross-company-instructions`).set("x-test-actor", agentActor(A));
    expect(listAsA.status).toBe(200);
    expect(listAsA.body).toHaveLength(1);
    expectSenderView(listAsA.body[0], { fromCompanyId: A.id, fromAgentId: A.agentId, toCompanyId: B.id, status: "rejected" });
    expectNoReceivingSideLeak(listAsA.body, receivingSide, "A's agent list after rejection");
    const listAsABoard = await request(app).get(`/api/companies/${A.id}/cross-company-instructions`).set("x-test-actor", boardActor(A));
    expect(listAsABoard.status).toBe(200);
    expectNoReceivingSideLeak(listAsABoard.body, receivingSide, "A's board list after rejection");
  });

  it("a card can never sit approved with nothing delivered: delivery failure puts the card back, and only the approvals page can decide it", async () => {
    await setFlag(true);
    const A = await seedCompany(db, "Alpha");
    const B = await seedCompany(db, "Beta");
    const sent = await send(agentActor(A), A, { toCompanyId: B.id, subject: "Set the deploy policy", instruction: "Please set deployPolicy." });
    expect(sent.status).toBe(201);
    const approvalId = await approvalIdFor(sent.body.id);
    const bBoardToken = boardActor(B);

    // Any other approve path (thread interactions, automations, the hire
    // route) goes through approvalService without the delivery hooks and is
    // refused in plain language before anything is written.
    const { approvalService } = await import("../services/approvals.js");
    await expect(approvalService(db).approve(approvalId, userIdOf(bBoardToken), "auto")).rejects.toThrow("approvals page");
    await expect(approvalService(db).reject(approvalId, userIdOf(bBoardToken), "auto")).rejects.toThrow("approvals page");
    let [card] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(card!.status).toBe("pending");
    expect(card!.decidedByUserId).toBeNull();

    // With the channel switched off again, an already-filed card cannot turn
    // into work; it stays pending (it could still be declined).
    await setFlag(false);
    const off = await request(app).post(`/api/approvals/${approvalId}/approve`).set("x-test-actor", bBoardToken).send({ decisionNote: "ok" });
    expect(off.status).toBe(403);
    [card] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(card!.status).toBe("pending");
    expect(card!.decisionNote).toBeNull();
    await setFlag(true);

    // The liaison is gone by the time the board approves: the approval
    // fails with a plain reason, the card is back to pending, no task
    // exists, the instruction is still pending and the sender heard nothing.
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, B.liaisonId!));
    const failed = await request(app).post(`/api/approvals/${approvalId}/approve`).set("x-test-actor", bBoardToken).send({ decisionNote: "ok" });
    expect(failed.status, JSON.stringify(failed.body)).toBe(422);
    expect(failed.body.error).toContain("liaison agent");
    [card] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(card!.status).toBe("pending");
    expect(card!.decidedByUserId).toBeNull();
    expect(card!.decisionNote).toBeNull();
    const [row] = await db.select().from(crossCompanyInstructions).where(eq(crossCompanyInstructions.id, sent.body.id));
    expect(row!.status).toBe("pending_approval");
    expect(row!.deliveredIssueId).toBeNull();
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(wakeupCalls).toHaveLength(0);
    const logs = await db.select().from(activityLog);
    expect(logs.filter((line) => line.action === "cross_company_instruction.approved" || line.action === "approval.approved")).toHaveLength(0);

    // Declining still works without a liaison: nothing to deliver.
    const rejected = await request(app).post(`/api/approvals/${approvalId}/reject`).set("x-test-actor", bBoardToken).send({});
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const [afterReject] = await db.select().from(crossCompanyInstructions).where(eq(crossCompanyInstructions.id, sent.body.id));
    expect(afterReject!.status).toBe("rejected");
  });

  it("each company lists only the instructions it sent or received, and an outsider sees none of them", async () => {
    await setFlag(true);
    const A = await seedCompany(db, "Alpha");
    const B = await seedCompany(db, "Beta");
    const C = await seedCompany(db, "Ceta");
    const ab = await send(agentActor(A), A, { toCompanyId: B.id, subject: "A to B", instruction: "one" });
    const cb = await send(agentActor(C), C, { toCompanyId: B.id, subject: "C to B", instruction: "two" });
    expect(ab.status).toBe(201);
    expect(cb.status).toBe(201);

    const listA = await request(app).get(`/api/companies/${A.id}/cross-company-instructions`).set("x-test-actor", agentActor(A));
    expect(listA.status).toBe(200);
    expect(listA.body.map((row: { subject: string }) => row.subject)).toEqual(["A to B"]);

    const listB = await request(app).get(`/api/companies/${B.id}/cross-company-instructions`).set("x-test-actor", boardActor(B));
    expect(listB.status).toBe(200);
    expect(listB.body.map((row: { subject: string }) => row.subject).sort()).toEqual(["A to B", "C to B"]);

    const listBAsA = await request(app).get(`/api/companies/${B.id}/cross-company-instructions`).set("x-test-actor", agentActor(A));
    expect(listBAsA.status).toBe(403);
    expect(JSON.stringify(listBAsA.body)).not.toContain("C to B");

    // A's own list never shows C's traffic to B.
    expect(JSON.stringify(listA.body)).not.toContain("C to B");
    expect(JSON.stringify(listA.body)).not.toContain(C.id);
  });

  it("a board user of company A can send on behalf of one of A's agents, but not on behalf of an agent from B", async () => {
    await setFlag(true);
    const A = await seedCompany(db, "Alpha");
    const B = await seedCompany(db, "Beta");
    const token = boardActor(A);

    const noAgent = await send(token, A, { toCompanyId: B.id, subject: "x", instruction: "y" });
    expect(noAgent.status).toBe(422);

    const foreignAgent = await request(app)
      .post(`/api/companies/${A.id}/cross-company-instructions?fromAgentId=${B.agentId}`)
      .set("x-test-actor", token)
      .send({ toCompanyId: B.id, subject: "x", instruction: "y" });
    expect(foreignAgent.status).toBe(422);

    const ok = await request(app)
      .post(`/api/companies/${A.id}/cross-company-instructions?fromAgentId=${A.agentId}`)
      .set("x-test-actor", token)
      .send({ toCompanyId: B.id, subject: "x", instruction: "y" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.fromAgentId).toBe(A.agentId);

    const rows = await db
      .select()
      .from(crossCompanyInstructions)
      .where(and(eq(crossCompanyInstructions.fromCompanyId, A.id), eq(crossCompanyInstructions.toCompanyId, B.id)));
    expect(rows).toHaveLength(1);
  });
});
