import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  goals,
  instanceSettings,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { AGENT_BOARD_DECISION_CLAIM_ACTION, detectBoardDecisionClaim } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { approvalService } from "../services/approvals.js";
import { flagAgentBoardDecisionClaim } from "../services/board-decision-claims.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// NOR-1437: the CEO agent filed confirmation card 639b05be with key
// `confirmation:de50a800:approval:fa9e5228` about pending deploy approval
// fa9e5228, never set linkedApprovalId, and the card stayed pending after the
// operator rejected the approval.
describeEmbeddedPostgres("confirmation cards that name a board approval", () => {
  let db!: ReturnType<typeof createDb>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-confirmation-approval-refs-");
    db = createDb(tempDb.connectionString);
    interactionsSvc = issueThreadInteractionService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Nordstrand") {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({ id: goalId, companyId, title: "Ship", level: "task", status: "active" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Deploy the product page",
      status: "in_progress",
      priority: "medium",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, issueId, agentId };
  }

  async function insertApproval(values: {
    companyId: string;
    id?: string;
    type?: string;
    status?: string;
    payload?: Record<string, unknown>;
    decisionNote?: string | null;
  }) {
    const decided = values.status === "approved" || values.status === "rejected" || values.status === "cancelled";
    const [row] = await db.insert(approvals).values({
      ...(values.id ? { id: values.id } : {}),
      companyId: values.companyId,
      type: values.type ?? "request_board_approval",
      status: values.status ?? "pending",
      payload: values.payload ?? { kind: "deploy", title: "product page" },
      decisionNote: values.decisionNote ?? null,
      decidedAt: decided ? new Date("2026-09-15T10:00:00Z") : null,
      decidedByUserId: decided ? "board" : null,
    }).returning();
    return row!;
  }

  function confirmation(overrides: Record<string, unknown> = {}) {
    return {
      kind: "request_confirmation" as const,
      payload: { version: 1 as const, prompt: "Vil du godkjenne denne deployen?" },
      ...overrides,
    } as Parameters<typeof interactionsSvc.create>[1];
  }

  async function expectConflict(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      expect((error as { status?: number }).status).toBe(409);
      return error as Error & { details?: Record<string, unknown> };
    }
    throw new Error("expected the create to be refused with 409");
  }

  async function pendingCount(issueId: string) {
    const rows = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    return rows.length;
  }

  it("refuses an agent card about a pending deploy approval named only by its 8-char prefix in the key", async () => {
    const { companyId, issueId, agentId } = await seedCompany();
    const approval = await insertApproval({ companyId });
    const shortId = approval.id.slice(0, 8);

    const error = await expectConflict(interactionsSvc.create({ id: issueId, companyId }, confirmation({
      idempotencyKey: `confirmation:de50a800:approval:${shortId}`,
    }), { agentId, userId: null }));

    expect(error.message).toContain("already covers this decision");
    expect(error.message).toContain("do not ask again");
    expect(error.details).toMatchObject({ code: "confirmation_duplicates_approval_card", approvalId: approval.id });
    expect(await pendingCount(issueId)).toBe(0);
  });

  it("refuses an agent card that carries a pending deploy approval's full id in its payload", async () => {
    const { companyId, issueId, agentId } = await seedCompany();
    const approval = await insertApproval({ companyId });

    await expectConflict(interactionsSvc.create({ id: issueId, companyId }, confirmation({
      payload: {
        version: 1,
        prompt: "Approve the deploy?",
        detailsMarkdown: `Deploy approval ${approval.id} is ready.`,
      },
    }), { agentId, userId: null }));
    expect(await pendingCount(issueId)).toBe(0);
  });

  it("refuses the same for a pending merge approval named through an explicit linkedApprovalId", async () => {
    const { companyId, issueId, agentId } = await seedCompany();
    const approval = await insertApproval({ companyId, payload: { kind: "merge_pr", title: "ship it" } });

    await expectConflict(interactionsSvc.create({ id: issueId, companyId }, confirmation({
      linkedApprovalId: approval.id,
    }), { agentId, userId: null }));
  });

  // Not linked automatically: answering a linked card decides the approval
  // without the approval's own steps (a budget override would not raise the
  // budget), so a card that only names a waiting approval is refused.
  it("refuses an agent card that names a waiting non-deploy approval only in its key, instead of linking it", async () => {
    const { companyId, issueId, agentId } = await seedCompany();
    const approval = await insertApproval({
      companyId,
      type: "approve_ceo_strategy",
      payload: { plan: "Q4 strategy" },
    });

    const error = await expectConflict(interactionsSvc.create({ id: issueId, companyId }, confirmation({
      idempotencyKey: `strategy:approval:${approval.id.slice(0, 8)}`,
    }), { agentId, userId: null }));

    expect(error.details).toMatchObject({ code: "confirmation_duplicates_approval_card", approvalId: approval.id });
    expect(await pendingCount(issueId)).toBe(0);
  });

  it("still accepts an explicit linkedApprovalId to a waiting non-deploy approval, as DUR-29 always did", async () => {
    const { companyId, issueId, agentId } = await seedCompany();
    const approval = await insertApproval({
      companyId,
      type: "approve_ceo_strategy",
      payload: { plan: "Q4 strategy" },
    });

    const created = await interactionsSvc.create({ id: issueId, companyId }, confirmation({
      linkedApprovalId: approval.id,
    }), { agentId, userId: null });
    expect(created.linkedApprovalId).toBe(approval.id);

    // DUR-29 then applies: deciding the approval resolves the card.
    await approvalService(db).approve(approval.id, "board", "go");
    const resolved = await interactionsSvc.resolveInteractionsLinkedToApproval(
      { id: approval.id, companyId, status: "approved" },
      { userId: "board" },
    );
    expect(resolved.map((row) => row.id)).toEqual([created.id]);
  });

  it("refuses an agent card about an approval that was already decided, and says what the decision was", async () => {
    const { companyId, issueId, agentId } = await seedCompany();
    const approval = await insertApproval({
      companyId,
      type: "approve_ceo_strategy",
      status: "rejected",
      payload: { plan: "Q4" },
      decisionNote: "Not this quarter",
    });

    const error = await expectConflict(interactionsSvc.create({ id: issueId, companyId }, confirmation({
      idempotencyKey: `confirmation:approval:${approval.id}`,
    }), { agentId, userId: null }));
    expect(error.message).toContain("already rejected");
    expect(error.message).toContain("Not this quarter");
    expect(error.details).toMatchObject({ code: "confirmation_names_decided_approval", approvalStatus: "rejected" });
  });

  it("takes no action on a card that names no approval, even when its issue has a pending deploy approval", async () => {
    const { companyId, issueId, agentId } = await seedCompany();
    await insertApproval({ companyId });

    const created = await interactionsSvc.create({ id: issueId, companyId }, confirmation({
      idempotencyKey: "confirmation:copy-review",
      payload: { version: 1, prompt: "Is the new product copy OK to use?" },
    }), { agentId, userId: null });
    expect(created.status).toBe("pending");
    expect(created.linkedApprovalId ?? null).toBeNull();
  });

  it("takes no action when the 8-char prefix matches two approvals in the company", async () => {
    const { companyId, issueId, agentId } = await seedCompany();
    await insertApproval({ companyId, id: "fa9e5228-0000-4000-8000-000000000001" });
    await insertApproval({ companyId, id: "fa9e5228-0000-4000-8000-000000000002" });

    const created = await interactionsSvc.create({ id: issueId, companyId }, confirmation({
      idempotencyKey: "confirmation:de50a800:approval:fa9e5228",
    }), { agentId, userId: null });
    expect(created.status).toBe("pending");
    expect(created.linkedApprovalId ?? null).toBeNull();
  });

  it("takes no action when the prefix or full id only matches another company's approval", async () => {
    const { companyId, issueId, agentId } = await seedCompany();
    const other = await seedCompany("Other Co");
    const foreign = await insertApproval({ companyId: other.companyId });

    const created = await interactionsSvc.create({ id: issueId, companyId }, confirmation({
      idempotencyKey: `confirmation:approval:${foreign.id.slice(0, 8)}`,
      payload: { version: 1, prompt: "Ship it?", detailsMarkdown: `See ${foreign.id}` },
    }), { agentId, userId: null });
    expect(created.status).toBe("pending");
    expect(created.linkedApprovalId ?? null).toBeNull();
  });

  it("leaves board-user creates alone", async () => {
    const { companyId, issueId } = await seedCompany();
    const approval = await insertApproval({ companyId });

    const created = await interactionsSvc.create({ id: issueId, companyId }, confirmation({
      idempotencyKey: `confirmation:approval:${approval.id.slice(0, 8)}`,
    }), { userId: "local-board" });
    expect(created.status).toBe("pending");
    expect(created.linkedApprovalId ?? null).toBeNull();
  });

  it("deciding an approval resolves a pending unlinked card named only in its key, and nothing else", async () => {
    const { companyId, issueId, agentId } = await seedCompany();
    const approval = await insertApproval({ companyId });
    const unrelated = await insertApproval({ companyId, payload: { kind: "deploy", title: "other" } });

    // Cards filed before the guard existed: inserted directly, never linked.
    const [named] = await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "none",
      idempotencyKey: `confirmation:de50a800:approval:${approval.id.slice(0, 8)}`,
      createdByAgentId: agentId,
      payload: { version: 1, prompt: "Vil du godkjenne denne deployen?" },
    }).returning();
    const [other] = await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "none",
      idempotencyKey: `confirmation:approval:${unrelated.id.slice(0, 8)}`,
      createdByAgentId: agentId,
      payload: { version: 1, prompt: "And this one?" },
    }).returning();

    // The operator sees it as waiting on the approval before the decision.
    const listed = await interactionsSvc.listForIssue(issueId);
    expect(listed.find((row) => row.id === named!.id)?.namedApproval).toMatchObject({
      approvalId: approval.id,
      status: "pending",
      linked: false,
    });

    await approvalService(db).reject(approval.id, "board", "no");
    const resolved = await interactionsSvc.resolveInteractionsLinkedToApproval(
      { id: approval.id, companyId, status: "rejected" },
      { userId: "board" },
    );

    expect(resolved.map((row) => row.id)).toEqual([named!.id]);
    const [namedAfter] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, named!.id));
    expect(namedAfter).toMatchObject({ status: "rejected", result: { version: 1, outcome: "rejected" } });
    const [otherAfter] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, other!.id));
    expect(otherAfter?.status).toBe("pending");
  });

  it("shows a pending card whose approval was decided elsewhere as out of date in the list", async () => {
    const { companyId, issueId, agentId } = await seedCompany();
    const approval = await insertApproval({ companyId, status: "approved" });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_checkbox_confirmation",
      status: "pending",
      continuationPolicy: "none",
      idempotencyKey: `confirmation:approval:${approval.id}`,
      createdByAgentId: agentId,
      payload: { version: 1, prompt: "Pick", options: [{ id: "a", label: "A" }] },
    });

    const [pending] = await interactionsSvc.listPendingForCompany(companyId);
    expect(pending?.namedApproval).toMatchObject({ approvalId: approval.id, status: "approved" });
  });

  describe("agent comments that claim a board decision", () => {
    it("recognises decision claims and leaves ordinary mentions alone", () => {
      expect(detectBoardDecisionClaim("## Board Decision: APPROVED\n\nDeploying now.")).toMatchObject({ outcome: "approved" });
      expect(detectBoardDecisionClaim("**Board decision:** rejected")).toMatchObject({ outcome: "rejected" });
      expect(detectBoardDecisionClaim("## Styrevedtak\n\nGodkjent.")).toMatchObject({ outcome: "approved" });
      expect(detectBoardDecisionClaim("Styrevedtak: avvist")).toMatchObject({ outcome: "rejected" });
      expect(detectBoardDecisionClaim("- Board Decision (DUR-29) — APPROVED")).toMatchObject({ outcome: "approved" });

      expect(detectBoardDecisionClaim("Waiting for the board decision before deploying.")).toBeNull();
      expect(detectBoardDecisionClaim("Board decision: pending")).toBeNull();
      expect(detectBoardDecisionClaim("## Board decision needed\nApproved changes are listed below.")).toBeNull();
      expect(detectBoardDecisionClaim("Board decision: approved or rejected, your call.")).toBeNull();
      expect(detectBoardDecisionClaim("Venter på styrevedtak.")).toBeNull();
      expect(detectBoardDecisionClaim("```\nBoard Decision: APPROVED\n```")).toBeNull();
    });

    async function flagRows(companyId: string) {
      return db.select().from(activityLog).where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, AGENT_BOARD_DECISION_CLAIM_ACTION),
      ));
    }

    it("records one activity row for an agent comment that claims a decision, and none otherwise", async () => {
      const { companyId, issueId, agentId } = await seedCompany();
      const base = { companyId, issueId, issueIdentifier: "NOR-1437", actorType: "agent", agentId, runId: null };

      expect(await flagAgentBoardDecisionClaim(db, {
        ...base,
        commentId: randomUUID(),
        body: "## Board Decision: APPROVED\n\nThe deploy may proceed.",
      })).toBe(true);
      expect(await flagAgentBoardDecisionClaim(db, {
        ...base,
        commentId: randomUUID(),
        body: "Still waiting for the board decision on the deploy.",
      })).toBe(false);
      // The operator writing it is not a claim by an agent.
      expect(await flagAgentBoardDecisionClaim(db, {
        ...base,
        actorType: "user",
        agentId: null,
        commentId: randomUUID(),
        body: "## Board Decision: APPROVED",
      })).toBe(false);

      const rows = await flagRows(companyId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entityType: "issue",
        entityId: issueId,
        agentId,
        details: { claimedOutcome: "approved", identifier: "NOR-1437" },
      });
    });
  });
});
