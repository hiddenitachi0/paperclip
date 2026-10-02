import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * DUR-4302: migration 0208_paperless_ngx_connection applies on the
 * embedded-Postgres path (every migration, in journal order), widens the
 * three constraints it touches and nothing else, and is safe to run a
 * second time (every statement guarded).
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-4302 migration test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_PATH = fileURLToPath(new URL("./migrations/0208_paperless_ngx_connection.sql", import.meta.url));

type Row = Record<string, unknown>;

d("DUR-4302 migration 0208_paperless_ngx_connection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-dur4302-paperless-");
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

  async function snapshot() {
    return {
      kind: await constraintDef("data_connections_kind_check"),
      credentialKind: await constraintDef("data_connections_credential_kind_check"),
      dataset: await constraintDef("data_dataset_sources_dataset_check"),
      access: await constraintDef("data_connections_access_check"),
      shopDomain: await constraintDef("data_connections_shop_domain_check"),
    };
  }

  it("widened kind, credential-kind and dataset to include paperless_ngx / documents, and touched nothing else", async () => {
    const s = await snapshot();
    expect(s.kind).toBe(
      "CHECK ((kind = ANY (ARRAY['shopify'::text, 'woocommerce'::text, 'fiken'::text, 'ftp_file'::text, 'ftps_file'::text, 'sftp_file'::text, 'paperless_ngx'::text])))",
    );
    expect(s.credentialKind).toContain("kind = 'paperless_ngx'::text) AND (credential_kind = 'paperless_api_token'::text");
    // Every pre-existing pair is still exactly as 0174 left it.
    for (const pair of [
      "kind = 'shopify'::text) AND (credential_kind = ANY (ARRAY['admin_access_token'::text, 'client_credentials'::text]",
      "kind = 'woocommerce'::text) AND (credential_kind = 'consumer_key_secret'::text",
      "kind = 'fiken'::text) AND (credential_kind = 'api_token'::text",
      "kind = ANY (ARRAY['ftp_file'::text, 'ftps_file'::text])) AND (credential_kind = 'password'::text",
      "kind = 'sftp_file'::text) AND (credential_kind = ANY (ARRAY['password'::text, 'private_key'::text]",
    ]) {
      expect(s.credentialKind, pair).toContain(pair);
    }
    expect(s.dataset).toBe("CHECK ((dataset = ANY (ARRAY['sales'::text, 'finance'::text, 'custom'::text, 'documents'::text])))");
    // Untouched on purpose.
    expect(s.access).toBe("CHECK ((access = ANY (ARRAY['read'::text, 'read_write'::text])))");
    expect(s.shopDomain).toContain("myshopify");
  });

  it("is idempotent: running the file a second time changes nothing and raises nothing", async () => {
    const before = await snapshot();
    const statements = readFileSync(MIGRATION_PATH, "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements.length).toBeGreaterThanOrEqual(2);
    for (const statement of statements) {
      await db.execute(sql.raw(statement));
    }
    const after = await snapshot();
    expect(after).toEqual(before);
    const counts = (await db.execute(sql`
      SELECT conname, count(*)::int AS n FROM pg_constraint
      WHERE conname IN ('data_connections_kind_check', 'data_connections_credential_kind_check', 'data_dataset_sources_dataset_check')
      GROUP BY conname
    `)) as unknown as Row[];
    expect(counts.map((row) => row.n)).toEqual([1, 1, 1]);
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
  });
});
