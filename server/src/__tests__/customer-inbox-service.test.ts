import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  customerInboxConversations,
  customerInboxDeliveries,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issues,
  projectWorkspaces,
  projects,
  routineDocuments,
  routineRuns,
  routines,
  routineTriggers,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres customer-inbox tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("customer-inbox door: conversation threading + unreadable-message escalation (DUR-93)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-customer-inbox-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(customerInboxConversations);
    await db.delete(customerInboxDeliveries);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(routineDocuments);
    await db.delete(documents);
    await db.delete(documentRevisions);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(opts?: { secretaryReportsToBoss?: boolean }) {
    const companyId = randomUUID();
    const bossAgentId = randomUUID();
    const secretaryAgentId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const wakeups: Array<{ agentId: string; opts: Record<string, unknown> }> = [];

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: bossAgentId,
      companyId,
      name: "Boss",
      role: "general",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agents).values({
      id: secretaryAgentId,
      companyId,
      name: "Kundesekretær",
      role: "general",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      reportsTo: opts?.secretaryReportsToBoss === false ? null : bossAgentId,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Customer inbox",
      status: "in_progress",
    });

    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          wakeups.push({ agentId: wakeupAgentId, opts: wakeupOpts as Record<string, unknown> });
          const issueId =
            (typeof (wakeupOpts.payload as Record<string, unknown> | undefined)?.issueId === "string" &&
              (wakeupOpts.payload as Record<string, unknown>).issueId) ||
            null;
          if (!issueId) return null;
          const queuedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: queuedRunId,
            companyId,
            agentId: wakeupAgentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
          });
          return { id: queuedRunId };
        },
      },
    });

    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Innkommende kundehenvendelser",
        description: "Test inbox routine",
        assigneeAgentId: secretaryAgentId,
        priority: "high",
        status: "active",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "bearer",
        customerInboxChannel: "email",
      },
      {},
    );

    return { companyId, bossAgentId, secretaryAgentId, routine, trigger, secretMaterial: secretMaterial!, svc, wakeups };
  }

  function messagePayload(overrides: Record<string, unknown> = {}) {
    return {
      channel: "email",
      messageId: `msg-${randomUUID()}`,
      fromAddress: "kunde@example.no",
      fromName: "Ola Nordmann",
      subject: "Skadet bord ved levering",
      body: "Bordet kom skadet, hva gjør jeg?",
      receivedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  async function post(svc: Awaited<ReturnType<typeof seedFixture>>["svc"], trigger: { publicId: string | null }, secret: string, payload: Record<string, unknown>) {
    return svc.receiveCustomerInboxMessage(trigger.publicId as string, {
      authorizationHeader: `Bearer ${secret}`,
      payload,
      rawBody: Buffer.from(JSON.stringify(payload)),
    });
  }

  it("creates one task for a new conversation, then comments on the same task and wakes its assignee for a follow-up message", async () => {
    const { secretaryAgentId, trigger, secretMaterial, svc, wakeups } = await seedFixture();
    const conversationId = `thread-${randomUUID()}`;

    const first = await post(svc, trigger, secretMaterial.webhookSecret, messagePayload({ conversationId }));
    expect(first.outcome).toBe("accepted");
    expect(first.issueId).toBeTruthy();

    const mappingRows = await db
      .select()
      .from(customerInboxConversations)
      .where(eq(customerInboxConversations.conversationId, conversationId));
    expect(mappingRows).toHaveLength(1);
    expect(mappingRows[0].linkedIssueId).toBe(first.issueId);

    const second = await post(svc, trigger, secretMaterial.webhookSecret, messagePayload({ conversationId, subject: "Re: Skadet bord ved levering" }));
    expect(second.outcome).toBe("accepted");
    expect(second.issueId).toBe(first.issueId);
    expect(second.routineRunId).toBeNull();

    const allIssues = await db.select({ id: issues.id }).from(issues).where(eq(issues.originId, trigger.routineId));
    expect(allIssues).toHaveLength(1);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, first.issueId!));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Ny melding i samme samtale");

    expect(wakeups.some((w) => w.agentId === secretaryAgentId && w.opts.reason === "customer_inbox.conversation_continued")).toBe(true);
  });

  it("reopens a done task when a new message arrives for the same conversation, and wakes its assignee", async () => {
    const { secretaryAgentId, trigger, secretMaterial, svc, wakeups } = await seedFixture();
    const conversationId = `thread-${randomUUID()}`;

    const first = await post(svc, trigger, secretMaterial.webhookSecret, messagePayload({ conversationId }));
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, first.issueId!));

    wakeups.length = 0;
    const second = await post(svc, trigger, secretMaterial.webhookSecret, messagePayload({ conversationId }));
    expect(second.outcome).toBe("accepted");
    expect(second.issueId).toBe(first.issueId);

    const [reopened] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, first.issueId!));
    expect(reopened.status).toBe("todo");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, first.issueId!));
    expect(comments.some((c) => c.body.includes("gjenåpnet"))).toBe(true);
    expect(wakeups.some((w) => w.agentId === secretaryAgentId)).toBe(true);
  });

  it("does not double-comment when the same messageId is replayed for an open conversation", async () => {
    const { trigger, secretMaterial, svc } = await seedFixture();
    const conversationId = `thread-${randomUUID()}`;
    const payload = messagePayload({ conversationId });

    const first = await post(svc, trigger, secretMaterial.webhookSecret, payload);
    const replay = await post(svc, trigger, secretMaterial.webhookSecret, payload);

    expect(replay.outcome).toBe("duplicate");
    expect(replay.issueId).toBe(first.issueId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, first.issueId!));
    expect(comments).toHaveLength(0);

    const deliveries = await db
      .select({ outcome: customerInboxDeliveries.outcome })
      .from(customerInboxDeliveries)
      .where(eq(customerInboxDeliveries.externalMessageId, payload.messageId));
    expect(deliveries.map((d) => d.outcome).sort()).toEqual(["accepted", "duplicate"]);
  });

  it("opens one escalation task for the routine's default agent's reportsTo when a message is unreadable, then appends to it instead of opening a second task", async () => {
    const { bossAgentId, trigger, secretMaterial, svc } = await seedFixture();

    await expect(
      post(svc, trigger, secretMaterial.webhookSecret, { channel: "email", subject: "no message id" }),
    ).rejects.toThrow();

    const afterFirst = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, trigger.companyId), eq(issues.originKind, "customer_inbox_unreadable")));
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].assigneeAgentId).toBe(bossAgentId);
    expect(afterFirst[0].status).toBe("todo");
    expect(afterFirst[0].priority).toBe("high");

    await expect(
      post(svc, trigger, secretMaterial.webhookSecret, { channel: "email", subject: "still no message id" }),
    ).rejects.toThrow();

    const afterSecond = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, trigger.companyId), eq(issues.originKind, "customer_inbox_unreadable")));
    expect(afterSecond).toHaveLength(1);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, afterSecond[0].id));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Enda en melding");
  });

  it("does not escalate rejected_signature deliveries (ledger only)", async () => {
    const { trigger, svc } = await seedFixture();

    await expect(
      post(svc, trigger, "wrong-secret", messagePayload()),
    ).rejects.toThrow();

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, trigger.companyId), eq(issues.originKind, "customer_inbox_unreadable")));
    expect(escalations).toHaveLength(0);

    const deliveries = await db.select({ outcome: customerInboxDeliveries.outcome }).from(customerInboxDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].outcome).toBe("rejected_signature");
  });

  it("skips escalation without throwing when the default agent has no reportsTo", async () => {
    const { trigger, secretMaterial, svc } = await seedFixture({ secretaryReportsToBoss: false });

    await expect(
      post(svc, trigger, secretMaterial.webhookSecret, { channel: "email", subject: "no message id" }),
    ).rejects.toThrow("messageId is required");

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, trigger.companyId), eq(issues.originKind, "customer_inbox_unreadable")));
    expect(escalations).toHaveLength(0);
  });
});
