import { readFile } from "node:fs/promises";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// Migration 0164 replaces a reverted migration of the same number that took
// production down on 2026-09-09. That one asked the live database which tables
// to police -- "every table in public with a company_id column" -- and this
// database also holds a client's Django tables whose company_id is a bigint.
// Comparing bigint to uuid aborted the migration and the server crash-looped.
//
// The replacement names Paperclip's own tables explicitly. These tests hold
// that list to the Drizzle schema (so it cannot silently rot), and prove
// against a real Postgres that a foreign table sitting in the same database is
// neither policed nor granted on.

const MIGRATION_PATH = new URL("./migrations/0164_rls_login_roles.sql", import.meta.url);

const migrationSql = await readFile(MIGRATION_PATH, "utf8");

/** The migration with its `--` comments stripped, for checks about what it executes. */
const migrationStatements = migrationSql
  .split("\n")
  .map((line) => line.replace(/^\s*--.*$/, ""))
  .join("\n");

type SchemaTable = Parameters<typeof getTableConfig>[0];

/** Every table the Drizzle schema in this repo defines. */
function schemaTableConfigs(): ReturnType<typeof getTableConfig>[] {
  return Object.values(schema)
    .filter((value) => value instanceof PgTable)
    .map((table) => getTableConfig(table as SchemaTable));
}

/** Table names as the Drizzle schema in this repo defines them. */
function schemaTableNames(): string[] {
  return schemaTableConfigs()
    .map((config) => config.name)
    .sort();
}

/** Schema tables carrying their own company_id column. */
function schemaCompanyScopedTableNames(): string[] {
  return schemaTableConfigs()
    .filter((config) => config.columns.some((column) => column.name === "company_id"))
    .map((config) => config.name)
    .sort();
}

/** The quoted names inside one `<name> text[] := ARRAY[ ... ];` declaration. */
function migrationArray(name: string): string[] {
  const match = migrationSql.match(new RegExp(`${name}\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([^\\]]*)\\]`));
  if (!match) throw new Error(`Migration 0164 has no ${name} array`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]).sort();
}

describe("migration 0164: explicit table list", () => {
  it("grants on exactly the tables this codebase defines", () => {
    expect(migrationArray("paperclip_tables")).toEqual(schemaTableNames());
  });

  it("policies exactly the schema tables that carry a company_id", () => {
    expect(migrationArray("company_scope_tables")).toEqual(schemaCompanyScopedTableNames());
  });

  it("every table it policies has a uuid company_id in the schema", () => {
    const nonUuid = schemaTableConfigs()
      .flatMap((config) =>
        config.columns
          .filter((column) => column.name === "company_id" && column.getSQLType() !== "uuid")
          .map((column) => `${config.name}.company_id is ${column.getSQLType()}`),
      );
    expect(nonUuid).toEqual([]);
  });

  it("never discovers which tables to touch by querying the live database", () => {
    // This is the exact mistake that caused the outage: a loop whose row source
    // is "whatever tables this database happens to contain". Named tables may
    // of course still be *checked* against information_schema -- that is what
    // makes the migration skip a missing one and refuse a foreign one.
    const discoveryLoops = [...migrationStatements.matchAll(/FOR\s+\w+\s+IN\b[\s\S]{0,600}?LOOP/g)]
      .map((match) => match[0])
      .filter((loop) => /information_schema\.(tables|columns)/.test(loop));
    expect(discoveryLoops).toEqual([]);
    expect(migrationStatements).not.toMatch(/ALL TABLES IN SCHEMA public/);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Shaped like the client's Django tables that are in the same production
// database: a company_id that is a bigint, not a uuid.
const FOREIGN_TABLES = [
  "core_task",
  "core_companyledgerbinding",
  "integrations_connection",
  "module_governance_rule",
  "module_financial_kpis_snapshot",
  "stock_history_entry",
];

describeEmbeddedPostgres("migration 0164 against a database that holds another application's tables", () => {
  let sql!: ReturnType<typeof postgres>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-rls-login-roles-");
    sql = postgres(tempDb.connectionString, { max: 1, onnotice: () => {} });

    // Owned by a separate role, the way the client's Django application owns
    // its tables in the shared production database.
    await sql.unsafe(`CREATE ROLE client_django_app NOLOGIN`);
    await sql.unsafe(`GRANT CREATE ON SCHEMA public TO client_django_app`);
    await sql.unsafe(`SET ROLE client_django_app`);
    for (const table of FOREIGN_TABLES) {
      await sql.unsafe(
        `CREATE TABLE ${table} (id bigserial PRIMARY KEY, company_id bigint NOT NULL, label text)`,
      );
    }
    await sql.unsafe(`RESET ROLE`);
  }, 60_000);

  afterAll(async () => {
    await sql?.end().catch(() => {});
    await tempDb?.cleanup();
  });

  it("creates both login roles without a password and keeps their memberships disjoint", async () => {
    const roles = await sql<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; haspassword: boolean }[]>`
      SELECT rolname, rolcanlogin, rolsuper, rolpassword IS NOT NULL AS haspassword
      FROM pg_authid
      WHERE rolname IN ('paperclip_app_scoped_login', 'paperclip_app_bypass_login')
      ORDER BY rolname
    `;
    expect(roles.map((role) => role.rolname)).toEqual([
      "paperclip_app_bypass_login",
      "paperclip_app_scoped_login",
    ]);
    for (const role of roles) {
      expect(role.rolcanlogin).toBe(true);
      expect(role.rolsuper).toBe(false);
      // A migration must never carry a secret: the operator sets the passwords
      // by hand, so until then neither role can authenticate at all.
      expect(role.haspassword).toBe(false);
    }

    const [memberships] = await sql<{ scopedhasbypass: boolean; bypasshasscoped: boolean }[]>`
      SELECT pg_has_role('paperclip_app_scoped_login', 'paperclip_app_bypass', 'member') AS scopedhasbypass,
             pg_has_role('paperclip_app_bypass_login', 'paperclip_app_scoped', 'member') AS bypasshasscoped
    `;
    expect(memberships.scopedhasbypass).toBe(false);
    expect(memberships.bypasshasscoped).toBe(false);
  });

  it("policies the tenant tables added after migration 0149", async () => {
    const rows = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_policies
      WHERE schemaname = 'public' AND policyname = 'paperclip_company_scope'
      ORDER BY tablename
    `;
    const policed = new Set(rows.map((row) => row.tablename));
    for (const table of [
      "company_mcp_oauth_connections",
      "lane_a_messages",
      "persona_accounts",
      "persona_posts",
      "persona_generation_counters",
      "persona_account_publish_counters",
      "persona_publishing_company_settings",
      "pipeline_stages",
      "pipeline_transitions",
    ]) {
      expect(policed.has(table), `${table} has no company scope policy`).toBe(true);
    }
  });

  it("leaves the other application's tables completely alone", async () => {
    const policies = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY(${FOREIGN_TABLES})
    `;
    expect(policies).toEqual([]);

    const rowSecurity = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY(${FOREIGN_TABLES})
    `;
    expect(rowSecurity.filter((row) => row.relrowsecurity)).toEqual([]);

    for (const table of FOREIGN_TABLES) {
      const [privileges] = await sql<{ scoped: boolean; bypass: boolean }[]>`
        SELECT has_table_privilege('paperclip_app_scoped', ${table}, 'SELECT') AS scoped,
               has_table_privilege('paperclip_app_bypass_login', ${table}, 'SELECT') AS bypass
      `;
      expect(privileges.scoped, `${table} is readable by paperclip_app_scoped`).toBe(false);
      expect(privileges.bypass, `${table} is readable by paperclip_app_bypass_login`).toBe(false);
    }
  });

  it("grants Paperclip's own tables to both roles", async () => {
    for (const table of ["issues", "instance_settings", "cross_company_access_log"]) {
      const [privileges] = await sql<{ scoped: boolean; bypass: boolean }[]>`
        SELECT has_table_privilege('paperclip_app_scoped', ${table}, 'SELECT') AS scoped,
               has_table_privilege('paperclip_app_bypass_login', ${table}, 'UPDATE') AS bypass
      `;
      expect(privileges.scoped, `paperclip_app_scoped cannot read ${table}`).toBe(true);
      expect(privileges.bypass, `paperclip_app_bypass_login cannot write ${table}`).toBe(true);
    }
  });

  it("re-runs cleanly with the other application's tables present", async () => {
    // The outage: re-running this file over a database containing bigint
    // company_id tables must be a no-op, not "operator does not exist:
    // bigint = uuid".
    const policiesBefore = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_policies WHERE policyname = 'paperclip_company_scope'
    `;

    await sql.unsafe(migrationSql);

    const policiesAfter = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_policies WHERE policyname = 'paperclip_company_scope'
    `;
    expect(policiesAfter[0].count).toBe(policiesBefore[0].count);
  });

  it("refuses to police a table of its own name whose company_id is not a uuid", async () => {
    // Runs last: it deliberately damages this throwaway database so the
    // migration's assertion can be observed. A Paperclip-named table with a
    // foreign company_id type means the assumption behind every policy here is
    // wrong, and a cast would just reproduce the outage in a quieter way.
    await sql.unsafe(`DROP POLICY paperclip_company_scope ON feedback_votes`);
    await sql.unsafe(`ALTER TABLE feedback_votes DROP COLUMN company_id CASCADE`);
    await sql.unsafe(`ALTER TABLE feedback_votes ADD COLUMN company_id bigint`);

    await expect(sql.unsafe(migrationSql)).rejects.toThrow(/feedback_votes\.company_id is bigint, not uuid/);
  });
});
