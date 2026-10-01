// DUR-4182: seedLegalAdvisorStarterPack creates the Legal Advisor position
// and its three jobs ("Revise contract", "Draft new contract", "Compare two
// versions") on the DUR board's own company, exactly once, and is a no-op
// when that company row does not exist (fresh onboarding, e2e tests, other
// operators' deployments of this fork). Mirrors agent-role-seed.test.ts's
// fixture shape for the analogous seedDurStarterJobs.
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyAgentRoles, jobPositions, jobs, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { DUR_COMPANY_ID } from "../services/agent-role-seed.js";
import { LEGAL_ADVISOR_ROLE_KEY, seedLegalAdvisorStarterPack } from "../services/job-starter-pack-seed.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres job-starter-pack-seed tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("seedLegalAdvisorStarterPack", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-job-starter-pack-seed-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(jobPositions);
    await db.delete(jobs);
    await db.delete(companyAgentRoles);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("is a no-op when the DUR company does not exist (fresh install / other operators' deployments)", async () => {
    const result = await seedLegalAdvisorStarterPack(db);
    expect(result).toEqual({ createdPosition: false, createdJobs: [] });

    const roles = await db.select().from(companyAgentRoles);
    expect(roles).toHaveLength(0);
  });

  it("seeds the Legal Advisor position and its three jobs exactly once, as builtin", async () => {
    await db.insert(companies).values({
      id: DUR_COMPANY_ID,
      name: "Durkan Agency",
      issuePrefix: "DUR",
    });

    const first = await seedLegalAdvisorStarterPack(db);
    const second = await seedLegalAdvisorStarterPack(db);

    expect(first.createdPosition).toBe(true);
    expect(first.createdJobs.sort()).toEqual(["Compare two versions", "Draft new contract", "Revise contract"]);
    expect(second.createdPosition).toBe(false);
    expect(second.createdJobs).toEqual([]);

    const roles = await db
      .select()
      .from(companyAgentRoles)
      .where(eq(companyAgentRoles.companyId, DUR_COMPANY_ID));
    expect(roles).toHaveLength(1);
    expect(roles[0].key).toBe(LEGAL_ADVISOR_ROLE_KEY);
    expect(roles[0].isBuiltin).toBe(true);

    const createdJobs = await db.select().from(jobs).where(eq(jobs.companyId, DUR_COMPANY_ID));
    expect(createdJobs).toHaveLength(3);
    for (const job of createdJobs) {
      expect(job.isBuiltin).toBe(true);
      expect(job.runMode).toBe("full_agent");
      // The ticket's hard rule for every Legal Advisor job.
      expect(job.instructions).toContain("never give a final legal verdict");
      expect(job.instructions?.toLowerCase()).toContain("cite");
      expect(job.instructions?.toLowerCase()).toContain("risk");
    }

    const links = await db.select().from(jobPositions).where(eq(jobPositions.companyId, DUR_COMPANY_ID));
    expect(links).toHaveLength(3);
    expect(links.every((link) => link.positionId === roles[0].id)).toBe(true);
  });
});
