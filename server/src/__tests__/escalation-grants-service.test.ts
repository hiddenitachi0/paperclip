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
import { buildBossReviewStamp, escalationGrantService } from "../services/escalation-grants.ts";
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

  async function seedBoss(companyId: string, input: { name: string; status?: string; reportsTo?: string | null }) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: input.name,
      role: "lead",
      status: input.status ?? "idle",
      reportsTo: input.reportsTo ?? null,
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function setReportsTo(agentId: string, reportsTo: string | null) {
    await db.update(agents).set({ reportsTo }).where(eq(agents.id, agentId));
  }

  describe("boss-first routing (agent -> boss -> operator)", () => {
    it("routes to the direct boss when there is one", async () => {
      const { companyId, agentId } = await seed();
      const bossId = await seedBoss(companyId, { name: "Engineering Lead" });
      await setReportsTo(agentId, bossId);

      await expect(grants.resolveBossForAgent(companyId, agentId)).resolves.toEqual({
        id: bossId,
        name: "Engineering Lead",
      });
    });

    it("skips a boss who cannot answer (terminated/paused) and keeps walking up", async () => {
      const { companyId, agentId } = await seed();
      const ceoId = await seedBoss(companyId, { name: "CEO" });
      const leadId = await seedBoss(companyId, { name: "Former Lead", status: "terminated", reportsTo: ceoId });
      await setReportsTo(agentId, leadId);

      await expect(grants.resolveBossForAgent(companyId, agentId)).resolves.toEqual({ id: ceoId, name: "CEO" });
    });

    it("goes straight to the operator when there is nobody above (or the chain loops)", async () => {
      const { companyId, agentId } = await seed();
      await expect(grants.resolveBossForAgent(companyId, agentId)).resolves.toBeNull();

      // A cycle through a boss who cannot answer must not spin forever.
      const goneId = await seedBoss(companyId, { name: "Gone", status: "terminated" });
      await setReportsTo(agentId, goneId);
      await setReportsTo(goneId, agentId);
      await expect(grants.resolveBossForAgent(companyId, agentId)).resolves.toBeNull();
    });

    it("lets the boss decline: the ask is rejected in the boss's words and never reaches the operator queue", async () => {
      const { companyId, agentId, issueId } = await seed();
      const bossId = await seedBoss(companyId, { name: "Engineering Lead" });
      const payload = boostPayload({
        issueId,
        agentId,
        bossReview: buildBossReviewStamp({ id: bossId, name: "Engineering Lead" }),
      });
      const approval = await insertApproval({ companyId, requestedByAgentId: agentId, status: "pending", payload });

      const updated = await grants.recordBossDecision({
        approvalId: approval.id,
        bossAgentId: bossId,
        decision: "decline",
        note: "The task is nearly done on the normal setting.",
      });

      expect(updated.status).toBe("rejected");
      expect(updated.decisionNote).toBe("Engineering Lead said no: The task is nearly done on the normal setting.");
      expect((updated.payload.bossReview as Record<string, unknown>).status).toBe("declined");
      // Deny = stay on base: no grant was ever created.
      await expect(grants.resolveActiveGrantForDispatch({ companyId, agentId, issueId })).resolves.toBeNull();
      // And the requester can't re-ask with the same reason right after the boss's no.
      await expect(
        grants.assertRequestAllowed({ companyId, issueId, agentId, reason: payload.reason }),
      ).rejects.toThrow(/denied for the same reason/i);
    });

    it("lets the boss forward with a recommendation; the ask stays pending for the operator", async () => {
      const { companyId, agentId, issueId } = await seed();
      const bossId = await seedBoss(companyId, { name: "Engineering Lead" });
      const payload = boostPayload({
        issueId,
        agentId,
        bossReview: buildBossReviewStamp({ id: bossId, name: "Engineering Lead" }),
      });
      const approval = await insertApproval({ companyId, requestedByAgentId: agentId, status: "pending", payload });

      const updated = await grants.recordBossDecision({
        approvalId: approval.id,
        bossAgentId: bossId,
        decision: "forward",
        note: "Worth it, the task is genuinely stuck.",
      });

      expect(updated.status).toBe("pending");
      const review = updated.payload.bossReview as Record<string, unknown>;
      expect(review.status).toBe("forwarded");
      expect(review.note).toBe("Worth it, the task is genuinely stuck.");

      // A second answer is refused: the ask is no longer waiting on the boss.
      await expect(
        grants.recordBossDecision({ approvalId: approval.id, bossAgentId: bossId, decision: "decline" }),
      ).rejects.toThrow(/no longer waiting on the boss/i);
    });

    it("refuses an answer from anyone but the boss named on the ask", async () => {
      const { companyId, agentId, issueId } = await seed();
      const bossId = await seedBoss(companyId, { name: "Engineering Lead" });
      const impostorId = await seedBoss(companyId, { name: "Someone Else" });
      const payload = boostPayload({
        issueId,
        agentId,
        bossReview: buildBossReviewStamp({ id: bossId, name: "Engineering Lead" }),
      });
      const approval = await insertApproval({ companyId, requestedByAgentId: agentId, status: "pending", payload });

      await expect(
        grants.recordBossDecision({ approvalId: approval.id, bossAgentId: impostorId, decision: "decline" }),
      ).rejects.toThrow(/only the boss/i);
      await expect(
        grants.recordBossDecision({ approvalId: approval.id, bossAgentId: agentId, decision: "forward" }),
      ).rejects.toThrow(/only the boss/i);
    });

    it("moves an ask on to the operator once the boss's time is up, and leaves fresh ones alone", async () => {
      const { companyId, agentId, issueId } = await seed();
      const bossId = await seedBoss(companyId, { name: "Engineering Lead" });
      const stale = buildBossReviewStamp(
        { id: bossId, name: "Engineering Lead" },
        new Date(Date.now() - 2 * 60 * 60_000),
      );
      const staleApproval = await insertApproval({
        companyId,
        requestedByAgentId: agentId,
        status: "pending",
        payload: boostPayload({ issueId, agentId, bossReview: stale }),
      });
      const otherIssueId = randomUUID();
      await db.insert(issues).values({ id: otherIssueId, companyId, title: "Another", status: "in_progress", priority: "medium" });
      const freshApproval = await insertApproval({
        companyId,
        requestedByAgentId: agentId,
        status: "pending",
        payload: boostPayload({ issueId: otherIssueId, agentId, bossReview: buildBossReviewStamp({ id: bossId, name: "Engineering Lead" }) }),
      });

      const movedOn = await grants.sweepBossReviewTimeouts(new Date());
      expect(movedOn).toEqual([staleApproval.id]);

      const [staleRow] = await db.select().from(approvals).where(eq(approvals.id, staleApproval.id));
      expect(staleRow?.status).toBe("pending");
      expect((staleRow?.payload.bossReview as Record<string, unknown>).status).toBe("timed_out");
      const [freshRow] = await db.select().from(approvals).where(eq(approvals.id, freshApproval.id));
      expect((freshRow?.payload.bossReview as Record<string, unknown>).status).toBe("awaiting_boss");

      // Once timed out, a late boss answer is refused too.
      await expect(
        grants.recordBossDecision({ approvalId: staleApproval.id, bossAgentId: bossId, decision: "decline" }),
      ).rejects.toThrow(/no longer waiting on the boss/i);
    });

    it("still creates the grant when the operator approves a forwarded ask, capped and time-boxed as asked", async () => {
      const { companyId, agentId, issueId } = await seed();
      const bossId = await seedBoss(companyId, { name: "Engineering Lead" });
      const payload = boostPayload({
        issueId,
        agentId,
        maxSpendCents: 2000,
        durationMinutes: 240,
        bossReview: { ...buildBossReviewStamp({ id: bossId, name: "Engineering Lead" }), status: "forwarded" },
      });
      const approval = await insertApproval({ companyId, requestedByAgentId: agentId, status: "approved", payload });

      const grant = await grants.createFromApproval({ companyId, approvalId: approval.id, payload });
      expect(grant.maxSpendCents).toBe(2000);
      expect(grant.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 241 * 60_000);
      await expect(grants.resolveActiveGrantForDispatch({ companyId, agentId, issueId })).resolves.not.toBeNull();
    });
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
