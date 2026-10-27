import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyAgentRoles,
  contractDeadlineReminders,
  contractDeadlines,
  contracts,
  createDb,
  issueComments,
  issues,
  runInCompanyScopeBypass,
} from "@paperclipai/db";
import { CONTRACT_DEADLINE_ORIGIN_KIND } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import {
  contractDeadlineReminderService,
  daysBetween,
  planReminderSteps,
  renderReminder,
  reminderPriority,
} from "../services/contract-deadline-reminders.js";

// Legal Phase 3 (DUR-4855).

describe("planReminderSteps", () => {
  const leads = [60, 30, 7];

  it("opens nothing before the first step is in range", () => {
    expect(planReminderSteps({ daysLeft: 61, leads, existing: [] })).toEqual({ stale: [], skipped: [], create: null });
  });

  it("opens the step that comes in range", () => {
    expect(planReminderSteps({ daysLeft: 60, leads, existing: [] })).toEqual({ stale: [], skipped: [], create: 60 });
    expect(planReminderSteps({ daysLeft: 30, leads, existing: [60] })).toEqual({ stale: [], skipped: [], create: 30 });
  });

  it("catches up with only the most urgent missed step", () => {
    expect(planReminderSteps({ daysLeft: 20, leads, existing: [] })).toEqual({ stale: [], skipped: [60], create: 30 });
    expect(planReminderSteps({ daysLeft: 3, leads, existing: [60] })).toEqual({ stale: [], skipped: [30], create: 7 });
    expect(planReminderSteps({ daysLeft: -4, leads, existing: [] })).toEqual({ stale: [], skipped: [60, 30], create: 7 });
  });

  it("does not reopen a less urgent step when a more urgent one is on record", () => {
    expect(planReminderSteps({ daysLeft: 3, leads: [60, 30, 7], existing: [7] })).toEqual({
      stale: [],
      skipped: [60, 30],
      create: null,
    });
  });

  it("marks steps stale when the date moves out of range or the step is removed", () => {
    expect(planReminderSteps({ daysLeft: 45, leads, existing: [60, 30, 7] })).toEqual({
      stale: [30, 7],
      skipped: [],
      create: null,
    });
    expect(planReminderSteps({ daysLeft: 5, leads: [30, 7], existing: [60, 7] })).toEqual({
      stale: [60],
      skipped: [30],
      create: null,
    });
  });

  it("ignores duplicate lead steps", () => {
    expect(planReminderSteps({ daysLeft: 7, leads: [7, 7, 30], existing: [] })).toEqual({
      stale: [],
      skipped: [30],
      create: 7,
    });
  });
});

describe("reminder text", () => {
  it("counts days between calendar dates", () => {
    expect(daysBetween("2027-01-01", "2027-01-31")).toBe(30);
    expect(daysBetween("2027-01-31", "2027-01-01")).toBe(-30);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
  });

  it("escalates priority as days run out", () => {
    expect(reminderPriority(60)).toBe("medium");
    expect(reminderPriority(14)).toBe("high");
    expect(reminderPriority(2)).toBe("critical");
    expect(reminderPriority(-1)).toBe("critical");
  });

  it("builds the title and a description with no contract text", () => {
    const rendered = renderReminder({
      contractId: "c1",
      contractTitle: "Office lease",
      kind: "notice_extend",
      dueDate: "2027-01-31",
      clauseRef: "§4.2",
      leadDays: 60,
      daysLeft: 60,
      needsOwner: true,
      todayIso: "2026-12-01",
    });
    expect(rendered.title).toBe("Contract deadline: Office lease - notice to extend by 31 Jan 2027 (60 days left)");
    expect(rendered.description).toContain("§4.2");
    expect(rendered.description).toMatch(/^Human action: .+$/m);
    expect(rendered.priority).toBe("medium");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const NOW = new Date("2026-11-01T06:00:00Z");
const addDays = (days: number, from = NOW) => new Date(from.getTime() + days * 86_400_000);
const iso = (date: Date) => date.toISOString().slice(0, 10);

d("contract deadline reminder sweep (DUR-4855)", () => {
  let stop: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof contractDeadlineReminderService>;
  const wakeups: Array<{ agentId: string }> = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("contract-deadline-reminders");
    stop = started.cleanup;
    db = createDb(started.connectionString);
    svc = contractDeadlineReminderService(db, {
      heartbeat: {
        wakeup: async (agentId) => {
          wakeups.push({ agentId });
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  });

  async function makeCompany(overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Co ${id.slice(0, 6)}`,
      issuePrefix: `R${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      ...overrides,
    } as never);
    return id;
  }

  async function makeLegalAgent(companyId: string, status = "idle") {
    const roleId = randomUUID();
    await db.insert(companyAgentRoles).values({ id: roleId, companyId, name: "Legal Advisor", key: "legal-advisor" });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legal",
      role: "general",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      roleId,
    } as never);
    return agentId;
  }

  async function makeContract(companyId: string, overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    await db.insert(contracts).values({
      id,
      companyId,
      title: "Office lease",
      type: "rental_lease",
      extractedText: "SECRET CLAUSE TEXT the landlord may raise rent",
      summary: "SECRET SUMMARY",
      ...overrides,
    } as never);
    return id;
  }

  async function makeDeadline(
    companyId: string,
    contractId: string,
    dueDate: string,
    overrides: Record<string, unknown> = {},
  ) {
    const id = randomUUID();
    await db.insert(contractDeadlines).values({
      id,
      companyId,
      contractId,
      kind: "notice_extend",
      dueDate,
      leadTimesDays: [60, 30, 7],
      clauseRef: "§4.2",
      needsOwner: false,
      note: "SECRET NOTE",
      ...overrides,
    } as never);
    return id;
  }

  const sweep = (now: Date, companyIds?: string[]) => svc.sweep({ now, companyIds });

  async function remindersFor(deadlineId: string) {
    return db
      .select()
      .from(contractDeadlineReminders)
      .where(eq(contractDeadlineReminders.deadlineId, deadlineId))
      .then((rows) => rows.sort((a, b) => b.leadDays - a.leadDays));
  }

  async function issuesFor(deadlineId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.originKind, CONTRACT_DEADLINE_ORIGIN_KIND), eq(issues.originId, deadlineId)));
  }

  it("opens one reminder per lead step as each comes in range, and none twice (sweep twice)", async () => {
    const companyId = await makeCompany();
    const contractId = await makeContract(companyId);
    const deadlineId = await makeDeadline(companyId, contractId, iso(addDays(100)));

    // 100 days out: nothing yet.
    await sweep(NOW, [companyId]);
    expect(await issuesFor(deadlineId)).toHaveLength(0);

    // 60 days left: the first step opens, once, even if the sweep ticks again.
    const day40 = addDays(40);
    const first = await sweep(day40, [companyId]);
    expect(first.created).toBe(1);
    const again = await sweep(day40, [companyId]);
    expect(again.created).toBe(0);
    expect(await issuesFor(deadlineId)).toHaveLength(1);
    expect((await remindersFor(deadlineId)).map((r) => r.leadDays)).toEqual([60]);

    // Later steps add their own issue, each exactly once.
    await sweep(addDays(70), [companyId]);
    await sweep(addDays(70), [companyId]);
    await sweep(addDays(93), [companyId]);
    await sweep(addDays(93), [companyId]);
    const all = await issuesFor(deadlineId);
    expect(all).toHaveLength(3);
    expect(all.map((i) => i.originFingerprint).sort()).toEqual(
      [`${deadlineId}:30`, `${deadlineId}:60`, `${deadlineId}:7`].sort(),
    );
    expect((await remindersFor(deadlineId)).every((r) => r.issueId)).toBe(true);
  });

  it("survives a restart: a fresh service instance reaches the same state", async () => {
    const companyId = await makeCompany();
    const contractId = await makeContract(companyId);
    const deadlineId = await makeDeadline(companyId, contractId, iso(addDays(25)));
    await sweep(NOW, [companyId]);
    const restarted = contractDeadlineReminderService(db);
    const result = await restarted.sweep({ now: NOW, companyIds: [companyId] });
    expect(result.created).toBe(0);
    expect(await issuesFor(deadlineId)).toHaveLength(1);
  });

  it("catches up with the most urgent missed step only", async () => {
    const companyId = await makeCompany();
    const contractId = await makeContract(companyId);
    const deadlineId = await makeDeadline(companyId, contractId, iso(addDays(20)));
    await sweep(NOW, [companyId]);
    const opened = await issuesFor(deadlineId);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.originFingerprint).toBe(`${deadlineId}:30`);
    const rows = await remindersFor(deadlineId);
    expect(rows.map((r) => [r.leadDays, Boolean(r.issueId)])).toEqual([
      [60, false],
      [30, true],
    ]);
    // The skipped step never opens later.
    await sweep(addDays(1), [companyId]);
    expect(await issuesFor(deadlineId)).toHaveLength(1);
  });

  it("sets due date, escalating priority and a title without contract text", async () => {
    const companyId = await makeCompany();
    const contractId = await makeContract(companyId);
    const due = iso(addDays(60));
    const deadlineId = await makeDeadline(companyId, contractId, due);
    await sweep(NOW, [companyId]);
    const [issue] = await issuesFor(deadlineId);
    expect(issue!.dueDate).toBe(due);
    expect(issue!.priority).toBe("medium");
    expect(issue!.title).toMatch(/^Contract deadline: Office lease - notice to extend by .+ \(60 days left\)$/);
    expect(issue!.description).toContain(contractId);
    expect(issue!.description).toContain("§4.2");
    for (const text of [issue!.title, issue!.description ?? ""]) {
      expect(text).not.toContain("SECRET");
    }

    // Closer to the date the same issue is retitled and its priority only goes up.
    await sweep(addDays(55), [companyId]);
    const reread = (await issuesFor(deadlineId)).find((i) => i.id === issue!.id)!;
    expect(reread.title).toContain("5 days left");
    expect(reread.priority).toBe("high");
  });

  it("assigns the company's Legal agent and wakes it; unassigned and visible when there is none", async () => {
    const withLegal = await makeCompany();
    const legalId = await makeLegalAgent(withLegal);
    const without = await makeCompany();
    const dueA = await makeDeadline(withLegal, await makeContract(withLegal), iso(addDays(25)));
    const dueB = await makeDeadline(without, await makeContract(without), iso(addDays(25)));
    wakeups.length = 0;
    await sweep(NOW, [withLegal, without]);
    const [a] = await issuesFor(dueA);
    const [b] = await issuesFor(dueB);
    expect(a!.assigneeAgentId).toBe(legalId);
    expect(a!.status).toBe("todo");
    expect(b!.assigneeAgentId).toBeNull();
    expect(b!.assigneeUserId).toBeNull();
    expect(b!.status).toBe("todo");
    expect(wakeups.map((w) => w.agentId)).toEqual([legalId]);
  });

  it("ignores a terminated Legal agent", async () => {
    const companyId = await makeCompany();
    await makeLegalAgent(companyId, "terminated");
    const deadlineId = await makeDeadline(companyId, await makeContract(companyId), iso(addDays(25)));
    await sweep(NOW, [companyId]);
    const [issue] = await issuesFor(deadlineId);
    expect(issue).toBeTruthy();
    expect(issue!.assigneeAgentId).toBeNull();
  });

  it("puts an owner decision on the Needs-you path via the human-action marker", async () => {
    const companyId = await makeCompany();
    const legalId = await makeLegalAgent(companyId);
    const deadlineId = await makeDeadline(companyId, await makeContract(companyId), iso(addDays(25)), {
      needsOwner: true,
    });
    wakeups.length = 0;
    await sweep(NOW, [companyId]);
    const [issue] = await issuesFor(deadlineId);
    expect(issue!.status).toBe("blocked");
    expect(issue!.assigneeAgentId).toBe(legalId);
    expect(issue!.description).toMatch(/^Human action: .+$/m);
    expect(wakeups).toHaveLength(0);
  });

  it("closes open reminders when the deadline is marked done, dismissed or superseded", async () => {
    for (const state of ["done", "dismissed", "superseded"] as const) {
      const companyId = await makeCompany();
      const deadlineId = await makeDeadline(companyId, await makeContract(companyId), iso(addDays(25)));
      await sweep(NOW, [companyId]);
      expect((await issuesFor(deadlineId))[0]!.status).toBe("todo");
      await db.update(contractDeadlines).set({ state }).where(eq(contractDeadlines.id, deadlineId));
      await svc.syncDeadline(companyId, deadlineId, NOW);
      const [issue] = await issuesFor(deadlineId);
      expect(issue!.status).toBe("cancelled");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issue!.id));
      expect(comments.some((c) => c.authorType === "system" && c.body.startsWith("Closed automatically"))).toBe(true);
      expect(await remindersFor(deadlineId)).toHaveLength(0);
      // The sweep leaves a closed deadline alone from then on.
      expect((await sweep(addDays(1), [companyId])).created).toBe(0);
    }
  });

  it("also closes the reminders when a deadline was closed behind the service's back", async () => {
    const companyId = await makeCompany();
    const deadlineId = await makeDeadline(companyId, await makeContract(companyId), iso(addDays(25)));
    await sweep(NOW, [companyId]);
    await db.update(contractDeadlines).set({ state: "done" }).where(eq(contractDeadlines.id, deadlineId));
    const swept = await sweep(NOW, [companyId]);
    expect(swept.closed).toBe(1);
    expect((await issuesFor(deadlineId))[0]!.status).toBe("cancelled");
  });

  it("does not touch a reminder a person already finished", async () => {
    const companyId = await makeCompany();
    const deadlineId = await makeDeadline(companyId, await makeContract(companyId), iso(addDays(25)));
    await sweep(NOW, [companyId]);
    await db.update(issues).set({ status: "done" }).where(eq(issues.originId, deadlineId));
    await db.update(contractDeadlines).set({ state: "done" }).where(eq(contractDeadlines.id, deadlineId));
    await sweep(NOW, [companyId]);
    expect((await issuesFor(deadlineId))[0]!.status).toBe("done");
  });

  it("re-computes the steps when the date changes, without duplicating", async () => {
    const companyId = await makeCompany();
    const contractId = await makeContract(companyId);
    const deadlineId = await makeDeadline(companyId, contractId, iso(addDays(25)));
    await sweep(NOW, [companyId]);
    const [first] = await issuesFor(deadlineId);
    expect(first!.originFingerprint).toBe(`${deadlineId}:30`);

    // Moved out to 90 days: the 30-day reminder no longer applies and is closed.
    const farDue = iso(addDays(90));
    await db.update(contractDeadlines).set({ dueDate: farDue }).where(eq(contractDeadlines.id, deadlineId));
    await svc.syncDeadline(companyId, deadlineId, NOW);
    expect((await issuesFor(deadlineId)).map((i) => i.status)).toEqual(["cancelled"]);
    expect(await remindersFor(deadlineId)).toHaveLength(0);

    // The new date's steps open when they come in range, once each.
    await sweep(addDays(30), [companyId]);
    await sweep(addDays(30), [companyId]);
    const live = (await issuesFor(deadlineId)).filter((i) => i.status !== "cancelled");
    expect(live).toHaveLength(1);
    expect(live[0]!.originFingerprint).toBe(`${deadlineId}:60`);
    expect(live[0]!.dueDate).toBe(farDue);

    // A small move inside the same step updates the open issue in place.
    const nearer = iso(addDays(88));
    await db.update(contractDeadlines).set({ dueDate: nearer }).where(eq(contractDeadlines.id, deadlineId));
    await svc.syncDeadline(companyId, deadlineId, addDays(30));
    const moved = (await issuesFor(deadlineId)).filter((i) => i.status !== "cancelled");
    expect(moved).toHaveLength(1);
    expect(moved[0]!.id).toBe(live[0]!.id);
    expect(moved[0]!.dueDate).toBe(nearer);
    expect(moved[0]!.description).toContain(nearer);

    // Moved earlier into closer steps: only the most urgent missed step opens
    // (the 30-day step is recorded as skipped), next to the 60-day one already open.
    await db.update(contractDeadlines).set({ dueDate: iso(addDays(35)) }).where(eq(contractDeadlines.id, deadlineId));
    await svc.syncDeadline(companyId, deadlineId, addDays(30));
    const open = (await issuesFor(deadlineId)).filter((i) => i.status !== "cancelled");
    expect(open.map((i) => i.originFingerprint).sort()).toEqual([`${deadlineId}:60`, `${deadlineId}:7`].sort());
    expect((await remindersFor(deadlineId)).map((r) => [r.leadDays, Boolean(r.issueId)])).toEqual([
      [60, true],
      [30, false],
      [7, true],
    ]);
  });

  it("never mixes companies: each issue lives in its own company, with its own Legal agent", async () => {
    const durkan = await makeCompany();
    const nordstrand = await makeCompany();
    const durkanLegal = await makeLegalAgent(durkan);
    const nordLegal = await makeLegalAgent(nordstrand);
    const durkanDeadline = await makeDeadline(durkan, await makeContract(durkan, { title: "Durkan lease" }), iso(addDays(25)));
    const nordDeadline = await makeDeadline(
      nordstrand,
      await makeContract(nordstrand, { title: "Nordstrand lease" }),
      iso(addDays(25)),
    );
    wakeups.length = 0;
    await sweep(NOW, [durkan, nordstrand]);
    const [a] = await issuesFor(durkanDeadline);
    const [b] = await issuesFor(nordDeadline);
    expect(a!.companyId).toBe(durkan);
    expect(a!.assigneeAgentId).toBe(durkanLegal);
    expect(a!.title).toContain("Durkan lease");
    expect(b!.companyId).toBe(nordstrand);
    expect(b!.assigneeAgentId).toBe(nordLegal);
    expect(b!.title).toContain("Nordstrand lease");
    expect(wakeups.map((w) => w.agentId).sort()).toEqual([durkanLegal, nordLegal].sort());
  });

  it("restricting the sweep to one company leaves the other untouched", async () => {
    const one = await makeCompany();
    const two = await makeCompany();
    const d1 = await makeDeadline(one, await makeContract(one), iso(addDays(25)));
    const d2 = await makeDeadline(two, await makeContract(two), iso(addDays(25)));
    await sweep(NOW, [one]);
    expect(await issuesFor(d1)).toHaveLength(1);
    expect(await issuesFor(d2)).toHaveLength(0);
  });

  it("creates nothing for a deadline whose contract is not in the deadline's company", async () => {
    const own = await makeCompany();
    const foreign = await makeCompany();
    const foreignContract = await makeContract(foreign);
    // Inconsistent row (should not be reachable through the API): contract of another company.
    const deadlineId = await makeDeadline(own, foreignContract, iso(addDays(25)));
    const result = await sweep(NOW, [own]);
    expect(result.created).toBe(0);
    expect(await issuesFor(deadlineId)).toHaveLength(0);
  });

  it("creates nothing for an inactive company or a superseded contract", async () => {
    const paused = await makeCompany({ status: "paused" });
    const pausedDeadline = await makeDeadline(paused, await makeContract(paused), iso(addDays(25)));
    const live = await makeCompany();
    const oldVersion = await makeContract(live, { status: "superseded" });
    const supersededDeadline = await makeDeadline(live, oldVersion, iso(addDays(25)));
    await sweep(NOW, [paused, live]);
    expect(await issuesFor(pausedDeadline)).toHaveLength(0);
    expect(await issuesFor(supersededDeadline)).toHaveLength(0);
  });

  it("adopts an issue left behind by a sweep that died before recording its row", async () => {
    const companyId = await makeCompany();
    const deadlineId = await makeDeadline(companyId, await makeContract(companyId), iso(addDays(25)));
    await sweep(NOW, [companyId]);
    const [issue] = await issuesFor(deadlineId);
    await db.delete(contractDeadlineReminders).where(eq(contractDeadlineReminders.deadlineId, deadlineId));
    const result = await sweep(NOW, [companyId]);
    expect(result.created).toBe(0);
    expect(await issuesFor(deadlineId)).toHaveLength(1);
    expect((await remindersFor(deadlineId)).find((r) => r.leadDays === 30)?.issueId).toBe(issue!.id);
  });

  it("two sweeps racing open one issue", async () => {
    const companyId = await makeCompany();
    const deadlineId = await makeDeadline(companyId, await makeContract(companyId), iso(addDays(25)));
    await Promise.all([sweep(NOW, [companyId]), sweep(NOW, [companyId])]);
    expect(await issuesFor(deadlineId)).toHaveLength(1);
  });

  it("writes activity with ids and counts only", async () => {
    const companyId = await makeCompany();
    const deadlineId = await makeDeadline(companyId, await makeContract(companyId), iso(addDays(25)));
    await sweep(NOW, [companyId]);
    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const opened = rows.filter((r) => r.action === "contract.deadline_reminder_opened");
    expect(opened).toHaveLength(1);
    const serialised = JSON.stringify(opened[0]!.details);
    expect(serialised).toContain(deadlineId);
    expect(serialised).not.toContain("Office lease");
    expect(serialised).not.toContain("SECRET");
  });

  it("closeForDeadline cancels the open reminders before a deadline is deleted", async () => {
    const companyId = await makeCompany();
    const deadlineId = await makeDeadline(companyId, await makeContract(companyId), iso(addDays(25)));
    await sweep(NOW, [companyId]);
    expect(await svc.closeForDeadline(companyId, deadlineId)).toBe(1);
    await db.delete(contractDeadlines).where(eq(contractDeadlines.id, deadlineId));
    expect((await issuesFor(deadlineId)).map((i) => i.status)).toEqual(["cancelled"]);
  });

  it("works under the scheduler's company-scope bypass", async () => {
    const companyId = await makeCompany();
    const deadlineId = await makeDeadline(companyId, await makeContract(companyId), iso(addDays(25)));
    const result = await runInCompanyScopeBypass(
      db,
      { reason: "test", actorType: "scheduler", route: "heartbeat-scheduler:contractDeadlineReminders" },
      () => svc.sweep({ now: NOW, companyIds: [companyId] }),
    );
    expect(result.created).toBe(1);
    expect(await issuesFor(deadlineId)).toHaveLength(1);
  });

  it("issues carry a due date through create, update and list", async () => {
    const companyId = await makeCompany();
    const issuesSvc = issueService(db);
    const created = await issuesSvc.create(companyId, { title: "Pay the invoice", status: "todo", dueDate: "2027-01-31" });
    expect(created.dueDate).toBe("2027-01-31");
    const updated = await issuesSvc.update(created.id, { dueDate: "2027-02-15" });
    expect(updated?.dueDate).toBe("2027-02-15");
    const listed = await issuesSvc.list(companyId, {});
    expect(listed.find((i) => i.id === created.id)?.dueDate).toBe("2027-02-15");
    const cleared = await issuesSvc.update(created.id, { dueDate: null });
    expect(cleared?.dueDate).toBeNull();
    const plain = await issuesSvc.create(companyId, { title: "No date", status: "todo" });
    expect(plain.dueDate).toBeNull();
  });
});
