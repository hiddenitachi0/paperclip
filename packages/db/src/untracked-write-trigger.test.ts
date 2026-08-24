import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDb } from "./client.js";
import { companies, agents, instanceSettings, untrackedWriteIncidents } from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// DUR-130: verifies the fn_flag_untracked_write trigger (migration 0139)
// against a real Postgres instance -- distinguishing an app-pool write from
// a raw, untagged connection is the whole point of the mechanism, and that
// only holds up against real trigger/GUC behavior, not a mock.
describeEmbeddedPostgres("DUR-130: fn_flag_untracked_write trigger", () => {
  let db!: Db;
  let connectionString!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-untracked-write-");
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(untrackedWriteIncidents);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function insertAgentDirect(companyId: string, applicationName: string | undefined) {
    const sql = applicationName
      ? postgres(connectionString, { max: 1, connection: { application_name: applicationName } })
      : postgres(connectionString, { max: 1 });
    const agentId = randomUUID();
    try {
      await sql`
        INSERT INTO agents (id, company_id, name, role, status, adapter_type, adapter_config, runtime_config, permissions)
        VALUES (${agentId}, ${companyId}, 'Direct-write agent', 'engineer', 'idle', 'codex_local', '{}', '{}', '{}')
      `;
    } finally {
      await sql.end();
    }
    return agentId;
  }

  it("does not flag writes made through the app pool (createDb, service-layer provenance)", async () => {
    const companyId = await seedCompany();
    await db.insert(agents).values({
      id: randomUUID(),
      companyId,
      name: "Service-layer agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    expect(await db.select().from(untrackedWriteIncidents)).toHaveLength(0);
  });

  it("flags a write made from a connection with no known-legitimate application_name", async () => {
    const companyId = await seedCompany();
    const agentId = await insertAgentDirect(companyId, undefined);

    const incidents = await db.select().from(untrackedWriteIncidents);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      tableName: "agents",
      operation: "INSERT",
      rowId: agentId,
      companyId,
    });
    expect(incidents[0].alertedAt).toBeNull();
  });

  it("flags a write tagged with an arbitrary, non-allow-listed application_name", async () => {
    const companyId = await seedCompany();
    await insertAgentDirect(companyId, "psql");

    const incidents = await db.select().from(untrackedWriteIncidents);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].applicationName).toBe("psql");
  });

  it("does not flag a write tagged as the restore path", async () => {
    const companyId = await seedCompany();
    await insertAgentDirect(companyId, "paperclip-restore");

    expect(await db.select().from(untrackedWriteIncidents)).toHaveLength(0);
  });

  it("flags an untagged write to a company-less table (e.g. instance_settings) with a null companyId", async () => {
    const sql = postgres(connectionString, { max: 1 });
    try {
      await sql`
        INSERT INTO instance_settings (singleton_key, general, experimental)
        VALUES ('default', '{}', '{}')
      `;
    } finally {
      await sql.end();
    }

    const incidents = await db.select().from(untrackedWriteIncidents);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ tableName: "instance_settings" });
    expect(incidents[0].companyId).toBeNull();
  });

  it("records the affected row's own id as row_id on an untagged companies write", async () => {
    const sql = postgres(connectionString, { max: 1 });
    const companyId = randomUUID();
    try {
      await sql`
        INSERT INTO companies (id, name, issue_prefix)
        VALUES (${companyId}, 'Direct-write co', ${`X${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`})
      `;
    } finally {
      await sql.end();
    }

    const incidents = await db.select().from(untrackedWriteIncidents);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ tableName: "companies", rowId: companyId, companyId: null });
  });
});
