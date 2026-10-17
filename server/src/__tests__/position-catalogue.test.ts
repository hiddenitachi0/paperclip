// "Add from catalogue" (ready-to-hire positions with one-click jobs) and the
// one-time conversion of the old Brag position into the Content & Video
// Producer position, exercised against a real database.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companyAgentRoles,
  createDb,
  jobPositions,
  jobs,
  principalPermissionGrants,
} from "@paperclipai/db";
import { CATALOGUE_SKILL_KEYS, findPositionTemplate } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createRole } from "../services/agent-roles.js";
import {
  addPositionFromCatalogue,
  convertBragPositionsToSkill,
  listPositionCatalogue,
  missingCatalogueSkills,
  readPositionSkillKeys,
} from "../services/position-catalogue.js";

describe("readPositionSkillKeys", () => {
  it("keeps only non-empty string keys", () => {
    expect(readPositionSkillKeys(["a", "", 3, null, "b"])).toEqual(["a", "b"]);
    expect(readPositionSkillKeys(null)).toEqual([]);
    expect(readPositionSkillKeys("a")).toEqual([]);
  });
});

describe("missingCatalogueSkills", () => {
  it("never reports skills that every company gets automatically", () => {
    const template = findPositionTemplate("content-video-producer")!;
    const missing = missingCatalogueSkills(template, new Set([CATALOGUE_SKILL_KEYS.brag]));
    expect(missing).not.toContain(CATALOGUE_SKILL_KEYS.paperclip);
    expect(missing).not.toContain(CATALOGUE_SKILL_KEYS.brag);
    expect(missing).toContain(CATALOGUE_SKILL_KEYS.bragVideo);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres position-catalogue tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("position catalogue", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-position-catalogue-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(jobPositions);
    await db.delete(jobs);
    await db.delete(principalPermissionGrants);
    await db.delete(agents);
    await db.delete(companyAgentRoles);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Catalogue Co",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, roleId: string | null) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Video Agent",
      role: "general",
      adapterType: "claude_local",
      adapterConfig: { mcpServers: [] },
      runtimeConfig: {},
      permissions: {},
      roleId,
    });
    return agentId;
  }

  it("adds a position with its jobs once, and a second add changes nothing", async () => {
    const companyId = await seedCompany();
    const first = await addPositionFromCatalogue(db, companyId, "social-media-manager");
    expect(first.createdPosition).toBe(true);
    expect(first.position.key).toBe("social-media-manager");
    expect(first.position.isBuiltin).toBe(true);
    expect(first.position.skillKeys).toContain(CATALOGUE_SKILL_KEYS.socialMedia);
    expect(first.createdJobs).toEqual(["Draft this week's social posts", "Turn an announcement into social posts"]);
    expect(first.missingSkillKeys).toContain(CATALOGUE_SKILL_KEYS.socialMedia);

    const second = await addPositionFromCatalogue(db, companyId, "social-media-manager");
    expect(second.createdPosition).toBe(false);
    expect(second.position.id).toBe(first.position.id);
    expect(second.createdJobs).toEqual([]);
    expect(second.linkedJobs).toEqual([]);

    const companyJobs = await db.select().from(jobs).where(eq(jobs.companyId, companyId));
    expect(companyJobs).toHaveLength(2);
    const draft = companyJobs.find((job) => job.title === "Draft this week's social posts")!;
    expect(draft.requiresApproval).toBe(true);
    expect(draft.isBuiltin).toBe(true);
    expect(draft.variables.map((variable) => variable.name)).toEqual(["theme", "platforms"]);
    const links = await db.select().from(jobPositions).where(eq(jobPositions.positionId, first.position.id));
    expect(links).toHaveLength(2);

    const listed = await listPositionCatalogue(db, companyId);
    const social = listed.find((item) => item.key === "social-media-manager")!;
    expect(social.alreadyAdded).toBe(true);
    expect(social.existingPositionId).toBe(first.position.id);
    expect(listed.find((item) => item.key === "scheduler")!.alreadyAdded).toBe(false);
  });

  it("keeps an existing position's own settings and only links missing jobs to it", async () => {
    const companyId = await seedCompany();
    const own = await createRole(db, companyId, {
      name: "Legal Advisor",
      description: "Our own wording",
      defaultGrants: [],
    });
    const [existingJob] = await db
      .insert(jobs)
      .values({ companyId, title: "Revise contract", instructions: "ours", isBuiltin: false })
      .returning();

    const result = await addPositionFromCatalogue(db, companyId, "legal-advisor");
    expect(result.createdPosition).toBe(false);
    expect(result.position.id).toBe(own.id);
    expect(result.position.description).toBe("Our own wording");
    expect(result.linkedJobs).toEqual(["Revise contract"]);
    expect(result.createdJobs.sort()).toEqual(["Compare two versions", "Draft new contract"]);

    const [kept] = await db.select().from(jobs).where(eq(jobs.id, existingJob!.id));
    expect(kept!.instructions).toBe("ours");
  });

  it("refuses a template that is not in the catalogue", async () => {
    const companyId = await seedCompany();
    await expect(addPositionFromCatalogue(db, companyId, "brag")).rejects.toThrow(/not in the catalogue/);
  });

  it("converts the seeded Brag position: agents and jobs move to Content & Video Producer, Brag is removed", async () => {
    const companyId = await seedCompany();
    const brag = await createRole(db, companyId, {
      name: "Brag",
      description: "Turns a project's code or website into a short launch video using the /brag skill",
      defaultGrants: [],
      skillKeys: [CATALOGUE_SKILL_KEYS.brag],
      isBuiltin: true,
    });
    const agentId = await seedAgent(companyId, brag.id);
    const [bragJob] = await db
      .insert(jobs)
      .values({ companyId, title: "Brag about the release", instructions: "x" })
      .returning();
    await db.insert(jobPositions).values({ companyId, jobId: bragJob!.id, positionId: brag.id });

    const results = await convertBragPositionsToSkill(db);
    expect(results).toHaveLength(1);
    expect(results[0]!.movedAgentIds).toEqual([agentId]);
    expect(results[0]!.createdTargetPosition).toBe(true);

    const roles = await db.select().from(companyAgentRoles).where(eq(companyAgentRoles.companyId, companyId));
    expect(roles.map((role) => role.key)).toEqual(["content-video-producer"]);
    const producer = roles[0]!;
    expect(producer.skillKeys).toEqual(
      expect.arrayContaining([CATALOGUE_SKILL_KEYS.brag, CATALOGUE_SKILL_KEYS.bragVideo]),
    );

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent!.roleId).toBe(producer.id);
    expect(agent!.roleProvisionedSkillKeys).toEqual(expect.arrayContaining([CATALOGUE_SKILL_KEYS.brag]));
    expect((agent!.adapterConfig as Record<string, unknown>).bootstrapPromptTemplate).toBe(
      producer.defaultInstructions,
    );

    const moved = await db
      .select()
      .from(jobPositions)
      .where(and(eq(jobPositions.jobId, bragJob!.id), eq(jobPositions.positionId, producer.id)));
    expect(moved).toHaveLength(1);

    // Second startup: nothing left to convert.
    expect(await convertBragPositionsToSkill(db)).toEqual([]);
  });

  it("leaves an operator's own position that just happens to be called Brag alone", async () => {
    const companyId = await seedCompany();
    await createRole(db, companyId, { name: "Brag", description: "Our PR person", defaultGrants: [] });
    expect(await convertBragPositionsToSkill(db)).toEqual([]);
    const roles = await db.select().from(companyAgentRoles).where(eq(companyAgentRoles.companyId, companyId));
    expect(roles.map((role) => role.key)).toEqual(["brag"]);
  });
});
