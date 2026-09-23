import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * DUR-3997 slice 3: migration 0173_data_connection_kinds applies on the
 * embedded-Postgres path (every migration, in journal order), leaves the
 * tables in exactly the shape the Drizzle schema declares, and is safe to run
 * a second time (every statement guarded).
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-3997 migration test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_PATH = fileURLToPath(new URL("./migrations/0173_data_connection_kinds.sql", import.meta.url));

type Row = Record<string, unknown>;

d("DUR-3997 migration 0173_data_connection_kinds", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-dur3997-kinds-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function constraintDef(name: string): Promise<string | null> {
    const rows = (await db.execute(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}`,
    )) as unknown as Row[];
    return (rows[0]?.def as string | undefined) ?? null;
  }

  async function columns(table: string): Promise<Map<string, { nullable: boolean; def: string | null }>> {
    const rows = (await db.execute(sql`
      SELECT a.attname AS name, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = ${table}::regclass AND a.attnum > 0 AND NOT a.attisdropped
    `)) as unknown as Row[];
    return new Map(rows.map((row) => [row.name as string, { nullable: row.nullable as boolean, def: (row.def as string | null) ?? null }]));
  }

  async function snapshot() {
    return {
      kind: await constraintDef("data_connections_kind_check"),
      shopDomain: await constraintDef("data_connections_shop_domain_check"),
      credentialKind: await constraintDef("data_connections_credential_kind_check"),
      dataset: await constraintDef("data_dataset_sources_dataset_check"),
      pk: await constraintDef("data_dataset_sources_pk"),
      fk: await constraintDef("data_dataset_sources_connection_company_fk"),
      access: await constraintDef("data_connections_access_check"),
      columns: await columns("data_connections"),
    };
  }

  it("widened the kind, credential-kind and dataset rules and relaxed the Shopify-only columns", async () => {
    const s = await snapshot();
    // 0174 (file servers) widens this further with ftp_file/ftps_file at
    // migrated head; the four kinds 0173 introduced are all present.
    expect(s.kind).toBe(
      "CHECK ((kind = ANY (ARRAY['shopify'::text, 'woocommerce'::text, 'fiken'::text, 'ftp_file'::text, 'ftps_file'::text, 'sftp_file'::text])))",
    );
    expect(s.shopDomain).toContain("kind <> 'shopify'::text");
    expect(s.shopDomain).toContain("shop_domain IS NOT NULL");
    expect(s.shopDomain).toContain("api_version IS NOT NULL");
    expect(s.shopDomain).toContain("myshopify");
    for (const pair of [
      "kind = 'shopify'::text) AND (credential_kind = ANY (ARRAY['admin_access_token'::text, 'client_credentials'::text]",
      "kind = 'woocommerce'::text) AND (credential_kind = 'consumer_key_secret'::text",
      "kind = 'fiken'::text) AND (credential_kind = 'api_token'::text",
      "kind = 'sftp_file'::text) AND (credential_kind = ANY (ARRAY['password'::text, 'private_key'::text]",
    ]) {
      expect(s.credentialKind, pair).toContain(pair);
    }
    expect(s.dataset).toBe("CHECK ((dataset = ANY (ARRAY['sales'::text, 'finance'::text, 'custom'::text])))");
    // Untouched on purpose.
    expect(s.pk).toBe("PRIMARY KEY (company_id, dataset)");
    expect(s.fk).toBe("FOREIGN KEY (connection_id, company_id) REFERENCES data_connections(id, company_id) ON DELETE CASCADE");
    // 0174 widens access to read_write for file-server connections at head.
    expect(s.access).toBe("CHECK ((access = ANY (ARRAY['read'::text, 'read_write'::text])))");

    expect(s.columns.get("shop_domain")).toEqual({ nullable: true, def: null });
    expect(s.columns.get("api_version")).toEqual({ nullable: true, def: null });
    expect(s.columns.get("config")).toEqual({ nullable: false, def: "'{}'::jsonb" });
    expect(s.columns.get("credential_secret_id")).toEqual({ nullable: false, def: null });
  });

  it("keeps row-level security and the company-scope policy on both tables", async () => {
    const rows = (await db.execute(sql`
      SELECT c.relname AS table, c.relrowsecurity AS rls, p.policyname AS policy
      FROM pg_class c
      LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'paperclip_company_scope'
      WHERE c.relname IN ('data_connections', 'data_dataset_sources')
      ORDER BY c.relname
    `)) as unknown as Row[];
    expect(rows.map((row) => [row.table, row.rls, row.policy])).toEqual([
      ["data_connections", true, "paperclip_company_scope"],
      ["data_dataset_sources", true, "paperclip_company_scope"],
    ]);
  });

  it("is idempotent: running the file a second time changes nothing and raises nothing", async () => {
    const before = await snapshot();
    const statementsOf = (path: string) =>
      readFileSync(path, "utf8")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
    const statements = statementsOf(MIGRATION_PATH);
    expect(statements.length).toBeGreaterThanOrEqual(5);
    for (const statement of statements) {
      await db.execute(sql.raw(statement));
    }
    // 0174 widens the same kind/credential-kind/access constraints AFTER 0173,
    // so re-running 0173 alone reverts them; re-run 0174 too to restore the
    // migrated-head state this snapshot was taken at. Each file stays a no-op
    // on the state its own predecessor leaves.
    for (const statement of statementsOf(fileURLToPath(new URL("./migrations/0174_file_server_connections.sql", import.meta.url)))) {
      await db.execute(sql.raw(statement));
    }
    const after = await snapshot();
    expect(after).toEqual(before);
    // The same constraint names exist exactly once each.
    const counts = (await db.execute(sql`
      SELECT conname, count(*)::int AS n FROM pg_constraint
      WHERE conname IN ('data_connections_kind_check', 'data_connections_shop_domain_check', 'data_connections_credential_kind_check', 'data_dataset_sources_dataset_check')
      GROUP BY conname
    `)) as unknown as Row[];
    expect(counts.map((row) => row.n)).toEqual([1, 1, 1, 1]);
  });

  it("the file itself only ever drops the constraints it re-adds, and touches no data", () => {
    const text = readFileSync(MIGRATION_PATH, "utf8")
      .split("\n")
      .map((line) => line.replace(/^\s*--.*$/, ""))
      .join("\n");
    expect(text).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|POLICY|ROLE)\b|\bTRUNCATE\b|\bREVOKE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"?\w+"?\s+SET\b/i);
    expect(text).not.toMatch(/information_schema\.(tables|columns)/);
    const dropped = [...text.matchAll(/DROP CONSTRAINT IF EXISTS "([^"]+)"/g)].map((match) => match[1]).sort();
    const added = [...text.matchAll(/ADD CONSTRAINT "([^"]+)"/g)].map((match) => match[1]).sort();
    expect(dropped).toEqual(added);
    expect(text).not.toMatch(/data_dataset_sources_pk/);
  });
});
