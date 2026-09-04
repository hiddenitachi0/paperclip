import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, goals, issues } from "@paperclipai/db";
import { goalAdoptionService } from "../services/goal-adoption.ts";
import { parseGoalAdoptionTrendDays } from "../routes/goal-adoption.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

describe("parseGoalAdoptionTrendDays", () => {
  it("returns undefined when no 'days' query param is present", () => {
    expect(parseGoalAdoptionTrendDays({})).toBeUndefined();
    expect(parseGoalAdoptionTrendDays({ days: "" })).toBeUndefined();
  });

  it("parses a valid numeric string", () => {
    expect(parseGoalAdoptionTrendDays({ days: "14" })).toBe(14);
  });

  it("rejects non-numeric, zero/negative, and out-of-range values", () => {
    expect(() => parseGoalAdoptionTrendDays({ days: "not-a-number" })).toThrow();
    expect(() => parseGoalAdoptionTrendDays({ days: "0" })).toThrow();
    expect(() => parseGoalAdoptionTrendDays({ days: "-5" })).toThrow();
    expect(() => parseGoalAdoptionTrendDays({ days: "181" })).toThrow();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("goalAdoptionService", () => {
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof goalAdoptionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goal-adoption-service-");
    db = createDb(tempDb.connectionString);
    service = goalAdoptionService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Durkan",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("returns zeroed counts for a company with no issues", async () => {
    const companyId = await makeCompany();
    const snapshot = await service.snapshot(companyId);
    expect(snapshot).toEqual({
      companyId,
      totalIssues: 0,
      withGoal: 0,
      withoutGoal: 0,
      adoptionPercent: 0,
    });
  });

  it("counts issues with and without a goalId, excluding hidden issues, scoped to the company", async () => {
    const companyId = await makeCompany();
    const otherCompanyId = await makeCompany();
    const [goal] = await db.insert(goals).values({ companyId, title: "Ship DUR-315" }).returning();

    await db.insert(issues).values([
      { companyId, title: "Linked 1", goalId: goal!.id },
      { companyId, title: "Linked 2", goalId: goal!.id },
      { companyId, title: "Unlinked 1", goalId: null },
      { companyId, title: "Hidden but linked", goalId: goal!.id, hiddenAt: new Date() },
      { companyId: otherCompanyId, title: "Other company issue", goalId: null },
    ]);

    const snapshot = await service.snapshot(companyId);
    expect(snapshot).toEqual({
      companyId,
      totalIssues: 3,
      withGoal: 2,
      withoutGoal: 1,
      adoptionPercent: 66.67,
    });

    const otherSnapshot = await service.snapshot(otherCompanyId);
    expect(otherSnapshot).toEqual({
      companyId: otherCompanyId,
      totalIssues: 1,
      withGoal: 0,
      withoutGoal: 1,
      adoptionPercent: 0,
    });
  });

  it("builds a cumulative daily trend from issue creation dates and current goalId", async () => {
    const companyId = await makeCompany();
    const [goal] = await db.insert(goals).values({ companyId, title: "Ship DUR-315" }).returning();

    // One issue created 5 days ago without a goal, one created 2 days ago
    // with a goal, one created today without a goal.
    await db.insert(issues).values([
      { companyId, title: "Old, unlinked", goalId: null, createdAt: daysAgo(5) },
      { companyId, title: "Recent, linked", goalId: goal!.id, createdAt: daysAgo(2) },
      { companyId, title: "Today, unlinked", goalId: null, createdAt: daysAgo(0) },
    ]);

    const trend = await service.trend(companyId, { days: 7 });
    expect(trend).toHaveLength(7);

    const byDate = new Map(trend.map((row) => [row.date, row]));
    const today = new Date().toISOString().slice(0, 10);
    const sixDaysAgoKey = daysAgo(6).toISOString().slice(0, 10);
    const fiveDaysAgoKey = daysAgo(5).toISOString().slice(0, 10);
    const threeDaysAgoKey = daysAgo(3).toISOString().slice(0, 10);
    const twoDaysAgoKey = daysAgo(2).toISOString().slice(0, 10);

    // Before the first issue existed: nothing yet.
    expect(byDate.get(sixDaysAgoKey)).toMatchObject({ totalIssues: 0, withGoal: 0, adoptionPercent: 0 });
    // The old unlinked issue now exists; still nothing linked.
    expect(byDate.get(fiveDaysAgoKey)).toMatchObject({ totalIssues: 1, withGoal: 0, adoptionPercent: 0 });
    expect(byDate.get(threeDaysAgoKey)).toMatchObject({ totalIssues: 1, withGoal: 0, adoptionPercent: 0 });
    // The linked issue lands.
    expect(byDate.get(twoDaysAgoKey)).toMatchObject({ totalIssues: 2, withGoal: 1, adoptionPercent: 50 });
    // Today: the third (unlinked) issue lands too.
    expect(byDate.get(today)).toMatchObject({ totalIssues: 3, withGoal: 1, adoptionPercent: 33.33 });

    // Dates are ascending and cover exactly the requested window.
    expect(trend[0]!.date).toBe(sixDaysAgoKey);
    expect(trend[trend.length - 1]!.date).toBe(today);
  });

  it("clamps a below-range days option up to 1 and an undefined option to the 30-day default", async () => {
    const companyId = await makeCompany();
    const clamped = await service.trend(companyId, { days: 0 });
    expect(clamped).toHaveLength(1);

    const defaulted = await service.trend(companyId, {});
    expect(defaulted).toHaveLength(30);
  });
});
