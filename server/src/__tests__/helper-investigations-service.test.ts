import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
  activityLog,
  agents,
  assets,
  companies,
  companyHelperSettings,
  costEvents,
  createDb,
  issueAttachments,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  HELPER_INVESTIGATION_BILLING_CODE,
  HELPER_INVESTIGATION_ORIGIN_KIND,
  stripInvestigationSuggestion,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  buildHelperInvestigationDescription,
  extractHelperInvestigationQuestion,
  helperInvestigationService,
  helperInvestigationStatusOf,
} from "../services/helper-investigations.ts";
import { helperService } from "../services/helper.ts";

/**
 * "Ask Paperclip", Phase 3 ("Investigate deeper"), against a real database:
 *   - nothing starts without an investigation agent; the refusal says who can fix it and where;
 *   - a start is an ordinary task: assigned to the company's investigation agent, work mode
 *     "ask", origin 'helper_investigation', created by the person, billed as a helper investigation,
 *     with advice-only standing orders, masked page context, the marked records and pictures
 *     kept as this task's attachments; the agent is woken;
 *   - limits per person (running at once, per 24 hours) and a paused / let-go agent refuse in plain words;
 *   - the list is the person's own, in this company only, with a plain status and the agent's answer;
 *   - the quick helper can only suggest an investigation (a marker the server strips).
 */

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

function fakeStorage() {
  const putFile = vi.fn(async (input: { companyId: string; namespace: string; originalFilename: string | null; contentType: string; body: Buffer }) => ({
    provider: "local_disk" as const,
    objectKey: `${input.companyId}/${input.namespace}/${randomUUID()}.jpg`,
    contentType: input.contentType,
    byteSize: input.body.length,
    sha256: "abc",
    originalFilename: input.originalFilename,
  }));
  return { putFile, storage: () => ({ putFile, getObject: vi.fn(), headObject: vi.fn(), deleteObject: vi.fn(), provider: "local_disk" }) as never };
}

describeDb("helper investigations (Ask Paperclip, Phase 3)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  vi.setConfig({ testTimeout: 60_000 });

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("helper-investigations");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companyHelperSettings);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(name = "Acme") {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: `I${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedAgent(companyId: string, input: Partial<typeof agents.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: "Investigator",
      role: "general",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      ...input,
    });
    return id;
  }

  async function setUp(companyId: string, agentId: string | null, limits: { maxRunning?: number; maxPerDay?: number } = {}) {
    await db.insert(companyHelperSettings).values({
      companyId,
      investigationAgentId: agentId,
      investigationMaxRunning: limits.maxRunning ?? null,
      investigationMaxPerDay: limits.maxPerDay ?? null,
    });
  }

  function service(extra: { storage?: () => never } = {}) {
    const wakeup = vi.fn().mockResolvedValue(null);
    const svc = helperInvestigationService(db, { heartbeat: { wakeup }, storage: extra.storage ?? fakeStorage().storage });
    return { svc, wakeup };
  }

  it("refuses in plain words when no investigation agent is set up, and creates nothing", async () => {
    const companyId = await seedCompany();
    const { svc, wakeup } = service();
    const err = await svc.start({ companyId, userId: "maria", question: "Should I approve this?" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422 });
    expect((err as Error).message).toContain("A company owner or admin can pick one under Company settings → General → Helper");
    expect((err as { details: { code: string } }).details.code).toBe("HELPER_INVESTIGATION_NO_AGENT");

    const asOwner = await svc.availability(companyId, "filip", { canConfigure: true });
    expect(asOwner).toMatchObject({ ready: false, problemCode: "no_agent", canConfigure: true });
    expect(asOwner.problem).toContain("Pick one under Company settings → General → Helper");
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("starts an advice-only task for the investigation agent with masked context, the marked records and the pictures, and wakes it", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await setUp(companyId, agentId);
    const store = fakeStorage();
    const { svc, wakeup } = service({ storage: store.storage });
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const approvalId = randomUUID();

    const view = await svc.start({
      companyId,
      userId: "maria",
      question: "Should I approve this deploy? My token is sk-abcdefghijklmnopqrstuv",
      context: "Card: Deploy PR #612\nAPI key: sk-live-zyxwvutsrqponmlkjihg\nStatus: pending",
      pageRoute: "/ACM/dashboard/now",
      references: [`approval:${approvalId}`, `approval:${approvalId}`],
      quickAnswer: "Probably fine, but I cannot see the code.",
      pictures: [{ kind: "upload", name: "card.png", contentType: "image/png", dataBase64: png.toString("base64") }],
    });

    expect(view).toMatchObject({ status: "queued", statusLabel: "Waiting to start", agentId, agentName: "Investigator", answer: null });
    expect(view.question).toContain("Should I approve this deploy?");
    expect(view.question).not.toContain("sk-abcdefghijklmnopqrstuv");

    const [task] = await db.select().from(issues).where(eq(issues.id, view.id));
    expect(task).toMatchObject({
      companyId,
      assigneeAgentId: agentId,
      status: "todo",
      workMode: "ask",
      originKind: HELPER_INVESTIGATION_ORIGIN_KIND,
      createdByUserId: "maria",
      createdByAgentId: null,
      billingCode: HELPER_INVESTIGATION_BILLING_CODE,
    });
    expect(task!.title.startsWith("Ask Paperclip: Should I approve this deploy?")).toBe(true);
    const description = task!.description!;
    for (const rule of [
      "advice only",
      "Do NOT approve, reject or decide any approval card",
      "Do NOT merge, push, deploy",
      "Do NOT change anything",
      "Post ONE final comment",
      "mark this task done",
      "**Verdict first**",
      "**What to check**",
    ]) {
      expect(description).toContain(rule);
    }
    expect(description).toContain("Page: /ACM/dashboard/now");
    expect(description).toContain(`approval:${approvalId} (an approval card: GET /api/approvals/${approvalId}`);
    expect(description.split(`approval:${approvalId} (`)).toHaveLength(2); // de-duplicated
    expect(description).toContain("Card: Deploy PR #612");
    expect(description).toContain("Probably fine, but I cannot see the code.");
    expect(description).not.toContain("sk-live-zyxwvutsrqponmlkjihg");
    expect(description).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(description).toContain("[hidden]");
    expect(description).toContain("helper-picture-1.jpg");

    // The picture went through the Phase 2 checks (now a JPEG) into this company's storage, under this task.
    expect(store.putFile).toHaveBeenCalledTimes(1);
    const put = store.putFile.mock.calls[0]![0];
    expect(put).toMatchObject({ companyId, namespace: `issues/${view.id}`, contentType: "image/jpeg", originalFilename: "helper-picture-1.jpg" });
    expect([...put.body.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const attachments = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, view.id));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.companyId).toBe(companyId);

    const [activity] = await db.select().from(activityLog).where(eq(activityLog.entityId, view.id));
    expect(activity).toMatchObject({ action: "issue.created", actorType: "user", actorId: "maria", companyId });
    expect(activity!.details).toMatchObject({ source: "helper_investigation", pictureCount: 1, referenceCount: 1 });

    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ reason: "issue_assigned", payload: expect.objectContaining({ issueId: view.id }) }));
  });

  it("refuses a picture that is not a real picture before anything is created", async () => {
    const companyId = await seedCompany();
    await setUp(companyId, await seedAgent(companyId));
    const store = fakeStorage();
    const { svc } = service({ storage: store.storage });
    const err = await svc
      .start({ companyId, userId: "maria", question: "What is this?", pictures: [{ kind: "upload", name: "x.png", dataBase64: Buffer.from("not a picture").toString("base64") }] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422 });
    expect(store.putFile).not.toHaveBeenCalled();
    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("keeps to each person's limits: running at once and started in 24 hours", async () => {
    const companyId = await seedCompany();
    await setUp(companyId, await seedAgent(companyId), { maxRunning: 1, maxPerDay: 2 });
    const { svc } = service();
    const first = await svc.start({ companyId, userId: "maria", question: "One" });

    const busy = await svc.start({ companyId, userId: "maria", question: "Two" }).catch((e: unknown) => e);
    expect(busy).toMatchObject({ status: 429 });
    expect((busy as Error).message).toContain("You already have 1 investigation running");
    // Someone else in the company is not held up by Maria's.
    await expect(svc.start({ companyId, userId: "ola", question: "Mine" })).resolves.toMatchObject({ status: "queued" });

    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, first.id));
    await svc.start({ companyId, userId: "maria", question: "Two" });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.createdByUserId, "maria"));
    const daily = await svc.start({ companyId, userId: "maria", question: "Three" }).catch((e: unknown) => e);
    expect(daily).toMatchObject({ status: 429 });
    expect((daily as Error).message).toContain("You have started 2 investigations in the last 24 hours");

    // A day later the count starts over.
    const later = helperInvestigationService(db, {
      heartbeat: { wakeup: vi.fn().mockResolvedValue(null) },
      storage: fakeStorage().storage,
      now: () => new Date(Date.now() + 25 * 60 * 60 * 1000),
    });
    expect((await later.availability(companyId, "maria", { canConfigure: false })).ready).toBe(true);
  });

  it("refuses a paused or let-go agent, and an agent of another company, in plain words", async () => {
    const companyId = await seedCompany();
    const paused = await seedAgent(companyId, { name: "Sleepy", status: "paused", pauseReason: "manual" });
    await setUp(companyId, paused);
    const { svc } = service();
    const err = await svc.start({ companyId, userId: "maria", question: "Hi" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422 });
    expect((err as Error).message).toContain('"Sleepy" is paused, so it would not start');

    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, paused));
    const gone = await svc.start({ companyId, userId: "maria", question: "Hi" }).catch((e: unknown) => e);
    expect((gone as Error).message).toContain('"Sleepy" has been let go');

    // Settings cannot point at another company's agent, nor at a let-go one.
    const otherCompanyId = await seedCompany("Other");
    const foreign = await seedAgent(otherCompanyId, { name: "Foreign" });
    const settings = helperService(db);
    await expect(settings.updateSettings(companyId, { investigationAgentId: foreign }, { userId: "filip" })).rejects.toMatchObject({ status: 404 });
    await expect(settings.updateSettings(companyId, { investigationAgentId: paused }, { userId: "filip" })).rejects.toMatchObject({ status: 422 });
    // Even a row that somehow points across companies reads as "not set up".
    await db.update(companyHelperSettings).set({ investigationAgentId: foreign }).where(eq(companyHelperSettings.companyId, companyId));
    expect((await svc.availability(companyId, "maria", { canConfigure: false })).problemCode).toBe("no_agent");
    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("lists only the person's own investigations in this company, with a plain status and the agent's answer", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await setUp(companyId, agentId, { maxRunning: 10 });
    const otherCompanyId = await seedCompany("Other");
    await setUp(otherCompanyId, await seedAgent(otherCompanyId));
    const { svc } = service();

    const answered = await svc.start({ companyId, userId: "maria", question: "Should I approve ```this```?" });
    const working = await svc.start({ companyId, userId: "maria", question: "What broke?" });
    const stopped = await svc.start({ companyId, userId: "maria", question: "Old one" });
    const stuck = await svc.start({ companyId, userId: "maria", question: "Blocked one" });
    await svc.start({ companyId, userId: "ola", question: "Ola's question" });
    await svc.start({ companyId: otherCompanyId, userId: "maria", question: "Other company" });

    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, answered.id));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, working.id));
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, stopped.id));
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, stuck.id));
    await db.insert(issueComments).values([
      { companyId, issueId: answered.id, authorType: "agent", authorAgentId: agentId, body: "**Yes, approve it.**\n\nWhy: tests pass.", createdAt: new Date(Date.now() - 1000) },
      {
        companyId,
        issueId: answered.id,
        authorType: "agent",
        authorAgentId: agentId,
        body: "Run finished.",
        presentation: { kind: "system_notice", tone: "neutral", detailsDefaultOpen: false },
      },
      { companyId, issueId: answered.id, authorType: "user", authorUserId: "maria", body: "Thanks!" },
      { companyId, issueId: working.id, authorType: "agent", authorAgentId: agentId, body: "Looking at the logs now." },
    ]);
    await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId: answered.id,
      provider: "anthropic",
      model: "claude-sonnet-5",
      costCents: 42,
      occurredAt: new Date(),
    });

    const { investigations, availability } = await svc.list(companyId, "maria", { canConfigure: false });
    expect(investigations.map((i) => i.question)).toEqual(["Blocked one", "Old one", "What broke?", "Should I approve ```this```?"]);
    const byId = new Map(investigations.map((i) => [i.id, i]));
    expect(byId.get(answered.id)).toMatchObject({ status: "done", statusLabel: "Done", answer: "**Yes, approve it.**\n\nWhy: tests pass.", costCents: 42 });
    expect(byId.get(working.id)).toMatchObject({ status: "working", answer: null });
    expect(byId.get(stopped.id)).toMatchObject({ status: "failed", statusLabel: "Stopped" });
    expect(byId.get(stuck.id)).toMatchObject({ status: "failed", statusLabel: "Stuck" });
    expect(availability).toMatchObject({ runningCount: 1, startedLast24h: 4, maxRunning: 10, maxPerDay: 20, ready: true });

    expect((await svc.list(companyId, "ola", { canConfigure: false })).investigations.map((i) => i.question)).toEqual(["Ola's question"]);
    expect((await svc.list(otherCompanyId, "maria", { canConfigure: false })).investigations.map((i) => i.question)).toEqual(["Other company"]);
  });

  it("estimates time and cost from the agent's own recent finished tasks", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await setUp(companyId, agentId);
    const { svc } = service();
    expect((await svc.availability(companyId, "maria", { canConfigure: false })).estimate).toEqual({ basedOnTasks: 0, typicalMinutes: null, typicalCostCents: null });

    const now = Date.now();
    for (const [minutes, cents] of [[4, 30], [6, 50], [20, 300]] as const) {
      const [row] = await db
        .insert(issues)
        .values({
          companyId,
          title: `Task ${minutes}`,
          status: "done",
          assigneeAgentId: agentId,
          startedAt: new Date(now - minutes * 60_000),
          completedAt: new Date(now),
        })
        .returning();
      await db.insert(costEvents).values({ companyId, agentId, issueId: row!.id, provider: "anthropic", model: "m", costCents: cents, occurredAt: new Date() });
    }
    expect((await svc.availability(companyId, "maria", { canConfigure: false })).estimate).toEqual({ basedOnTasks: 3, typicalMinutes: 6, typicalCostCents: 50 });
  });

  it("the quick helper can only suggest an investigation: the marker is removed and flagged", async () => {
    const companyId = await seedCompany();
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "I can't see the code behind this card, so this needs a closer look.\n\n[[suggest-investigation]]" }],
      usage: { input_tokens: 10, output_tokens: 10 },
      stop_reason: "end_turn",
    });
    const result = await helperService(db, { createModelClient: () => ({ messages: { create } }) as never }).ask({
      companyId,
      userId: "maria",
      message: "Should I approve this?",
    });
    expect(result.suggestInvestigation).toBe(true);
    expect(result.answer).toBe("I can't see the code behind this card, so this needs a closer look.");
    const system = create.mock.calls[0]![0].system as string;
    expect(system).toContain("[[suggest-investigation]]");
    expect(system).toContain("Never say that you started anything yourself");
    expect(await db.select().from(issues)).toHaveLength(0);
  });
});

describe("helper investigation pieces", () => {
  it("maps task states to plain words", () => {
    expect(helperInvestigationStatusOf({ status: "todo", executionRunId: null, hasAnswer: false })).toMatchObject({ status: "queued" });
    expect(helperInvestigationStatusOf({ status: "todo", executionRunId: "run", hasAnswer: false })).toMatchObject({ status: "working" });
    expect(helperInvestigationStatusOf({ status: "in_progress", executionRunId: null, hasAnswer: true })).toMatchObject({ status: "working" });
    expect(helperInvestigationStatusOf({ status: "in_review", executionRunId: null, hasAnswer: true })).toMatchObject({ status: "done" });
    expect(helperInvestigationStatusOf({ status: "done", executionRunId: null, hasAnswer: false }).statusDetail).toContain("without writing an answer");
    expect(helperInvestigationStatusOf({ status: "cancelled", executionRunId: null, hasAnswer: false })).toMatchObject({ status: "failed", statusLabel: "Stopped" });
    expect(helperInvestigationStatusOf({ status: "blocked", executionRunId: null, hasAnswer: false })).toMatchObject({ status: "failed", statusLabel: "Stuck" });
  });

  it("reads the question back out of the description, even with backticks in it", () => {
    const question = "Is ```rm -rf``` in this PR dangerous?\nSecond line";
    const description = buildHelperInvestigationDescription({ question, context: "```code```" });
    expect(extractHelperInvestigationQuestion(description, "Ask Paperclip: Is")).toBe(question);
    expect(extractHelperInvestigationQuestion("edited by hand", "Ask Paperclip: Short title")).toBe("Short title");
  });

  it("strips the suggestion marker only when it is there", () => {
    expect(stripInvestigationSuggestion("Fine.")).toEqual({ text: "Fine.", suggested: false });
    expect(stripInvestigationSuggestion("Look closer.\n[[ Suggest_Investigation ]]")).toEqual({ text: "Look closer.", suggested: true });
  });
});
