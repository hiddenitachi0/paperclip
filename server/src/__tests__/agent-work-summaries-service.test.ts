import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWorkSummaries,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import {
  AGENT_WORK_SUMMARY_MAX_LENGTH,
  saveAgentWorkSummary,
  searchAgentWorkSummaries,
} from "../services/agent-work-summaries.ts";

/**
 * DUR-4197 work-history storage, against a real Postgres with every
 * migration applied:
 *   - one row per run, idempotent on a retried save for the same run
 *   - search is scoped to companyId + agentId only -- another agent or
 *     company never sees a row, even when both match on just one axis
 *   - the free-text filter and the result ordering (newest first)
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping agent work-summary service tests: ${support.reason ?? "unsupported environment"}`);
}

d("agent work-history summaries", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  vi.setConfig({ testTimeout: 60_000 });

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-work-summaries");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(agentWorkSummaries);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(name = "Work History") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "Builder") {
    const created = await agentService(db).create(companyId, {
      name,
      role: "general",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    return created.id;
  }

  async function seedRun(companyId: string, agentId: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
    });
    return id;
  }

  it("saves a summary scoped to the company and agent", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedRun(companyId, agentId);

    const row = await saveAgentWorkSummary(db, {
      companyId,
      agentId,
      issueId: null,
      runId,
      summary: "Fixed the login redirect loop and added a regression test.",
    });

    expect(row).toMatchObject({
      companyId,
      agentId,
      runId,
      summary: "Fixed the login redirect loop and added a regression test.",
    });
  });

  it("is idempotent on runId: a retried save for the same run does not duplicate", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedRun(companyId, agentId);

    await saveAgentWorkSummary(db, { companyId, agentId, issueId: null, runId, summary: "First attempt." });
    const second = await saveAgentWorkSummary(db, { companyId, agentId, issueId: null, runId, summary: "Retried finalize." });

    expect(second).toBeNull();
    const rows = await searchAgentWorkSummaries(db, { companyId, agentId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe("First attempt.");
  });

  it("truncates an over-long summary instead of failing the check constraint", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedRun(companyId, agentId);

    const row = await saveAgentWorkSummary(db, {
      companyId,
      agentId,
      issueId: null,
      runId,
      summary: "x".repeat(AGENT_WORK_SUMMARY_MAX_LENGTH + 500),
    });

    expect(row?.summary.length).toBe(AGENT_WORK_SUMMARY_MAX_LENGTH);
  });

  it("never returns another agent's or another company's summaries", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const agentA1 = await seedAgent(companyA, "Agent A1");
    const agentA2 = await seedAgent(companyA, "Agent A2");
    const agentB1 = await seedAgent(companyB, "Agent B1");

    await saveAgentWorkSummary(db, {
      companyId: companyA,
      agentId: agentA1,
      issueId: null,
      runId: await seedRun(companyA, agentA1),
      summary: "A1 did the thing.",
    });
    await saveAgentWorkSummary(db, {
      companyId: companyA,
      agentId: agentA2,
      issueId: null,
      runId: await seedRun(companyA, agentA2),
      summary: "A2 did another thing.",
    });
    await saveAgentWorkSummary(db, {
      companyId: companyB,
      agentId: agentB1,
      issueId: null,
      runId: await seedRun(companyB, agentB1),
      summary: "B1 did a third thing.",
    });

    const a1Results = await searchAgentWorkSummaries(db, { companyId: companyA, agentId: agentA1 });
    expect(a1Results).toHaveLength(1);
    expect(a1Results[0]!.summary).toBe("A1 did the thing.");
  });

  it("filters by free text and orders newest first", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    await saveAgentWorkSummary(db, {
      companyId,
      agentId,
      issueId: null,
      runId: await seedRun(companyId, agentId),
      summary: "Investigated the checkout timeout.",
    });
    await saveAgentWorkSummary(db, {
      companyId,
      agentId,
      issueId: null,
      runId: await seedRun(companyId, agentId),
      summary: "Refactored the pricing service.",
    });

    const filtered = await searchAgentWorkSummaries(db, { companyId, agentId, query: "checkout" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.summary).toContain("checkout");

    const all = await searchAgentWorkSummaries(db, { companyId, agentId });
    expect(all).toHaveLength(2);
    expect(all[0]!.summary).toContain("pricing");
  });
});
