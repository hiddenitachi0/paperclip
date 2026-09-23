import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * DUR-3997 (files on a server): migration 0174_file_server_connections applies
 * on the embedded-Postgres path (every migration, in journal order), widens
 * the kind, credential-kind and access rules exactly as intended, keeps a
 * Shopify row and every other rule untouched, and is safe to run twice.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-3997 file-server migration test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_PATH = fileURLToPath(new URL("./migrations/0174_file_server_connections.sql", import.meta.url));

type Row = Record<string, unknown>;

d("DUR-3997 migration 0174_file_server_connections", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-dur3997-file-server-");
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
      access: await constraintDef("data_connections_access_check"),
      dataset: await constraintDef("data_dataset_sources_dataset_check"),
      shopDomain: await constraintDef("data_connections_shop_domain_check"),
    };
  }

  it("widened the kind, credential-kind and access rules for FTP, FTPS and SFTP", async () => {
    const s = await snapshot();
    for (const kind of ["ftp_file", "ftps_file", "sftp_file"]) {
      expect(s.kind, kind).toContain(`'${kind}'::text`);
    }
    // FTP and FTPS take a password only; SFTP takes password or private_key.
    expect(s.credentialKind).toContain("kind = ANY (ARRAY['ftp_file'::text, 'ftps_file'::text])) AND (credential_kind = 'password'::text");
    expect(s.credentialKind).toContain("kind = 'sftp_file'::text) AND (credential_kind = ANY (ARRAY['password'::text, 'private_key'::text]");
    // A private key can never sit on a plain-FTP row: the ftp_file/ftps_file
    // clause allows only 'password' (the INSERT test below proves it too).
    expect(s.credentialKind).toContain("['ftp_file'::text, 'ftps_file'::text])) AND (credential_kind = 'password'::text)");
    expect(s.access).toBe("CHECK ((access = ANY (ARRAY['read'::text, 'read_write'::text])))");
    // Untouched by 0174.
    expect(s.dataset).toBe("CHECK ((dataset = ANY (ARRAY['sales'::text, 'finance'::text, 'custom'::text])))");
    expect(s.shopDomain).toContain("myshopify");
  });

  it("accepts each file-server row shape and refuses a private key on an FTP row, a bad access value, and an unknown kind", async () => {
    const companyId = "00000000-0000-4000-8000-0000000000f5";
    await db.execute(sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'FS Co', 'FSC') ON CONFLICT DO NOTHING`);

    async function insert(fields: {
      kind: string;
      credentialKind: string;
      access: string;
      config: Record<string, unknown>;
    }): Promise<{ ok: boolean }> {
      const secretId = randomUUID();
      await db.execute(
        sql`INSERT INTO "company_secrets" ("id", "company_id", "name", "key", "provider") VALUES (${secretId}, ${companyId}, ${secretId}, ${secretId}, 'local_encrypted') ON CONFLICT DO NOTHING`,
      );
      try {
        await db.execute(sql`
          INSERT INTO "data_connections" ("company_id", "kind", "name", "credential_kind", "credential_secret_id", "access", "config")
          VALUES (${companyId}, ${fields.kind}, ${fields.kind}, ${fields.credentialKind}, ${secretId}, ${fields.access}, ${JSON.stringify(fields.config)}::jsonb)
        `);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    }

    const base = { host: "files.example.com", port: 21, username: "u", remotePath: "/reports" };
    expect((await insert({ kind: "ftp_file", credentialKind: "password", access: "read", config: base })).ok).toBe(true);
    expect((await insert({ kind: "ftps_file", credentialKind: "password", access: "read_write", config: { ...base, port: 21 } })).ok).toBe(true);
    expect((await insert({ kind: "sftp_file", credentialKind: "private_key", access: "read_write", config: { ...base, port: 22 } })).ok).toBe(true);
    // A private key on plain FTP is refused by the credential-kind check.
    expect((await insert({ kind: "ftp_file", credentialKind: "private_key", access: "read", config: base })).ok).toBe(false);
    // A made-up access value is refused.
    expect((await insert({ kind: "sftp_file", credentialKind: "password", access: "write_only", config: base })).ok).toBe(false);
    // An unknown kind is refused.
    expect((await insert({ kind: "s3_file", credentialKind: "password", access: "read", config: base })).ok).toBe(false);
  });

  it("keeps row-level security and the company-scope policy on data_connections", async () => {
    const rows = (await db.execute(sql`
      SELECT c.relrowsecurity AS rls, p.policyname AS policy
      FROM pg_class c
      LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'paperclip_company_scope'
      WHERE c.relname = 'data_connections'
    `)) as unknown as Row[];
    expect(rows[0]?.rls).toBe(true);
    expect(rows[0]?.policy).toBe("paperclip_company_scope");
  });

  it("is idempotent: running the file a second time changes nothing and keeps one of each constraint", async () => {
    const before = await snapshot();
    const statements = readFileSync(MIGRATION_PATH, "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements.length).toBeGreaterThanOrEqual(2);
    for (const statement of statements) await db.execute(sql.raw(statement));
    expect(await snapshot()).toEqual(before);
    const counts = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conname IN ('data_connections_kind_check', 'data_connections_credential_kind_check', 'data_connections_access_check')
    `)) as unknown as Row[];
    expect(counts[0]?.n).toBe(3);
  });

  it("the file itself only ever drops the constraints it re-adds, and touches no data", () => {
    const text = readFileSync(MIGRATION_PATH, "utf8")
      .split("\n")
      .map((line) => line.replace(/^\s*--.*$/, ""))
      .join("\n");
    expect(text).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|ROLE)\b|\bTRUNCATE\b|\bREVOKE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"?\w+"?\s+SET\b/i);
    expect(text).not.toMatch(/information_schema\.(tables|columns)/);
    const dropped = [...text.matchAll(/DROP CONSTRAINT IF EXISTS "([^"]+)"/g)].map((match) => match[1]).sort();
    const added = [...text.matchAll(/ADD CONSTRAINT "([^"]+)"/g)].map((match) => match[1]).sort();
    expect(dropped).toEqual(added);
  });
});
