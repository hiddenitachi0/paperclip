import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
  activityLog,
  agents,
  approvals,
  assets,
  companies,
  companyHelperSettings,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  costEvents,
  createDb,
  issueAttachments,
  issueComments,
  issues,
  principalPermissionGrants,
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

/** The local board: every rights check passes, so these cases test the helper's own rules. */
const local = (userId: string) => ({ type: "board" as const, source: "local_implicit" as const, userId });
/** A signed-in person: their membership and grants decide. */
const person = (userId: string, companyId: string, role: string) => ({
  type: "board" as const,
  source: "session" as const,
  userId,
  isInstanceAdmin: false,
  companyIds: [companyId],
  memberships: [{ companyId, status: "active", membershipRole: role }],
});

function fakeStorage() {
  const deleteObject = vi.fn(async () => undefined);
  const putFile = vi.fn(async (input: { companyId: string; namespace: string; originalFilename: string | null; contentType: string; body: Buffer }) => ({
    provider: "local_disk" as const,
    objectKey: `${input.companyId}/${input.namespace}/${randomUUID()}.jpg`,
    contentType: input.contentType,
    byteSize: input.body.length,
    sha256: "abc",
    originalFilename: input.originalFilename,
  }));
  return { putFile, deleteObject, storage: () => ({ putFile, getObject: vi.fn(), headObject: vi.fn(), deleteObject, provider: "local_disk" }) as never };
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
    await db.delete(approvals);
    await db.delete(companySecretBindings);
    await db.delete(companySecrets);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
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
    const err = await svc.start({ companyId, actor: local("maria"), question: "Should I approve this?" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422 });
    expect((err as Error).message).toContain("A company owner or admin can pick one under Company settings → General → Helper");
    expect((err as { details: { code: string } }).details.code).toBe("HELPER_INVESTIGATION_NO_AGENT");

    const asOwner = await svc.availability(companyId, local("filip"), { canConfigure: true });
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
    await db.insert(approvals).values({ id: approvalId, companyId, type: "request_board_approval", payload: {} });

    const view = await svc.start({
      companyId,
      actor: local("maria"),
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
      .start({ companyId, actor: local("maria"), question: "What is this?", pictures: [{ kind: "upload", name: "x.png", dataBase64: Buffer.from("not a picture").toString("base64") }] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422 });
    expect(store.putFile).not.toHaveBeenCalled();
    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("keeps to each person's limits: running at once and started in 24 hours", async () => {
    const companyId = await seedCompany();
    await setUp(companyId, await seedAgent(companyId), { maxRunning: 1, maxPerDay: 2 });
    const { svc } = service();
    const first = await svc.start({ companyId, actor: local("maria"), question: "One" });

    const busy = await svc.start({ companyId, actor: local("maria"), question: "Two" }).catch((e: unknown) => e);
    expect(busy).toMatchObject({ status: 429 });
    expect((busy as Error).message).toContain("You already have 1 investigation running");
    // Someone else in the company is not held up by Maria's.
    await expect(svc.start({ companyId, actor: local("ola"), question: "Mine" })).resolves.toMatchObject({ status: "queued" });

    // A stuck (blocked) investigation still holds its slot.
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, first.id));
    const stuck = await svc.start({ companyId, actor: local("maria"), question: "Two" }).catch((e: unknown) => e);
    expect((stuck as Error).message).toContain("cancel a stuck one in its task");

    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, first.id));
    await svc.start({ companyId, actor: local("maria"), question: "Two" });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.createdByUserId, "maria"));
    const daily = await svc.start({ companyId, actor: local("maria"), question: "Three" }).catch((e: unknown) => e);
    expect(daily).toMatchObject({ status: 429 });
    expect((daily as Error).message).toContain("You have started 2 investigations in the last 24 hours");

    // A day later the count starts over.
    const later = helperInvestigationService(db, {
      heartbeat: { wakeup: vi.fn().mockResolvedValue(null) },
      storage: fakeStorage().storage,
      now: () => new Date(Date.now() + 25 * 60 * 60 * 1000),
    });
    expect((await later.availability(companyId, local("maria"), { canConfigure: false })).ready).toBe(true);
  });

  it("refuses a paused or let-go agent, and an agent of another company, in plain words", async () => {
    const companyId = await seedCompany();
    const paused = await seedAgent(companyId, { name: "Sleepy", status: "paused", pauseReason: "manual" });
    await setUp(companyId, paused);
    const { svc } = service();
    const err = await svc.start({ companyId, actor: local("maria"), question: "Hi" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422 });
    expect((err as Error).message).toContain('"Sleepy" is paused, so it would not start');

    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, paused));
    const gone = await svc.start({ companyId, actor: local("maria"), question: "Hi" }).catch((e: unknown) => e);
    expect((gone as Error).message).toContain('"Sleepy" has been let go');

    // Settings cannot point at another company's agent, nor at a let-go one.
    const otherCompanyId = await seedCompany("Other");
    const foreign = await seedAgent(otherCompanyId, { name: "Foreign" });
    const settings = helperService(db);
    await expect(settings.updateSettings(companyId, { investigationAgentId: foreign }, { userId: "filip" })).rejects.toMatchObject({ status: 404 });
    await expect(settings.updateSettings(companyId, { investigationAgentId: paused }, { userId: "filip" })).rejects.toMatchObject({ status: 422 });
    // Even a row that somehow points across companies reads as "not set up".
    await db.update(companyHelperSettings).set({ investigationAgentId: foreign }).where(eq(companyHelperSettings.companyId, companyId));
    expect((await svc.availability(companyId, local("maria"), { canConfigure: false })).problemCode).toBe("no_agent");
    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("lists only the person's own investigations in this company, with a plain status and the agent's answer", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await setUp(companyId, agentId, { maxRunning: 10 });
    const otherCompanyId = await seedCompany("Other");
    await setUp(otherCompanyId, await seedAgent(otherCompanyId));
    const { svc } = service();

    const answered = await svc.start({ companyId, actor: local("maria"), question: "Should I approve ```this```?" });
    const working = await svc.start({ companyId, actor: local("maria"), question: "What broke?" });
    const stopped = await svc.start({ companyId, actor: local("maria"), question: "Old one" });
    const stuck = await svc.start({ companyId, actor: local("maria"), question: "Blocked one" });
    await svc.start({ companyId, actor: local("ola"), question: "Ola's question" });
    await svc.start({ companyId: otherCompanyId, actor: local("maria"), question: "Other company" });

    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, answered.id));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, working.id));
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, stopped.id));
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, stuck.id));
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: answered.id,
        authorType: "agent",
        authorAgentId: agentId,
        body: "**Yes, approve it.**\n\nWhy: tests pass. (The deploy key is sk-abcdefghijklmnopqrstuv.)",
        createdAt: new Date(Date.now() - 1000),
      },
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

    const { investigations, availability } = await svc.list(companyId, local("maria"), { canConfigure: false });
    expect(investigations.map((i) => i.question)).toEqual(["Blocked one", "Old one", "What broke?", "Should I approve ```this```?"]);
    const byId = new Map(investigations.map((i) => [i.id, i]));
    // The answer is masked like everything else the helper shows.
    expect(byId.get(answered.id)).toMatchObject({
      status: "done",
      statusLabel: "Done",
      answer: "**Yes, approve it.**\n\nWhy: tests pass. (The deploy key is [hidden].)",
      costCents: 42,
    });
    expect(byId.get(working.id)).toMatchObject({ status: "working", answer: null });
    expect(byId.get(stopped.id)).toMatchObject({ status: "failed", statusLabel: "Stopped" });
    expect(byId.get(stuck.id)).toMatchObject({ status: "failed", statusLabel: "Stuck" });
    // The stuck one keeps its slot (it can be woken again) until it is cancelled.
    expect(availability).toMatchObject({ runningCount: 2, startedLast24h: 4, maxRunning: 10, maxPerDay: 20, ready: true });

    expect((await svc.list(companyId, local("ola"), { canConfigure: false })).investigations.map((i) => i.question)).toEqual(["Ola's question"]);
    expect((await svc.list(otherCompanyId, local("maria"), { canConfigure: false })).investigations.map((i) => i.question)).toEqual(["Other company"]);
  });

  it("estimates time and cost from the agent's own recent finished tasks", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await setUp(companyId, agentId);
    const { svc } = service();
    expect((await svc.availability(companyId, local("maria"), { canConfigure: false })).estimate).toEqual({ basedOnTasks: 0, typicalMinutes: null, typicalCostCents: null });

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
    expect((await svc.availability(companyId, local("maria"), { canConfigure: false })).estimate).toEqual({ basedOnTasks: 3, typicalMinutes: 6, typicalCostCents: 50 });
  });

  async function seedMember(companyId: string, userId: string, role: string, grants: string[] = []) {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role });
    for (const key of grants) {
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: key });
    }
  }

  it("uses the same task-assignment decision as the task routes: a protected or private investigator, or a viewer, is refused", async () => {
    const companyId = await seedCompany();
    const protectedAgent = await seedAgent(companyId, {
      name: "Guarded",
      permissions: { authorizationPolicy: { protectedAgent: { requiresApproval: true } } },
    });
    await setUp(companyId, protectedAgent);
    await seedMember(companyId, "olga", "operator");
    await seedMember(companyId, "vera", "viewer");
    const { svc, wakeup } = service();

    const needsApproval = await svc.start({ companyId, actor: person("olga", companyId, "operator"), question: "Hi" }).catch((e: unknown) => e);
    expect(needsApproval).toMatchObject({ status: 403 });
    expect((needsApproval as Error).message).toContain('"Guarded" is protected: giving it new work needs an approval first');
    expect((await svc.availability(companyId, person("olga", companyId, "operator"), { canConfigure: false })).problemCode).toBe("assign_denied");

    await db
      .update(agents)
      .set({ permissions: { authorizationPolicy: { agentVisibility: { mode: "private" } } } })
      .where(eq(agents.id, protectedAgent));
    const priv = await svc.start({ companyId, actor: person("olga", companyId, "operator"), question: "Hi" }).catch((e: unknown) => e);
    expect((priv as Error).message).toContain("only takes work from people with a special right");

    await db.update(agents).set({ permissions: {} }).where(eq(agents.id, protectedAgent));
    const viewer = await svc.start({ companyId, actor: person("vera", companyId, "viewer"), question: "Hi" }).catch((e: unknown) => e);
    expect(viewer).toMatchObject({ status: 403 });
    expect((viewer as Error).message).toContain("You do not have the right to give work to agents in this company");

    // An ordinary operator may.
    await expect(svc.start({ companyId, actor: person("olga", companyId, "operator"), question: "Hi" })).resolves.toMatchObject({ status: "queued" });
    expect(await db.select().from(issues)).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("leaves out marked records the person cannot see (and scrubs them from the text), and refuses a picture from a task they cannot open", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await setUp(companyId, agentId);
    // An "Employee (light)" member who was given the right to assign work, but sees no tasks.
    await seedMember(companyId, "erik", "employee", ["tasks:assign"]);
    const erik = person("erik", companyId, "employee");
    const [secretTask] = await db.insert(issues).values({ companyId, title: "Salary review", status: "todo" }).returning();
    const otherCompanyId = await seedCompany("Other");
    const [foreignTask] = await db.insert(issues).values({ companyId: otherCompanyId, title: "Theirs", status: "todo" }).returning();
    const store = fakeStorage();
    const { svc } = service({ storage: store.storage });

    const view = await svc.start({
      companyId,
      actor: erik,
      question: `What is in issue:${secretTask!.id}?`,
      context: `Records: issue:${secretTask!.id}, issue:${foreignTask!.id}`,
      references: [`issue:${secretTask!.id}`, `issue:${foreignTask!.id}`, "widget:123"],
    });
    expect(view.droppedReferences).toEqual([
      { reference: `issue:${secretTask!.id}`, reason: "you do not have access to it" },
      { reference: `issue:${foreignTask!.id}`, reason: "it is not in this company" },
      { reference: "widget:123", reason: "Paperclip cannot check who may see this kind of record" },
    ]);
    const [task] = await db.select().from(issues).where(eq(issues.id, view.id));
    expect(task!.description).not.toContain(secretTask!.id);
    expect(task!.description).not.toContain(foreignTask!.id);
    expect(task!.description).toContain("[a record left out]");
    expect(task!.description).not.toContain("Records they marked");
    const [activity] = await db.select().from(activityLog).where(eq(activityLog.entityId, view.id));
    expect((activity!.details as { droppedReferences: string[] }).droppedReferences).toHaveLength(3);

    // A picture from Files that belongs to a task Erik cannot open is refused, before anything is made.
    const [asset] = await db
      .insert(assets)
      .values({ companyId, provider: "local_disk", objectKey: `${companyId}/x.png`, contentType: "image/png", byteSize: 10, sha256: "x" })
      .returning();
    const [file] = await db.insert(issueAttachments).values({ companyId, issueId: secretTask!.id, assetId: asset!.id }).returning();
    const refused = await svc
      .start({ companyId, actor: erik, question: "What is in this picture?", pictures: [{ kind: "file", fileId: file!.id }] })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 403 });
    expect((refused as { details: { code: string } }).details.code).toBe("HELPER_PICTURE_NOT_VISIBLE");
    expect(await db.select().from(issues).where(eq(issues.originKind, HELPER_INVESTIGATION_ORIGIN_KIND))).toHaveLength(1);
    expect(store.putFile).not.toHaveBeenCalled();

    // The quick helper (Phase 2) applies the same rule to a picked picture.
    const create = vi.fn();
    const asked = await helperService(db, { createModelClient: () => ({ messages: { create } }) as never })
      .ask({ companyId, userId: "erik", actor: erik, message: "What is this?", pictures: [{ kind: "file", fileId: file!.id }] })
      .catch((e: unknown) => e);
    expect(asked).toMatchObject({ status: 403 });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an investigator that can change things unless an owner/admin confirmed exactly that, and checks again at every start", async () => {
    const companyId = await seedCompany();
    const builder = await seedAgent(companyId, { name: "Builder" });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: builder, status: "active", membershipRole: "member" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: builder, permissionKey: "deploys:request" });
    const [modelKey] = await db.insert(companySecrets).values({ companyId, key: "claude", name: "Claude login" }).returning();
    const [github] = await db.insert(companySecrets).values({ companyId, key: "gh", name: "GitHub" }).returning();
    await db.insert(companySecretBindings).values([
      { companyId, secretId: modelKey!.id, targetType: "agent", targetId: builder, configPath: "env.CLAUDE_CODE_OAUTH_TOKEN" },
      { companyId, secretId: github!.id, targetType: "agent", targetId: builder, configPath: "env.GITHUB_TOKEN" },
    ]);
    const settings = helperService(db);

    const refused = await settings.updateSettings(companyId, { investigationAgentId: builder }, { userId: "filip" }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 422 });
    expect((refused as { details: { code: string; capabilities: string[] } }).details).toMatchObject({
      code: "HELPER_INVESTIGATOR_CAN_WRITE",
      capabilities: ["can ask for deploys", "has secrets besides its model login (GITHUB_TOKEN)"],
    });
    expect((refused as Error).message).toContain("I understand this agent can change things and text on screen could try to make it do so.");
    expect(await db.select().from(companyHelperSettings)).toHaveLength(0);

    await settings.updateSettings(companyId, { investigationAgentId: builder, acknowledgeInvestigatorCanWrite: true }, { userId: "filip" });
    const view = await settings.getSettings(companyId, { canEdit: true });
    expect(view.investigationAgent).toMatchObject({ id: builder, writeAcknowledged: true, budgetMonthlyCents: 0 });
    expect(view.investigationAgent!.writeCapabilities).toHaveLength(2);
    const { svc } = service();
    await expect(svc.start({ companyId, actor: local("maria"), question: "Safe?" })).resolves.toMatchObject({ status: "queued" });

    // Rights added after the confirmation: refused again until someone confirms the new list.
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: builder, permissionKey: "merges:request" });
    const again = await svc.start({ companyId, actor: local("maria"), question: "Again?" }).catch((e: unknown) => e);
    expect(again).toMatchObject({ status: 422 });
    expect((again as Error).message).toContain("more than when it was picked");
    expect((await settings.getSettings(companyId, { canEdit: true })).investigationAgent?.writeAcknowledged).toBe(false);
    await settings.updateSettings(companyId, { acknowledgeInvestigatorCanWrite: true }, { userId: "filip" });
    await expect(svc.start({ companyId, actor: local("maria"), question: "Again?" })).resolves.toMatchObject({ status: "queued" });

    // A legacy "can create agents" agent counts too; a model login alone does not.
    const reader = await seedAgent(companyId, { name: "Reader" });
    await db.insert(companySecretBindings).values({ companyId, secretId: modelKey!.id, targetType: "agent", targetId: reader, configPath: "env.ANTHROPIC_API_KEY" });
    await settings.updateSettings(companyId, { investigationAgentId: reader }, { userId: "filip" });
    expect((await settings.getSettings(companyId, { canEdit: true })).investigationAgent?.writeCapabilities).toEqual([]);
    const creator = await seedAgent(companyId, { name: "Creator", permissions: { canCreateAgents: true } });
    const legacy = await settings.updateSettings(companyId, { investigationAgentId: creator }, { userId: "filip" }).catch((e: unknown) => e);
    expect((legacy as { details: { capabilities: string[] } }).details.capabilities).toContain("can create agents and change their setup");
  });

  it("caps the whole company's investigations in 24 hours", async () => {
    const companyId = await seedCompany();
    await setUp(companyId, await seedAgent(companyId));
    await helperService(db).updateSettings(companyId, { investigationCompanyMaxPerDay: 2 }, { userId: "filip" });
    const { svc } = service();
    await svc.start({ companyId, actor: local("maria"), question: "One" });
    await svc.start({ companyId, actor: local("ola"), question: "Two" });
    const capped = await svc.start({ companyId, actor: local("kari"), question: "Three" }).catch((e: unknown) => e);
    expect(capped).toMatchObject({ status: 429 });
    expect((capped as Error).message).toContain("This company has started 2 investigations in the last 24 hours, the most it allows (2)");
    expect((await svc.availability(companyId, local("kari"), { canConfigure: true })).problemCode).toBe("limit_company_daily");
    expect((await helperService(db).getSettings(companyId, { canEdit: true })).investigationCompanyMaxPerDay).toBe(2);
  });

  it("cleans up after a start that fails half-way: no orphan pictures, and the task (never woken) is cancelled", async () => {
    const companyId = await seedCompany();
    await setUp(companyId, await seedAgent(companyId));
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#00ff00" } }).png().toBuffer();
    const upload = { kind: "upload" as const, name: "a.png", dataBase64: png.toString("base64") };

    // Storage fails on the second picture: the first is deleted again, nothing is made.
    const deleteObject = vi.fn(async () => undefined);
    let calls = 0;
    const flaky = {
      provider: "local_disk",
      deleteObject,
      putFile: vi.fn(async (input: { companyId: string; namespace: string }) => {
        calls += 1;
        if (calls === 2) throw new Error("disk full");
        return { provider: "local_disk", objectKey: `${input.companyId}/${input.namespace}/one.jpg`, contentType: "image/jpeg", byteSize: 3, sha256: "s", originalFilename: "x" };
      }),
    };
    const wakeup = vi.fn();
    const svc = helperInvestigationService(db, { heartbeat: { wakeup }, storage: () => flaky as never });
    await expect(svc.start({ companyId, actor: local("maria"), question: "Two pictures", pictures: [upload, upload] })).rejects.toThrow("disk full");
    expect(deleteObject).toHaveBeenCalledWith(companyId, expect.stringContaining("one.jpg"));
    expect(await db.select().from(issues)).toHaveLength(0);

    // The task is made but the attachment row cannot be written: pictures deleted, task cancelled, agent not woken.
    const broken = {
      provider: "local_disk",
      deleteObject,
      putFile: vi.fn(async () => ({ provider: "local_disk", objectKey: "k/broken.jpg", contentType: "image/jpeg", byteSize: 3, sha256: null, originalFilename: "x" })),
    };
    const svc2 = helperInvestigationService(db, { heartbeat: { wakeup }, storage: () => broken as never });
    await expect(svc2.start({ companyId, actor: local("maria"), question: "Broken", pictures: [upload] })).rejects.toBeTruthy();
    expect(deleteObject).toHaveBeenCalledWith(companyId, "k/broken.jpg");
    const made = await db.select().from(issues);
    expect(made).toHaveLength(1);
    expect(made[0]!.status).toBe("cancelled");
    expect(await db.select().from(issueAttachments)).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
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
