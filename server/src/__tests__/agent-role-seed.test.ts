// DUR-146 Stage 1: seedDurStarterJobs creates the two starter jobs Filip
// asked for ("Boss", "Developer") on the DUR board's own company, exactly
// once, and gives them the rights the operator ruling specified: Boss holds
// both deploys:request and merges:request, Developer holds merges:request
// only. No other agent or role is ever touched by this seed.
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyAgentRoles, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { DUR_COMPANY_ID, seedDurStarterJobs } from "../services/agent-role-seed.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("seedDurStarterJobs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-role-seed-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyAgentRoles);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("seeds Boss (deploy+merge ask-rights) and Developer (merge only) exactly once", async () => {
    await db.insert(companies).values({
      id: DUR_COMPANY_ID,
      name: "Durkan Agency",
      issuePrefix: "DUR",
    });

    const first = await seedDurStarterJobs(db);
    const second = await seedDurStarterJobs(db);

    expect(first.created.sort()).toEqual(["boss", "developer"]);
    expect(second.created).toEqual([]);

    const roles = await db
      .select()
      .from(companyAgentRoles)
      .where(eq(companyAgentRoles.companyId, DUR_COMPANY_ID));
    expect(roles).toHaveLength(2);

    const boss = roles.find((role) => role.key === "boss")!;
    const developer = roles.find((role) => role.key === "developer")!;
    expect(boss).toBeTruthy();
    expect(developer).toBeTruthy();

    const bossKeys = (boss.defaultGrants as Array<{ permissionKey: string }>)
      .map((grant) => grant.permissionKey)
      .sort();
    expect(bossKeys).toEqual(["deploys:request", "merges:request"]);

    const developerKeys = (developer.defaultGrants as Array<{ permissionKey: string }>)
      .map((grant) => grant.permissionKey)
      .sort();
    expect(developerKeys).toEqual(["merges:request"]);
  });

  it("skips silently when the DUR company row does not exist on this instance", async () => {
    const result = await seedDurStarterJobs(db);
    expect(result.created).toEqual([]);

    const roles = await db.select().from(companyAgentRoles);
    expect(roles).toHaveLength(0);
  });
});
