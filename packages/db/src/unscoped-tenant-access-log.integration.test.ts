import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "./client.js";
import { companies } from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";
import { UNSCOPED_TENANT_ACCESS_LOG_ENV_VAR } from "./unscoped-tenant-access-log.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// DUR-304: proves the env-gated debug hook actually wires up end-to-end
// against a real Postgres instance -- pg_policies really does list
// migration 0149's tenant tables under the paperclip_company_scope policy
// name, and a raw createDb() query against one of them (no
// withCompanyScope/runInCompanyScope involved) is logged.
describeEmbeddedPostgres("DUR-304: unscoped tenant access logging wiring", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let connectionString!: string;
  let db!: Db;
  const originalEnv = process.env[UNSCOPED_TENANT_ACCESS_LOG_ENV_VAR];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-unscoped-tenant-access-log-");
    connectionString = tempDb.connectionString;
    process.env[UNSCOPED_TENANT_ACCESS_LOG_ENV_VAR] = "true";
    db = createDb(connectionString, "dur304-integration-test");
  }, 30_000);

  afterEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    if (originalEnv === undefined) delete process.env[UNSCOPED_TENANT_ACCESS_LOG_ENV_VAR];
    else process.env[UNSCOPED_TENANT_ACCESS_LOG_ENV_VAR] = originalEnv;
    await tempDb?.cleanup();
  });

  it("logs a raw, unscoped query against a real tenant table", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The pg_policies lookup that populates the detector's table list is
      // fire-and-forget from createDb(); give it a moment to land before
      // issuing the query we expect to be flagged.
      await new Promise((resolve) => setTimeout(resolve, 500));

      await db.select().from(companies);

      const flaggedCompanies = warnSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes('tenant table "companies"'),
      );
      expect(flaggedCompanies).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
