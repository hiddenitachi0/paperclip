import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createDb } from "./client.js";
import { companies, companySecrets, companySecretVersions, cliAuthChallenges } from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

// DUR-250: proves migration 0150's indirect-tenancy RLS policies for
// company_secret_versions (tenanted via secret_id -> company_secrets.company_id)
// and cli_auth_challenges (tenanted via its own nullable requested_company_id)
// hold against a real Postgres instance, connecting as paperclip_app_scoped --
// the same shape of connection a leaked DATABASE_URL or a stray script would
// make. See 0150's header comment and migration 0149's "Deliberately
// excluded" list for why these two tables needed their own migration.
describeEmbeddedPostgres("DUR-250: RLS indirect-tenancy coverage (paperclip_app_scoped)", () => {
  let db!: Db;
  let connectionString!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-rls-indirect-tenancy-");
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(cliAuthChallenges);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(label: string) {
    return db
      .insert(companies)
      .values({
        name: `DUR-250 ${label}`,
        issuePrefix: `RLS${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedSecretVersion(companyId: string) {
    const [secret] = await db
      .insert(companySecrets)
      .values({ companyId, key: `secret-${randomUUID()}`, name: "test secret" })
      .returning();
    const [version] = await db
      .insert(companySecretVersions)
      .values({
        secretId: secret!.id,
        version: 1,
        material: { encrypted: "ciphertext" },
        valueSha256: randomUUID(),
        fingerprintSha256: randomUUID(),
      })
      .returning();
    return version!;
  }

  async function seedChallenge(companyId: string | null) {
    const [row] = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: randomUUID(),
        command: "login",
        requestedCompanyId: companyId,
        pendingKeyHash: randomUUID(),
        pendingKeyName: "test key",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    return row!;
  }

  async function openScopedConnection(claims: { companyId?: string }) {
    const sql = postgres(connectionString, { max: 1 });
    await sql`SET ROLE paperclip_app_scoped`;
    if (claims.companyId) {
      await sql`select set_config('app.current_company_id', ${claims.companyId}, false)`;
    }
    return sql;
  }

  it("a connection scoped to company A cannot read company B's secret material via the secret_id -> company_secrets join", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedSecretVersion(companyA.id);
    await seedSecretVersion(companyB.id);

    const asCompanyA = await openScopedConnection({ companyId: companyA.id });
    try {
      const rows = await asCompanyA`SELECT id FROM company_secret_versions`;
      expect(rows).toHaveLength(1);
    } finally {
      await asCompanyA.end();
    }
  });

  it("a raw connection with no claim set reads zero company_secret_versions rows", async () => {
    const companyA = await seedCompany("A");
    await seedSecretVersion(companyA.id);

    const unscoped = await openScopedConnection({});
    try {
      const rows = await unscoped`SELECT id FROM company_secret_versions`;
      expect(rows).toHaveLength(0);
    } finally {
      await unscoped.end();
    }
  });

  it("a connection scoped to company A sees only company A's cli_auth_challenges rows, plus company-less (pre-auth) rows", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedChallenge(companyA.id);
    await seedChallenge(companyB.id);
    await seedChallenge(null);

    const asCompanyA = await openScopedConnection({ companyId: companyA.id });
    try {
      const rows = await asCompanyA`SELECT id, requested_company_id FROM cli_auth_challenges ORDER BY requested_company_id NULLS LAST`;
      expect(rows).toHaveLength(2);
      expect(rows.some((r) => r.requested_company_id === companyA.id)).toBe(true);
      expect(rows.some((r) => r.requested_company_id === null)).toBe(true);
    } finally {
      await asCompanyA.end();
    }
  });

  it("a role granted paperclip_app_bypass sees every company's secret_versions and cli_auth_challenges rows", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedSecretVersion(companyA.id);
    await seedSecretVersion(companyB.id);
    await seedChallenge(companyA.id);
    await seedChallenge(companyB.id);

    const setupSql = postgres(connectionString, { max: 1 });
    try {
      await setupSql.unsafe(
        "CREATE ROLE paperclip_test_indirect_bypass_holder NOLOGIN IN ROLE paperclip_app_scoped, paperclip_app_bypass",
      );
    } finally {
      await setupSql.end();
    }

    try {
      const bypassed = postgres(connectionString, { max: 1 });
      try {
        await bypassed`SET ROLE paperclip_test_indirect_bypass_holder`;
        const versionRows = await bypassed`SELECT id FROM company_secret_versions`;
        expect(versionRows).toHaveLength(2);
        const challengeRows = await bypassed`SELECT id FROM cli_auth_challenges`;
        expect(challengeRows).toHaveLength(2);
      } finally {
        await bypassed.end();
      }
    } finally {
      const cleanupSql = postgres(connectionString, { max: 1 });
      try {
        await cleanupSql.unsafe("DROP ROLE IF EXISTS paperclip_test_indirect_bypass_holder");
      } finally {
        await cleanupSql.end();
      }
    }
  });

  it("Phase 1/2 does not change the app's own owner-role connection: createDb() still sees every company, unaffected", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    await seedSecretVersion(companyA.id);
    await seedSecretVersion(companyB.id);

    const rows = await db.select().from(companySecretVersions);
    expect(rows).toHaveLength(2);
  });
});
