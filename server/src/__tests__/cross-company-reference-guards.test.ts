import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  goals,
  issues as issuesTable,
  projectGoals,
  projects as projectsTable,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { goalService } from "../services/goals.js";
import { issueService } from "../services/issues.js";
import { projectService } from "../services/projects.js";

/**
 * The two cross-company reference holes the isolation sweep
 * (cross-company-isolation-sweep.test.ts) found, pinned at the service level:
 * a project or goal in company A could point at company B's goal or agent,
 * because the foreign keys do not carry the company. Also pins that such
 * links written before the guard existed are ignored: by project reads, by
 * the goal a new or moved issue inherits from its project, and by the issue
 * reads (ancestors, issue detail, heartbeat context). See
 * docs/security/cross-company-isolation.md.
 */

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("cross-company reference guards (projects, goals)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tenant = { a: "", b: "", goalA: "", goalB: "", agentA: "", agentB: "" };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-company-refs-");
    db = createDb(tempDb.connectionString);
    for (const key of ["a", "b"] as const) {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: `Company ${key}`,
        issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      });
      const [goal] = await db
        .insert(goals)
        .values({ companyId, title: `Goal ${key}`, description: `Goal ${key} secret description` })
        .returning();
      const agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: `Agent ${key}`, role: "general", status: "idle" });
      tenant[key] = companyId;
      tenant[key === "a" ? "goalA" : "goalB"] = goal!.id;
      tenant[key === "a" ? "agentA" : "agentB"] = agentId;
    }
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("refuses a project in A that links B's goal or lead agent, on create and update", async () => {
    const projects = projectService(db);
    await expect(projects.create(tenant.a, { name: "p1", goalIds: [tenant.goalB] })).rejects.toThrow(/same company/);
    await expect(projects.create(tenant.a, { name: "p2", goalId: tenant.goalB })).rejects.toThrow(/same company/);
    await expect(projects.create(tenant.a, { name: "p3", leadAgentId: tenant.agentB })).rejects.toThrow(/same company/);

    const ok = await projects.create(tenant.a, { name: "p4", goalIds: [tenant.goalA], leadAgentId: tenant.agentA });
    expect(ok.goalIds).toEqual([tenant.goalA]);
    await expect(projects.update(ok.id, { goalIds: [tenant.goalA, tenant.goalB] })).rejects.toThrow(/same company/);
    await expect(projects.update(ok.id, { leadAgentId: tenant.agentB })).rejects.toThrow(/same company/);
    const unchanged = await projects.update(ok.id, { description: "still fine" });
    expect(unchanged?.goalIds).toEqual([tenant.goalA]);
  });

  it("refuses a goal in A whose parent goal or owner agent is B's, on create and update", async () => {
    const goalsSvc = goalService(db);
    await expect(goalsSvc.create(tenant.a, { title: "g1", parentId: tenant.goalB })).rejects.toThrow(/same company/);
    await expect(goalsSvc.create(tenant.a, { title: "g2", ownerAgentId: tenant.agentB })).rejects.toThrow(/same company/);

    const ok = await goalsSvc.create(tenant.a, { title: "g3", parentId: tenant.goalA, ownerAgentId: tenant.agentA });
    expect(ok!.parentId).toBe(tenant.goalA);
    await expect(goalsSvc.update(ok!.id, { parentId: tenant.goalB })).rejects.toThrow(/same company/);
    await expect(goalsSvc.update(ok!.id, { ownerAgentId: tenant.agentB })).rejects.toThrow(/same company/);
    expect((await goalsSvc.update(ok!.id, { parentId: null }))?.parentId).toBeNull();
  });

  it("drops links to B that were written before the guard existed, on every project read", async () => {
    // Simulate rows the old code could write: bypass the service guard and
    // insert A projects that point at B's goal and B's agent directly.
    const [legacy] = await db
      .insert(projectsTable)
      .values({ companyId: tenant.a, name: "legacy-cross", goalId: tenant.goalB, leadAgentId: tenant.agentB })
      .returning();
    await db.insert(projectGoals).values({ projectId: legacy!.id, goalId: tenant.goalB, companyId: tenant.a });
    // A mixed project keeps its own goal and loses only B's. One link row even
    // claims B's company, which must not make it count as A's.
    const [mixed] = await db
      .insert(projectsTable)
      .values({ companyId: tenant.a, name: "mixed-cross", goalId: tenant.goalA, leadAgentId: tenant.agentA })
      .returning();
    await db.insert(projectGoals).values([
      { projectId: mixed!.id, goalId: tenant.goalA, companyId: tenant.a },
      { projectId: mixed!.id, goalId: tenant.goalB, companyId: tenant.b },
    ]);

    const projects = projectService(db);
    const reads = {
      list: await projects.list(tenant.a),
      listByIds: await projects.listByIds(tenant.a, [legacy!.id, mixed!.id]),
      getById: [await projects.getById(legacy!.id), await projects.getById(mixed!.id)],
    };
    for (const [how, rows] of Object.entries(reads)) {
      const text = JSON.stringify(rows);
      expect(text, `${how} must not carry B's goal id`).not.toContain(tenant.goalB);
      expect(text, `${how} must not carry B's goal title`).not.toContain("Goal b");
      expect(text, `${how} must not carry B's agent id`).not.toContain(tenant.agentB);
    }
    expect(reads.list.map((p) => p.id)).toEqual(expect.arrayContaining([legacy!.id, mixed!.id]));

    const legacyRead = reads.getById[0]!;
    expect(legacyRead.goalIds).toEqual([]);
    expect(legacyRead.goals).toEqual([]);
    expect(legacyRead.goalId).toBeNull();
    expect(legacyRead.leadAgentId).toBeNull();

    const mixedRead = reads.getById[1]!;
    expect(mixedRead.goalIds).toEqual([tenant.goalA]);
    expect(mixedRead.goals).toEqual([{ id: tenant.goalA, title: "Goal a" }]);
    expect(mixedRead.goalId).toBe(tenant.goalA);
    expect(mixedRead.leadAgentId).toBe(tenant.agentA);
  });
  it("never lets an A issue inherit or show B's goal through a link written before the guard existed", async () => {
    // Rows the old code could write, inserted directly: an A project whose
    // goal is B's (both the legacy column and the link table), and an A issue
    // created in it back then, which inherited B's goal.
    const [legacy] = await db
      .insert(projectsTable)
      .values({ companyId: tenant.a, name: "legacy-issue-project", goalId: tenant.goalB })
      .returning();
    await db.insert(projectGoals).values({ projectId: legacy!.id, goalId: tenant.goalB, companyId: tenant.a });
    const [oldIssue] = await db
      .insert(issuesTable)
      .values({
        companyId: tenant.a,
        projectId: legacy!.id,
        goalId: tenant.goalB,
        title: "Issue created before the guard",
        status: "todo",
        priority: "medium",
      })
      .returning();
    // Control: an A project with A's own goal still passes it on.
    const [own] = await db
      .insert(projectsTable)
      .values({ companyId: tenant.a, name: "own-goal-project", goalId: tenant.goalA })
      .returning();

    const issues = issueService(db);
    const leaksB = (label: string, value: unknown) => {
      const text = JSON.stringify(value);
      expect(text, `${label} must not carry B's goal id`).not.toContain(tenant.goalB);
      expect(text, `${label} must not carry B's goal title or description`).not.toContain("Goal b");
    };

    // Inheritance on create: a new issue in the legacy project gets no goal.
    const created = await issues.create(tenant.a, { projectId: legacy!.id, title: "New in legacy project" });
    expect(created.goalId).toBeNull();
    leaksB("create", created);
    const control = await issues.create(tenant.a, { projectId: own!.id, title: "New in own project" });
    expect(control.goalId).toBe(tenant.goalA);

    // A child of the old issue: its ancestor still stores B's goal id.
    const child = await issues.create(tenant.a, { parentId: oldIssue!.id, title: "Child of the old issue" });
    leaksB("child create", child);
    const ancestors = await issues.getAncestors(child.id);
    expect(ancestors.map((a) => a.id)).toEqual([oldIssue!.id]);
    expect(ancestors[0]!.goalId).toBeNull();
    expect(ancestors[0]!.goal).toBeNull();
    expect(ancestors[0]!.project?.id).toBe(legacy!.id);
    expect(ancestors[0]!.project?.goalId).toBeNull();
    leaksB("getAncestors", ancestors);

    // Route output: issue detail and heartbeat context, for the old issue
    // (stored B goal) and for its child (B goal on the ancestor).
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "local_implicit",
        userId: "local-board",
        companyIds: [tenant.a],
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    for (const id of [oldIssue!.id, child.id, created.id]) {
      for (const path of [`/api/issues/${id}`, `/api/issues/${id}/heartbeat-context`]) {
        const res = await request(app).get(path);
        expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
        leaksB(path, res.body);
      }
    }
    const oldDetail = await request(app).get(`/api/issues/${oldIssue!.id}`);
    expect(oldDetail.body.goalId).toBeNull();
    expect(oldDetail.body.goal).toBeNull();
    expect(oldDetail.body.project?.id).toBe(legacy!.id);
    const controlDetail = await request(app).get(`/api/issues/${control.id}`);
    expect(controlDetail.body.goalId).toBe(tenant.goalA);
    expect(controlDetail.body.goal?.title).toBe("Goal a");

    // Inheritance on update: moving an issue into the legacy project gives it
    // no goal, and any update to the old issue drops the B goal it stored.
    const moved = await issues.update(control.id, { projectId: legacy!.id });
    expect(moved?.goalId).toBeNull();
    const touched = await issues.update(oldIssue!.id, { priority: "high" });
    expect(touched?.goalId).toBeNull();
    leaksB("update", [moved, touched]);
  });
});
