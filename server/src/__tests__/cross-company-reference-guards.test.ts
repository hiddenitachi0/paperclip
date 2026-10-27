import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, goals, projectGoals, projects as projectsTable } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { goalService } from "../services/goals.js";
import { projectService } from "../services/projects.js";

/**
 * The two cross-company reference holes the isolation sweep
 * (cross-company-isolation-sweep.test.ts) found, pinned at the service level:
 * a project or goal in company A could point at company B's goal or agent,
 * because the foreign keys do not carry the company. Also pins that project
 * reads ignore such links written before the guard existed. See
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
      const [goal] = await db.insert(goals).values({ companyId, title: `Goal ${key}` }).returning();
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
});
