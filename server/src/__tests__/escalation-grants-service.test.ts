import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  costEvents,
  escalationGrants,
  issueComments,
  issues,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import type { ModelBoostRequestPayload } from "@paperclipai/shared";
import { escalationGrantService } from "../services/escalation-grants.ts";
import { costService } from "../services/costs.ts";
import { eq } from "drizzle-orm";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function boostPayload(overrides: Partial<ModelBoostRequestPayload> = {}): ModelBoostRequestPayload {
  return {
    kind: "model_boost",
    issueId: randomUUID(),
    agentId: randomUUID(),
    requestedModel: "opus",
    reason: "This refactor spans 40 files and I keep losing track.",
    estimatedExtraCostCents: 500,
    maxSpendCents: 1000,
    title: "Boost for the refactor",
    summary: "Requesting a stronger model for a wide refactor.",
    ...overrides,
  };
}

describeEmbeddedPostgres("escalation grant service (DUR-31)", () => {
  let db!: ReturnType<typeof createDb>;
  let grants!: ReturnType<typeof escalationGrantService>;
  let costs!: ReturnType<typeof costService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-escalation-grants-");
    db = createDb(tempDb.connectionString);
    grants = escalationGrantService(db);
    costs = costService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(escalationGrants);
    await db.delete(costEvents);
    await db.delete(issueComments);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Escalating Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "A hard task",
      status: "in_progress",
      priority: "medium",
    });
    return { companyId, agentId, issueId };
  }

  async function insertApproval(input: {
    companyId: string;
    requestedByAgentId: string;
    status: "pending" | "approved" | "rejected";
    payload: ModelBoostRequestPayload;
  }) {
    const [row] = await db
      .insert(approvals)
      .values({
        companyId: input.companyId,
        type: "request_board_approval",
        requestedByAgentId: input.requestedByAgentId,
        status: input.status,
        payload: input.payload,
      })
      .returning();
    return row;
  }

  it("creates an active, time-boxed, money-capped grant from an approved request", async () => {
    const { companyId, agentId, issueId } = await seed();
    const payload = boostPayload({ issueId, agentId, durationMinutes: 60 });
    const approval = await insertApproval({ companyId, requestedByAgentId: agentId, status: "approved", payload });

    const grant = await grants.createFromApproval({ companyId, approvalId: approval.id, payload });

    expect(grant.status).toBe("active");
    expect(grant.grantedModel).toBe("opus");
    expect(grant.grantedEffort).toBeNull();
    expect(grant.maxSpendCents).toBe(1000);
    expect(grant.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(grant.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 61 * 60_000);
  });

  it("resolves an active grant for dispatch when within time and budget", async () => {
    const { companyId, agentId, issueId } = await seed();
    const payload = boostPayload({ issueId, agentId });
    const approval = await insertApproval({ companyId, requestedByAgentId: agentId, status: "approved", payload });
    await grants.createFromApproval({ companyId, approvalId: approval.id, payload });

    const resolved = await grants.resolveActiveGrantForDispatch({ companyId, agentId, issueId });
    expect(resolved).not.toBeNull();
    expect(resolved?.grantedModel).toBe("opus");
  });

  it("expires a grant whose time window has passed and posts a plain-language note", async () => {
    const { companyId, agentId, issueId } = await seed();
    const payload = boostPayload({ issueId, agentId });
    const approval = await insertApproval({ companyId, requestedByAgentId: agentId, status: "approved", payload });
    const created = await grants.createFromApproval({ companyId, approvalId: approval.id, payload });
    await db
      .update(escalationGrants)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(escalationGrants.id, created.id));

    const resolved = await grants.resolveActiveGrantForDispatch({ companyId, agentId, issueId });
    expect(resolved).toBeNull();

    const [row] = await db.select().from(escalationGrants).where(eq(escalationGrants.id, created.id));
    expect(row?.status).toBe("expired");
    expect(row?.expiredReason).toBe("time_expired");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorType).toBe("system");
    expect(comments[0]?.body).toMatch(/back to the normal setting/i);
  });

  it("expires a grant once cumulative issue spend reaches the money cap", async () => {
    const { companyId, agentId, issueId } = await seed();
    const payload = boostPayload({ issueId, agentId, maxSpendCents: 500 });
    const approval = await insertApproval({ companyId, requestedByAgentId: agentId, status: "approved", payload });
    await grants.createFromApproval({ companyId, approvalId: approval.id, payload });

    await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "opus",
      costCents: 500,
      occurredAt: new Date(),
    });

    const resolved = await grants.resolveActiveGrantForDispatch({ companyId, agentId, issueId });
    expect(resolved).toBeNull();

    const [row] = await db
      .select()
      .from(escalationGrants)
      .where(eq(escalationGrants.issueId, issueId));
    expect(row?.status).toBe("expired");
    expect(row?.expiredReason).toBe("budget_exhausted");
  });

  it("expires the grant in real time as costService.createEvent records spend past the cap", async () => {
    const { companyId, agentId, issueId } = await seed();
    const payload = boostPayload({ issueId, agentId, maxSpendCents: 300 });
    const approval = await insertApproval({ companyId, requestedByAgentId: agentId, status: "approved", payload });
    const created = await grants.createFromApproval({ companyId, approvalId: approval.id, payload });

    await costs.createEvent(companyId, {
      agentId,
      issueId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "opus",
      costCents: 400,
      occurredAt: new Date(),
    });

    const [row] = await db.select().from(escalationGrants).where(eq(escalationGrants.id, created.id));
    expect(row?.status).toBe("expired");
    expect(row?.expiredReason).toBe("budget_exhausted");
  });

  it("blocks a new request while an active grant already covers the task", async () => {
    const { companyId, agentId, issueId } = await seed();
    const payload = boostPayload({ issueId, agentId });
    const approval = await insertApproval({ companyId, requestedByAgentId: agentId, status: "approved", payload });
    await grants.createFromApproval({ companyId, approvalId: approval.id, payload });

    await expect(
      grants.assertRequestAllowed({ companyId, issueId, agentId, reason: "Something new" }),
    ).rejects.toThrow(/active boost grant/i);
  });

  it("blocks a new request while an identical one is still pending", async () => {
    const { companyId, agentId, issueId } = await seed();
    const payload = boostPayload({ issueId, agentId });
    await insertApproval({ companyId, requestedByAgentId: agentId, status: "pending", payload });

    await expect(
      grants.assertRequestAllowed({ companyId, issueId, agentId, reason: payload.reason }),
    ).rejects.toThrow(/already pending/i);
  });

  it("blocks re-asking with the same reason right after a denial", async () => {
    const { companyId, agentId, issueId } = await seed();
    const payload = boostPayload({ issueId, agentId, reason: "I need a bigger model, please." });
    await insertApproval({ companyId, requestedByAgentId: agentId, status: "rejected", payload });

    await expect(
      grants.assertRequestAllowed({
        companyId,
        issueId,
        agentId,
        reason: "  I NEED a bigger model, please.  ",
      }),
    ).rejects.toThrow(/denied for the same reason/i);
  });

  it("allows re-asking after a denial once the reason materially changes", async () => {
    const { companyId, agentId, issueId } = await seed();
    const payload = boostPayload({ issueId, agentId, reason: "I need a bigger model, please." });
    await insertApproval({ companyId, requestedByAgentId: agentId, status: "rejected", payload });

    await expect(
      grants.assertRequestAllowed({
        companyId,
        issueId,
        agentId,
        reason: "New blocker: the migration touches a different subsystem than I expected.",
      }),
    ).resolves.toBeUndefined();
  });
});
