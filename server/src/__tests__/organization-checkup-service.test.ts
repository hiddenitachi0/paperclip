import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  authUsers,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  inboxDismissals,
  instanceClaudeAuth,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CHECKUP_FINDING_DISMISSAL_PREFIX,
  CHECKUP_SECTION_HEADINGS,
  CHECKUP_SEVERITIES,
  DEFAULT_CHECKUP_THRESHOLDS,
  ORGANIZATION_CHECKUP_ORIGIN_KIND,
  checkupFingerprintForWeek,
  formatCents,
  humanizeMachineText,
  organizationCheckupService,
} from "../services/organization-checkup.ts";
import { productivityReviewService } from "../services/productivity-review.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres organization check-up tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date("2026-09-07T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysBefore = (days: number, from = NOW) => new Date(from.getTime() - days * DAY_MS);
const hoursBefore = (hours: number, from = NOW) => new Date(from.getTime() - hours * 60 * 60 * 1000);

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SNAKE_CASE_PATTERN = /\b[a-z0-9]+_[a-z0-9_]+\b/;

describe("organization check-up helpers", () => {
  it("formats money as dollars and cents", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(1234)).toBe("$12.34");
    expect(formatCents(Number.NaN)).toBe("$0.00");
  });

  it("strips identifiers and underscores from machine text", () => {
    const text = humanizeMachineText("workspace_validation failed for 11111111-1111-4111-8111-111111111111 `agent`");
    expect(text).not.toMatch(UUID_PATTERN);
    expect(text).not.toMatch(SNAKE_CASE_PATTERN);
    expect(text).toContain("workspace validation failed");
  });

  it("keys the report fingerprint on the ISO week", () => {
    expect(checkupFingerprintForWeek(new Date("2026-09-07T12:00:00.000Z"))).toBe("checkup:2026-W37");
    expect(checkupFingerprintForWeek(new Date("2026-09-13T23:00:00.000Z"))).toBe("checkup:2026-W37");
    expect(checkupFingerprintForWeek(new Date("2026-09-14T01:00:00.000Z"))).toBe("checkup:2026-W38");
    expect(checkupFingerprintForWeek(new Date("2027-01-01T12:00:00.000Z"))).toBe("checkup:2026-W53");
  });
});

describeEmbeddedPostgres("organization check-up service", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-organization-checkup-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    await db.execute(sql.raw(`TRUNCATE TABLE "user" CASCADE`));
    await db.delete(instanceClaudeAuth);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Seeded = {
    companyId: string;
    issuePrefix: string;
    ceoId: string;
    ctoId: string;
    workerId: string;
    nextIssueNumber: () => number;
  };

  async function seedCompany(opts?: { name?: string; budgetMonthlyCents?: number; spentMonthlyCents?: number; status?: string }): Promise<Seeded> {
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const ctoId = randomUUID();
    const workerId = randomUUID();
    const issuePrefix = `CK${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const createdAt = daysBefore(30);

    await db.insert(companies).values({
      id: companyId,
      name: opts?.name ?? "Durkan Test Co",
      status: opts?.status ?? "active",
      issuePrefix,
      budgetMonthlyCents: opts?.budgetMonthlyCents ?? 0,
      spentMonthlyCents: opts?.spentMonthlyCents ?? 0,
      requireBoardApprovalForNewAgents: false,
      createdAt,
      updatedAt: createdAt,
    });
    const base = {
      companyId,
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt,
      updatedAt: createdAt,
    };
    await db.insert(agents).values([
      { ...base, id: ceoId, name: "Chief", role: "ceo" },
      { ...base, id: ctoId, name: "Tech Lead", role: "cto", reportsTo: ceoId },
      { ...base, id: workerId, name: "Builder", role: "engineer", reportsTo: ctoId },
    ]);

    let counter = 100;
    return { companyId, issuePrefix, ceoId, ctoId, workerId, nextIssueNumber: () => (counter += 1) };
  }

  async function insertIssue(seeded: Seeded, opts: {
    title?: string;
    status?: string;
    assigneeAgentId?: string | null;
    updatedAt?: Date;
    executionRunId?: string | null;
    originKind?: string;
  } = {}) {
    const id = randomUUID();
    const number = seeded.nextIssueNumber();
    const updatedAt = opts.updatedAt ?? NOW;
    await db.insert(issues).values({
      id,
      companyId: seeded.companyId,
      title: opts.title ?? `Task ${number}`,
      status: opts.status ?? "todo",
      priority: "medium",
      assigneeAgentId: opts.assigneeAgentId ?? null,
      executionRunId: opts.executionRunId ?? null,
      originKind: opts.originKind ?? "manual",
      issueNumber: number,
      identifier: `${seeded.issuePrefix}-${number}`,
      createdAt: daysBefore(1, updatedAt),
      updatedAt,
    });
    return { id, identifier: `${seeded.issuePrefix}-${number}` };
  }

  async function insertRun(seeded: Seeded, opts: {
    agentId: string;
    status: string;
    createdAt?: Date;
    error?: string | null;
    costCents?: number;
  }) {
    const id = randomUUID();
    const createdAt = opts.createdAt ?? hoursBefore(2);
    await db.insert(heartbeatRuns).values({
      id,
      companyId: seeded.companyId,
      agentId: opts.agentId,
      status: opts.status,
      invocationSource: "timer",
      startedAt: createdAt,
      finishedAt: new Date(createdAt.getTime() + 60_000),
      error: opts.error ?? null,
      createdAt,
      updatedAt: createdAt,
    });
    if (opts.costCents !== undefined) {
      await insertCost(seeded, { agentId: opts.agentId, costCents: opts.costCents, heartbeatRunId: id, occurredAt: createdAt });
    }
    return id;
  }

  async function insertCost(seeded: Seeded, opts: { agentId: string; costCents: number; heartbeatRunId?: string | null; occurredAt?: Date }) {
    await db.insert(costEvents).values({
      companyId: seeded.companyId,
      agentId: opts.agentId,
      heartbeatRunId: opts.heartbeatRunId ?? null,
      provider: "anthropic",
      model: "test-model",
      costCents: opts.costCents,
      occurredAt: opts.occurredAt ?? hoursBefore(3),
    });
  }

  async function listReports(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, ORGANIZATION_CHECKUP_ORIGIN_KIND)))
      .orderBy(issues.createdAt);
  }

  async function listInteractions(issueId: string) {
    return db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
  }

  function findingsByKind(findings: Array<{ fingerprint: string }>, kind: string) {
    return findings.filter((finding) => finding.fingerprint === kind || finding.fingerprint.startsWith(`${kind}:`));
  }

  it("reports an agent stuck in error with the tasks stranded behind it, and hands the fix to its manager", async () => {
    const seeded = await seedCompany();
    await db
      .update(agents)
      .set({ status: "error", errorReason: "Project workspace must belong to same company", errorAt: hoursBefore(5) })
      .where(eq(agents.id, seeded.workerId));
    await insertIssue(seeded, { status: "todo", assigneeAgentId: seeded.workerId });
    await insertIssue(seeded, { status: "blocked", assigneeAgentId: seeded.workerId });
    await insertIssue(seeded, { status: "done", assigneeAgentId: seeded.workerId });

    const service = organizationCheckupService(db);
    const result = await service.runCheckup({ companyId: seeded.companyId, now: NOW });

    const [finding, ...rest] = findingsByKind(result.findings, "agent_error");
    expect(rest).toHaveLength(0);
    expect(finding?.severity).toBe("stuck");
    expect(finding?.headline).toBe("Builder has stopped with an error and 2 tasks are waiting on it.");
    expect(finding?.evidenceJson).toMatchObject({ agentId: seeded.workerId, strandedOpenIssues: 2 });
    expect(finding?.evidence.join("\n")).toContain("Project workspace must belong to same company");

    const [interaction] = await listInteractions(result.reportIssueId!);
    const draft = (interaction?.payload as { tasks: Array<{ clientKey: string; assigneeAgentId: string | null }> }).tasks
      .find((task) => task.clientKey === finding!.fingerprint);
    expect(draft?.assigneeAgentId).toBe(seeded.ctoId);
  });

  it("falls back to the CTO, then CEO, and skips paused managers when picking who gets a suggestion", async () => {
    const seeded = await seedCompany();
    const service = organizationCheckupService(db);

    expect(await service.resolveAdviceOwnerAgentId(seeded.companyId, seeded.workerId)).toBe(seeded.ctoId);
    expect(await service.resolveAdviceOwnerAgentId(seeded.companyId, null)).toBe(seeded.ctoId);

    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, seeded.ctoId));
    expect(await service.resolveAdviceOwnerAgentId(seeded.companyId, seeded.workerId)).toBe(seeded.ceoId);

    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, seeded.ceoId));
    expect(await service.resolveAdviceOwnerAgentId(seeded.companyId, seeded.workerId)).toBeNull();
  });

  it("reports repeated run failures with the money they cost, and stays quiet when most runs succeed", async () => {
    const seeded = await seedCompany();
    for (let index = 0; index < 4; index += 1) {
      await insertRun(seeded, { agentId: seeded.workerId, status: index === 0 ? "timed_out" : "failed", error: "adapter_exit_code 137", costCents: 125, createdAt: hoursBefore(index + 1) });
    }
    await insertRun(seeded, { agentId: seeded.workerId, status: "succeeded", costCents: 50 });
    // Mostly-successful agent: 3 failures but 10 successes. Not reported.
    for (let index = 0; index < 3; index += 1) await insertRun(seeded, { agentId: seeded.ctoId, status: "failed" });
    for (let index = 0; index < 10; index += 1) await insertRun(seeded, { agentId: seeded.ctoId, status: "succeeded" });
    // Old failures outside the window do not count.
    for (let index = 0; index < 5; index += 1) await insertRun(seeded, { agentId: seeded.ceoId, status: "failed", createdAt: daysBefore(12) });

    const result = await organizationCheckupService(db).runCheckup({ companyId: seeded.companyId, now: NOW, dryRun: true });
    const failures = findingsByKind(result.findings, "repeated_failures");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.severity).toBe("money");
    expect(failures[0]?.evidenceJson).toMatchObject({ agentId: seeded.workerId, failedRuns: 4, succeededRuns: 1, wastedCents: 500 });
    expect(failures[0]?.headline).toBe("Builder had 4 runs fail or get cut off in the last 7 days, out of 5.");
    expect(failures[0]?.evidence[0]).toBe("Those failed runs cost $5.00 and produced nothing.");
    expect(failures[0]?.evidence[1]).toContain("adapter exit code 137");
  });

  it("reports tasks marked in progress with nobody on them separately from tasks that simply stopped moving", async () => {
    const seeded = await seedCompany();
    const liveRunId = await insertRun(seeded, { agentId: seeded.workerId, status: "running" });
    // Honest in-progress: has a run behind it.
    await insertIssue(seeded, { status: "in_progress", assigneeAgentId: seeded.workerId, executionRunId: liveRunId, updatedAt: hoursBefore(20) });
    // Lying in-progress: no run, untouched for 13 hours (the DUR-58 case).
    const lying = await insertIssue(seeded, { title: "Ship the import", status: "in_progress", assigneeAgentId: seeded.workerId, updatedAt: hoursBefore(13) });
    // Fresh in-progress without a run: inside the grace hour, not reported.
    await insertIssue(seeded, { status: "in_progress", assigneeAgentId: seeded.workerId, updatedAt: new Date(NOW.getTime() - 20 * 60_000) });
    // Stuck for 9 days in todo, and blocked for 6 days.
    const stale = await insertIssue(seeded, { title: "Write the brochure", status: "todo", updatedAt: daysBefore(9) });
    await insertIssue(seeded, { status: "blocked", assigneeAgentId: seeded.ctoId, updatedAt: daysBefore(6) });
    // Recently touched, parked in backlog, and closed: none reported.
    await insertIssue(seeded, { status: "todo", updatedAt: daysBefore(2) });
    await insertIssue(seeded, { status: "backlog", updatedAt: daysBefore(40) });
    await insertIssue(seeded, { status: "done", updatedAt: daysBefore(40) });

    const result = await organizationCheckupService(db).runCheckup({ companyId: seeded.companyId, now: NOW, dryRun: true });

    const [noRun] = findingsByKind(result.findings, "in_progress_without_run");
    expect(noRun?.headline).toBe("1 task says someone is working on it, and nobody is.");
    expect(noRun?.evidenceJson).toEqual({ count: 1, issueIds: [lying.id] });
    expect(noRun?.evidence.join("\n")).toContain(`${lying.identifier} "Ship the import", assigned to Builder, untouched for 13 hours.`);

    const [stuck] = findingsByKind(result.findings, "stuck_issues");
    expect(stuck?.headline).toBe("2 open tasks have not moved in more than 5 days.");
    expect(stuck?.evidenceJson).toMatchObject({ count: 2, issueIds: expect.arrayContaining([stale.id]) });
    expect((stuck?.evidenceJson.issueIds as string[])).not.toContain(lying.id);
    expect(stuck?.evidence[0]).toBe(`${stale.identifier} "Write the brochure" has been "todo" with nobody assigned and untouched for 9 days.`);
  });

  it("reports an agent with work and no successful run in seven days, but not an idle agent with nothing to do", async () => {
    const seeded = await seedCompany();
    // Builder has an open task and only failed runs -> silent.
    await insertIssue(seeded, { status: "todo", assigneeAgentId: seeded.workerId });
    await insertRun(seeded, { agentId: seeded.workerId, status: "failed", createdAt: daysBefore(2) });
    await insertRun(seeded, { agentId: seeded.workerId, status: "succeeded", createdAt: daysBefore(9) });
    // Tech Lead has a timer and no runs at all -> silent.
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600 } } }).where(eq(agents.id, seeded.ctoId));
    // Chief has no work and no timer -> just idle, not reported.
    // A brand-new agent is never reported: it has not had seven days yet.
    await db.insert(agents).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      name: "Newcomer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true } },
      permissions: {},
      createdAt: daysBefore(2),
      updatedAt: daysBefore(2),
    });

    const result = await organizationCheckupService(db).runCheckup({ companyId: seeded.companyId, now: NOW, dryRun: true });
    const silent = findingsByKind(result.findings, "silent_agent");
    expect(silent.map((finding) => finding.evidenceJson.agentId).sort()).toEqual([seeded.ctoId, seeded.workerId].sort());
    const builder = silent.find((finding) => finding.evidenceJson.agentId === seeded.workerId);
    expect(builder?.headline).toBe("Builder has not finished a single run successfully in the last 7 days.");
    expect(builder?.evidenceJson).toMatchObject({ attemptedRuns: 1, openIssues: 1, timerEnabled: false });
    expect(builder?.suggestedTask.priority).toBe("high");
    const lead = silent.find((finding) => finding.evidenceJson.agentId === seeded.ctoId);
    expect(lead?.evidence[0]).toBe("It has not run at all in that time.");
    expect(lead?.suggestedTask.priority).toBe("low");

    // Once Builder succeeds, it is no longer silent.
    await insertRun(seeded, { agentId: seeded.workerId, status: "succeeded", createdAt: daysBefore(1) });
    const again = await organizationCheckupService(db).runCheckup({ companyId: seeded.companyId, now: NOW, dryRun: true });
    expect(findingsByKind(again.findings, "silent_agent").map((finding) => finding.evidenceJson.agentId)).toEqual([seeded.ctoId]);
  });

  it("reports spend that stands out and budgets that are nearly used up", async () => {
    const seeded = await seedCompany({ budgetMonthlyCents: 10_000, spentMonthlyCents: 8_500 });
    const fourth = randomUUID();
    await db.insert(agents).values({
      id: fourth,
      companyId: seeded.companyId,
      name: "Writer",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      budgetMonthlyCents: 2_000,
      spentMonthlyCents: 2_100,
      createdAt: daysBefore(30),
      updatedAt: daysBefore(30),
    });
    await insertCost(seeded, { agentId: seeded.ceoId, costCents: 300 });
    await insertCost(seeded, { agentId: seeded.ctoId, costCents: 400 });
    await insertCost(seeded, { agentId: fourth, costCents: 500 });
    await insertCost(seeded, { agentId: seeded.workerId, costCents: 4_000 });
    // Spend outside the window is ignored.
    await insertCost(seeded, { agentId: seeded.ceoId, costCents: 90_000, occurredAt: daysBefore(20) });

    const result = await organizationCheckupService(db).runCheckup({ companyId: seeded.companyId, now: NOW, dryRun: true });

    const outliers = findingsByKind(result.findings, "spend_outlier");
    expect(outliers).toHaveLength(1);
    expect(outliers[0]?.evidenceJson).toEqual({ agentId: seeded.workerId, spendCents: 4_000, medianCents: 450, multiple: 8.9 });
    expect(outliers[0]?.headline).toBe("Builder spent $40.00 in the last 7 days, about 8.9 times what a typical agent here spends.");

    const budgets = findingsByKind(result.findings, "budget_nearly_used");
    expect(budgets).toHaveLength(1);
    expect(budgets[0]?.severity).toBe("money");
    expect(budgets[0]?.headline).toBe("Writer has used all of its monthly budget ($21.00 of $20.00).");

    const [company] = findingsByKind(result.findings, "company_budget_nearly_used");
    expect(company?.severity).toBe("risk");
    expect(company?.headline).toBe("The company has used 85% of its monthly budget ($85.00 of $100.00).");
  });

  it("reports approvals and questions that have waited on the operator for more than three days", async () => {
    const seeded = await seedCompany();
    await db.insert(approvals).values([
      { companyId: seeded.companyId, type: "hire_agent", status: "pending", requestedByAgentId: seeded.ceoId, payload: { title: "Hire a second writer" }, createdAt: daysBefore(5), updatedAt: daysBefore(5) },
      { companyId: seeded.companyId, type: "deploy", status: "revision_requested", payload: {}, createdAt: daysBefore(4), updatedAt: daysBefore(4) },
      { companyId: seeded.companyId, type: "deploy", status: "pending", payload: { title: "Fresh one" }, createdAt: daysBefore(1), updatedAt: daysBefore(1) },
      { companyId: seeded.companyId, type: "deploy", status: "approved", payload: { title: "Decided" }, createdAt: daysBefore(10), updatedAt: daysBefore(10) },
    ]);
    const openIssue = await insertIssue(seeded, { title: "Pick a logo", status: "blocked", assigneeAgentId: seeded.workerId });
    const closedIssue = await insertIssue(seeded, { status: "done" });
    await db.insert(issueThreadInteractions).values([
      { companyId: seeded.companyId, issueId: openIssue.id, kind: "ask_user_questions", status: "pending", title: "Which logo do you prefer?", createdByAgentId: seeded.workerId, payload: { version: 1, questions: [] }, createdAt: daysBefore(6), updatedAt: daysBefore(6) },
      { companyId: seeded.companyId, issueId: openIssue.id, kind: "request_confirmation", status: "pending", payload: { version: 1 }, createdAt: daysBefore(4), updatedAt: daysBefore(4) },
      { companyId: seeded.companyId, issueId: openIssue.id, kind: "ask_user_questions", status: "pending", payload: { version: 1, questions: [] }, createdAt: daysBefore(1), updatedAt: daysBefore(1) },
      { companyId: seeded.companyId, issueId: openIssue.id, kind: "ask_user_questions", status: "answered", payload: { version: 1, questions: [] }, createdAt: daysBefore(9), updatedAt: daysBefore(9) },
      { companyId: seeded.companyId, issueId: openIssue.id, kind: "suggest_tasks", status: "pending", payload: { version: 1, tasks: [] }, createdAt: daysBefore(9), updatedAt: daysBefore(9) },
      { companyId: seeded.companyId, issueId: closedIssue.id, kind: "ask_user_questions", status: "pending", payload: { version: 1, questions: [] }, createdAt: daysBefore(9), updatedAt: daysBefore(9) },
    ]);

    const result = await organizationCheckupService(db).runCheckup({ companyId: seeded.companyId, now: NOW, dryRun: true });

    const [pending] = findingsByKind(result.findings, "pending_approvals");
    expect(pending?.headline).toBe("2 approvals have been waiting for you for more than 3 days.");
    expect(pending?.evidenceJson).toMatchObject({ count: 2 });
    expect(pending?.evidence[1]).toBe('"Hire a second writer" from Chief, waiting 5 days.');
    expect(pending?.evidence[2]).toBe('"deploy", waiting 4 days.');

    const [questions] = findingsByKind(result.findings, "unanswered_questions");
    expect(questions?.headline).toBe("2 questions were asked of you more than 3 days ago and never answered.");
    expect(questions?.evidenceJson).toMatchObject({ count: 2, issueCount: 1 });
    expect(questions?.evidence[1]).toBe(`Builder asked "Which logo do you prefer?" on ${openIssue.identifier} "Pick a logo", 6 days ago.`);
  });

  // Polish round 3: the shared Claude sign-in as a check-up finding.
  it("reports a shared Claude sign-in that is failing or about to expire, only where a Claude agent could depend on it", async () => {
    const seeded = await seedCompany();
    const codexOnly = await seedCompany({ name: "Codex Only Co" });
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, seeded.workerId));
    const insertSignIn = async (row: { expiresAt: Date; lastCheckOk: boolean | null; lastCheckMessage?: string | null; lastCheckAt?: Date | null }) => {
      await db.delete(instanceClaudeAuth);
      await db.insert(instanceClaudeAuth).values({
        tokenSealed: "instance-claude-auth:{}",
        fingerprintSha256: "f".repeat(64),
        source: "pasted",
        savedAt: daysBefore(300),
        expiresAt: row.expiresAt,
        lastCheckAt: row.lastCheckAt === undefined ? hoursBefore(20) : row.lastCheckAt,
        lastCheckOk: row.lastCheckOk,
        lastCheckMessage: row.lastCheckMessage ?? null,
      });
    };

    // Healthy and far from expiry: nothing to report.
    await insertSignIn({ expiresAt: daysBefore(-60), lastCheckOk: true });
    const healthy = await organizationCheckupService(db).runCheckup({ companyId: seeded.companyId, now: NOW, dryRun: true });
    expect(findingsByKind(healthy.findings, "claude_signin")).toHaveLength(0);

    // Two days from expiry: a "risk" finding that says when and where to fix it.
    await insertSignIn({ expiresAt: daysBefore(-2), lastCheckOk: true });
    const expiring = await organizationCheckupService(db).runCheckup({ companyId: seeded.companyId, now: NOW, dryRun: true });
    const [soon] = findingsByKind(expiring.findings, "claude_signin");
    expect(soon?.severity).toBe("risk");
    expect(soon?.headline).toBe("The shared Claude sign-in expires in about 2 days.");
    expect(soon?.evidence[0]).toBe("1 Claude agent in this company (Builder) uses the shared sign-in whenever it has no Claude token of its own.");
    expect(soon?.suggestion).toContain("Settings > Instance settings > Claude sign-in");
    expect(soon?.evidenceJson).toMatchObject({ health: "expiring_soon", expiresInDays: 2, claudeAgentIds: [seeded.workerId] });
    expect(soon?.subjectAgentId).toBeNull();
    expect(soon?.suggestedTask.priority).toBe("medium");

    // Failed check: a "stuck" finding carrying Claude's reason, without identifiers.
    await insertSignIn({ expiresAt: daysBefore(-60), lastCheckOk: false, lastCheckMessage: "Claude rejected this token (401 OAuth access token is invalid sk-ant-oat01-[redacted])." });
    const failing = await organizationCheckupService(db).runCheckup({ companyId: seeded.companyId, now: NOW, dryRun: true });
    const [failed] = findingsByKind(failing.findings, "claude_signin");
    expect(failed?.severity).toBe("stuck");
    expect(failed?.headline).toBe("The shared Claude sign-in failed its last check, so Claude agents without a token of their own may stop working.");
    expect(failed?.evidence[1]).toContain("Claude said:");
    expect(failed?.suggestedTask.priority).toBe("high");
    expect(failed?.suggestedTask.title).toBe("Renew the shared Claude sign-in");

    // A company with no Claude agents never hears about it.
    const unaffected = await organizationCheckupService(db).runCheckup({ companyId: codexOnly.companyId, now: NOW, dryRun: true });
    expect(findingsByKind(unaffected.findings, "claude_signin")).toHaveLength(0);
  });

  it("files one unassigned report with one accept card whose drafts match the findings, and writes only its own tables", async () => {
    const seeded = await seedCompany();
    await db.update(agents).set({ status: "error", errorReason: "boom", errorAt: hoursBefore(2) }).where(eq(agents.id, seeded.workerId));
    await insertIssue(seeded, { status: "todo", updatedAt: daysBefore(10) });
    await db.insert(approvals).values({ companyId: seeded.companyId, type: "deploy", status: "pending", payload: { title: "Ship it" }, createdAt: daysBefore(5), updatedAt: daysBefore(5) });

    const snapshot = async () => ({
      agents: await db.select({ id: agents.id, updatedAt: agents.updatedAt }).from(agents).where(eq(agents.companyId, seeded.companyId)).orderBy(agents.id),
      approvals: await db.select({ id: approvals.id, updatedAt: approvals.updatedAt }).from(approvals).where(eq(approvals.companyId, seeded.companyId)).orderBy(approvals.id),
      sourceIssues: await db.select({ id: issues.id, updatedAt: issues.updatedAt, status: issues.status }).from(issues).where(and(eq(issues.companyId, seeded.companyId), sql`${issues.originKind} <> ${ORGANIZATION_CHECKUP_ORIGIN_KIND}`)).orderBy(issues.id),
      wakeups: await db.select({ count: sql<number>`count(*)::int` }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, seeded.companyId)).then((rows) => Number(rows[0]?.count ?? 0)),
      runs: await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId)).then((rows) => Number(rows[0]?.count ?? 0)),
    });
    const before = await snapshot();

    const result = await organizationCheckupService(db).runCheckup({ companyId: seeded.companyId, now: NOW });

    expect(result.outcome).toBe("created");
    expect(result.writtenTables).toEqual(["activity_log", "issue_thread_interactions", "issues"]);
    expect(result.findings.length).toBeGreaterThanOrEqual(3);
    expect(await snapshot()).toEqual(before);

    const [report, ...others] = await listReports(seeded.companyId);
    expect(others).toHaveLength(0);
    expect(report).toMatchObject({
      id: result.reportIssueId,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      originKind: ORGANIZATION_CHECKUP_ORIGIN_KIND,
      originId: seeded.companyId,
      originFingerprint: "checkup:2026-W37",
    });
    expect(report?.title).toBe(`Weekly check-up for Durkan Test Co, 2026-09-07: ${result.findings.length} things to look at`);
    expect(report?.description).toBe(result.body);

    const interactions = await listInteractions(report!.id);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({ kind: "suggest_tasks", status: "pending", continuationPolicy: "none", createdByAgentId: null, createdByUserId: null });
    const drafts = (interactions[0]!.payload as { tasks: Array<{ clientKey: string; title: string }> }).tasks;
    expect(drafts.map((task) => task.clientKey)).toEqual(result.findings.map((finding) => finding.fingerprint));
    expect(drafts.every((task) => task.title.length > 0)).toBe(true);

    const activity = await db.select().from(activityLog).where(and(eq(activityLog.companyId, seeded.companyId), eq(activityLog.entityId, report!.id)));
    expect(activity.map((row) => row.action)).toContain("issue.organization_checkup_created");

    // The productivity reviewer must never treat the report as work in
    // progress -- even after a board user assigns it to someone.
    await db.update(issues).set({ assigneeAgentId: seeded.ctoId, status: "in_progress" }).where(eq(issues.id, report!.id));
    const reviewed = await productivityReviewService(db).reconcileProductivityReviews({ now: NOW, companyId: seeded.companyId });
    expect(reviewed.scanned).toBe(0);
  });

  it("does not file a second report while one is open, and only becomes due again after the interval", async () => {
    const seeded = await seedCompany();
    await insertIssue(seeded, { status: "todo", updatedAt: daysBefore(10) });
    const service = organizationCheckupService(db);

    const first = await service.runCheckup({ companyId: seeded.companyId, now: NOW });
    const second = await service.runCheckup({ companyId: seeded.companyId, now: new Date(NOW.getTime() + 60_000) });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("existing");
    expect(second.reportIssueId).toBe(first.reportIssueId);
    expect(second.existingReportCreatedAt?.toISOString()).toBe(NOW.toISOString());
    expect(second.writtenTables).toEqual([]);
    expect(await listReports(seeded.companyId)).toHaveLength(1);
    expect(await listInteractions(first.reportIssueId!)).toHaveLength(1);

    // Scheduler: still open -> existing; closed but inside the interval -> not due.
    const eightDaysLater = new Date(NOW.getTime() + 8 * DAY_MS);
    expect(await service.reconcileOrganizationCheckups({ now: eightDaysLater, companyId: seeded.companyId })).toMatchObject({ scanned: 1, created: 0, existing: 1 });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, first.reportIssueId!));
    expect(await service.reconcileOrganizationCheckups({ now: new Date(NOW.getTime() + 3 * DAY_MS), companyId: seeded.companyId })).toMatchObject({ created: 0, notDue: 1 });
    const later = await service.reconcileOrganizationCheckups({ now: eightDaysLater, companyId: seeded.companyId });
    expect(later).toMatchObject({ created: 1, notDue: 0, existing: 0, failed: 0 });
    const reports = await listReports(seeded.companyId);
    expect(reports).toHaveLength(2);
    expect(reports[1]?.originFingerprint).toBe("checkup:2026-W38");
  });

  it("dry run renders the full report but writes nothing at all", async () => {
    const seeded = await seedCompany();
    await insertIssue(seeded, { status: "todo", updatedAt: daysBefore(10) });
    const countRows = async () => ({
      issues: await db.select({ count: sql<number>`count(*)::int` }).from(issues).then((rows) => Number(rows[0]?.count)),
      interactions: await db.select({ count: sql<number>`count(*)::int` }).from(issueThreadInteractions).then((rows) => Number(rows[0]?.count)),
      activity: await db.select({ count: sql<number>`count(*)::int` }).from(activityLog).then((rows) => Number(rows[0]?.count)),
    });
    const before = await countRows();

    const service = organizationCheckupService(db);
    const result = await service.runCheckup({ companyId: seeded.companyId, now: NOW, dryRun: true });
    expect(result.outcome).toBe("dry_run");
    expect(result.reportIssueId).toBeNull();
    expect(result.writtenTables).toEqual([]);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.body).toContain(CHECKUP_SECTION_HEADINGS.stuck);
    expect(await countRows()).toEqual(before);

    const reconciled = await service.reconcileOrganizationCheckups({ now: NOW, companyId: seeded.companyId, dryRun: true });
    expect(reconciled).toMatchObject({ scanned: 1, dryRun: 1, created: 0 });
    expect(await countRows()).toEqual(before);
  });

  it("files a clean check-up already closed, with no accept card", async () => {
    const seeded = await seedCompany();
    const result = await organizationCheckupService(db).runCheckup({ companyId: seeded.companyId, now: NOW });
    expect(result.findings).toEqual([]);
    expect(result.writtenTables).toEqual(["activity_log", "issues"]);
    const [report] = await listReports(seeded.companyId);
    expect(report?.status).toBe("done");
    expect(report?.title).toBe("Weekly check-up for Durkan Test Co, 2026-09-07: nothing needs your attention");
    expect(report?.description).toContain("Nothing needs your attention this time.");
    expect(await listInteractions(report!.id)).toHaveLength(0);
  });

  it("hides a finding any board user dismissed in the last month, company-wide, and names who hid it", async () => {
    const seeded = await seedCompany();
    await insertIssue(seeded, { status: "todo", updatedAt: daysBefore(10) });
    await db.update(agents).set({ status: "error", errorReason: "boom", errorAt: hoursBefore(2) }).where(eq(agents.id, seeded.workerId));
    await db.insert(authUsers).values({ id: "user-a", name: "Anna", email: "anna@example.com", createdAt: NOW, updatedAt: NOW });
    await db.insert(inboxDismissals).values({
      companyId: seeded.companyId,
      userId: "user-a",
      itemKey: `${CHECKUP_FINDING_DISMISSAL_PREFIX}stuck_issues`,
      dismissedAt: daysBefore(10),
    });

    const service = organizationCheckupService(db);
    const hidden = await service.runCheckup({ companyId: seeded.companyId, now: NOW, dryRun: true });
    expect(findingsByKind(hidden.findings, "stuck_issues")).toHaveLength(0);
    expect(findingsByKind(hidden.findings, "agent_error")).toHaveLength(1);
    expect(hidden.suppressedFindings.map((finding) => finding.fingerprint)).toEqual(["stuck_issues"]);
    expect(hidden.body).toContain("tasks that have not moved, hidden by Anna on 2026-08-28.");

    // Forty days on, the mute has lapsed.
    const fortyDaysLater = new Date(NOW.getTime() + 30 * DAY_MS);
    const back = await service.runCheckup({ companyId: seeded.companyId, now: fortyDaysLater, dryRun: true });
    expect(findingsByKind(back.findings, "stuck_issues")).toHaveLength(1);
    expect(back.suppressedFindings).toEqual([]);
    expect(back.body).not.toContain("Hidden for now");
  });

  it("summarises the open report for the dashboard: how many suggestions still wait, and none once decided", async () => {
    const seeded = await seedCompany();
    const service = organizationCheckupService(db);
    expect(await service.summarizeOpenCheckup(seeded.companyId)).toBeNull();

    await insertIssue(seeded, { status: "todo", updatedAt: daysBefore(10) });
    await db.update(agents).set({ status: "error", errorReason: "boom", errorAt: hoursBefore(2) }).where(eq(agents.id, seeded.workerId));
    const created = await service.runCheckup({ companyId: seeded.companyId, now: NOW });
    expect(created.outcome).toBe("created");

    const waiting = await service.summarizeOpenCheckup(seeded.companyId);
    expect(waiting).toMatchObject({
      report: { id: created.reportIssueId, status: "todo" },
      suggestionCount: created.findings.length,
      pendingSuggestionCount: created.findings.length,
      suggestionsStatus: "pending",
    });
    expect(waiting?.report.title).toBe(created.title);

    // Once the board has accepted (or rejected) the card, nothing waits any more.
    const [card] = await listInteractions(created.reportIssueId!);
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: NOW }).where(eq(issueThreadInteractions.id, card!.id));
    expect(await service.summarizeOpenCheckup(seeded.companyId)).toMatchObject({
      suggestionCount: created.findings.length,
      pendingSuggestionCount: 0,
      suggestionsStatus: "accepted",
    });

    // A closed report is no longer "the open check-up".
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, created.reportIssueId!));
    expect(await service.summarizeOpenCheckup(seeded.companyId)).toBeNull();
  });

  it("hideFindings writes one 28-day dismissal per finding for the board user, and the next report honours it", async () => {
    const seeded = await seedCompany();
    await insertIssue(seeded, { status: "todo", updatedAt: daysBefore(10) });
    await db.update(agents).set({ status: "error", errorReason: "boom", errorAt: hoursBefore(2) }).where(eq(agents.id, seeded.workerId));
    await db.insert(authUsers).values({ id: "user-b", name: "Bjorn", email: "bjorn@example.com", createdAt: NOW, updatedAt: NOW });
    const service = organizationCheckupService(db);

    const hidden = await service.hideFindings({
      companyId: seeded.companyId,
      userId: "user-b",
      fingerprints: ["stuck_issues", " stuck_issues ", ""],
      now: NOW,
    });
    expect(hidden.itemKeys).toEqual([`${CHECKUP_FINDING_DISMISSAL_PREFIX}stuck_issues`]);

    const rows = await db.select().from(inboxDismissals).where(eq(inboxDismissals.companyId, seeded.companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "user-b", itemKey: `${CHECKUP_FINDING_DISMISSAL_PREFIX}stuck_issues` });

    const activity = await db.select().from(activityLog).where(and(eq(activityLog.companyId, seeded.companyId), eq(activityLog.action, "inbox.dismissed")));
    expect(activity).toHaveLength(1);
    expect(activity[0]?.actorId).toBe("user-b");

    const next = await service.runCheckup({ companyId: seeded.companyId, now: new Date(NOW.getTime() + DAY_MS), dryRun: true });
    expect(findingsByKind(next.findings, "stuck_issues")).toHaveLength(0);
    expect(findingsByKind(next.findings, "agent_error")).toHaveLength(1);
    expect(next.body).toContain("tasks that have not moved, hidden by Bjorn on 2026-09-07.");

    // Nothing to hide: nothing written, no activity row.
    const nothing = await service.hideFindings({ companyId: seeded.companyId, userId: "user-b", fingerprints: [], now: NOW });
    expect(nothing.itemKeys).toEqual([]);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, seeded.companyId), eq(activityLog.action, "inbox.dismissed")))).toHaveLength(1);
  });

  it("only runs for the companies it is told to, and never for paused ones", async () => {
    const on = await seedCompany({ name: "Switched On" });
    const off = await seedCompany({ name: "Switched Off" });
    const paused = await seedCompany({ name: "Paused", status: "paused" });
    const service = organizationCheckupService(db);

    const limited = await service.reconcileOrganizationCheckups({ now: NOW, companyIds: [on.companyId] });
    expect(limited).toMatchObject({ scanned: 1, created: 1 });
    expect(await listReports(on.companyId)).toHaveLength(1);
    expect(await listReports(off.companyId)).toHaveLength(0);

    const all = await service.reconcileOrganizationCheckups({ now: NOW, companyIds: [] });
    expect(all.scanned).toBe(2);
    expect(await listReports(off.companyId)).toHaveLength(1);
    expect(await listReports(paused.companyId)).toHaveLength(0);
  });

  it("writes the report in plain language: fixed headings in order, no identifiers, no machine words", async () => {
    const seeded = await seedCompany({ name: "Nordstrand Gruppen", budgetMonthlyCents: 50_000, spentMonthlyCents: 49_000 });
    await db.update(agents).set({ status: "error", errorReason: "workspace_validation_failed for 11111111-1111-4111-8111-111111111111", errorAt: hoursBefore(3) }).where(eq(agents.id, seeded.workerId));
    for (let index = 0; index < 3; index += 1) await insertRun(seeded, { agentId: seeded.ctoId, status: "failed", error: "process_lost", costCents: 200, createdAt: hoursBefore(index + 1) });
    await insertIssue(seeded, { title: "Design the spring catalogue", status: "in_progress", assigneeAgentId: seeded.workerId, updatedAt: hoursBefore(8) });
    await insertIssue(seeded, { title: "Renew the domain", status: "blocked", updatedAt: daysBefore(12) });
    await insertIssue(seeded, { status: "todo", assigneeAgentId: seeded.ceoId });
    await insertCost(seeded, { agentId: seeded.ceoId, costCents: 100 });
    await insertCost(seeded, { agentId: seeded.workerId, costCents: 120 });
    await insertCost(seeded, { agentId: seeded.ctoId, costCents: 9_000 });
    await db.insert(approvals).values({ companyId: seeded.companyId, type: "merge_pr", status: "pending", payload: { title: "Merge the checkout fix" }, createdAt: daysBefore(4), updatedAt: daysBefore(4) });
    const asked = await insertIssue(seeded, { title: "Choose a supplier", status: "todo" });
    await db.insert(issueThreadInteractions).values({ companyId: seeded.companyId, issueId: asked.id, kind: "ask_user_questions", status: "pending", title: "Which supplier?", createdByAgentId: seeded.ceoId, payload: { version: 1, questions: [] }, createdAt: daysBefore(5), updatedAt: daysBefore(5) });

    const result = await organizationCheckupService(db).runCheckup({ companyId: seeded.companyId, now: NOW, dryRun: true });

    const kinds = new Set(result.findings.map((finding) => finding.fingerprint.split(":")[0]));
    for (const expected of ["agent_error", "repeated_failures", "in_progress_without_run", "stuck_issues", "silent_agent", "spend_outlier", "company_budget_nearly_used", "pending_approvals", "unanswered_questions"]) {
      expect(kinds, `expected a ${expected} finding`).toContain(expected);
    }
    expect(result.findings.map((finding) => finding.severity)).toEqual(
      [...result.findings.map((finding) => finding.severity)].sort((a, b) => CHECKUP_SEVERITIES.indexOf(a) - CHECKUP_SEVERITIES.indexOf(b)),
    );

    const headings = result.body.split("\n").filter((line) => line.startsWith("## ")).map((line) => line.slice(3));
    expect(headings).toEqual(CHECKUP_SEVERITIES.map((severity) => CHECKUP_SECTION_HEADINGS[severity]));
    expect(result.title).not.toMatch(UUID_PATTERN);
    expect(result.body).not.toMatch(UUID_PATTERN);
    expect(result.body).not.toMatch(SNAKE_CASE_PATTERN);
    for (const finding of result.findings) {
      expect(finding.headline).not.toMatch(UUID_PATTERN);
      expect(finding.headline).not.toMatch(SNAKE_CASE_PATTERN);
      expect(finding.suggestedTask.title).not.toMatch(SNAKE_CASE_PATTERN);
      expect(finding.suggestedTask.description).not.toMatch(UUID_PATTERN);
    }
    expect(result.body).toContain(`${plural(DEFAULT_CHECKUP_THRESHOLDS.stuckIssueDays)} without any change`);
    expect(result.body).toContain("The next check-up is due in 7 days.");
  });
});

function plural(days: number) {
  return `${days} day${days === 1 ? "" : "s"}`;
}
