import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, goals } from "@paperclipai/db";
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
 * because the foreign keys do not carry the company. See
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
});
