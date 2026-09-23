import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * DUR-4000 step 1: migration 0175_persona_identity applies on the
 * embedded-Postgres path, copies an existing persona's identity off the agent
 * it sat on, links the agent back to the persona, moves the picture limit into
 * the agent's limits box, and is safe to run again.
 *
 * The embedded helper applies every migration before the test can seed, so
 * the "existing persona + agent" is seeded in the OLD shape afterwards
 * (persona.agent_id set, identity columns NULL, agent.persona_id NULL,
 * limits {}) and the file is executed a second time. Every statement is
 * guarded, so that second run is exactly the backfill a live database gets.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping DUR-4000 migration test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_PATH = fileURLToPath(new URL("./migrations/0175_persona_identity.sql", import.meta.url));

type Row = Record<string, unknown>;

function migrationStatements(): string[] {
  return readFileSync(MIGRATION_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

d("DUR-4000 migration 0175_persona_identity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-dur4000-persona-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function rerunMigration() {
    for (const statement of migrationStatements()) {
      await db.execute(sql.raw(statement));
    }
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

  async function seedOldShape(input: { name: string; personality: string | null; tone: string | null; cap: number | null }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const personaId = randomUUID();
    const assetId = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, ${`Co ${companyId.slice(0, 6)}`}, ${`P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`})`);
    await db.execute(sql`INSERT INTO agents (id, company_id, name, personality, tone) VALUES (${agentId}, ${companyId}, ${input.name}, ${input.personality}, ${input.tone})`);
    await db.execute(sql`INSERT INTO assets (id, company_id, provider, object_key, content_type, byte_size, sha256, created_by_agent_id) VALUES (${assetId}, ${companyId}, 'local', ${`k-${assetId}`}, 'image/png', 1, ${`sha-${assetId}`}, ${agentId})`);
    await db.execute(sql`UPDATE agents SET avatar_asset_id = ${assetId} WHERE id = ${agentId}`);
    // The pre-0175 row: linked from the persona side only, no identity of its own.
    await db.execute(sql`INSERT INTO personas (id, company_id, agent_id, handle, status, daily_generation_cap) VALUES (${personaId}, ${companyId}, ${agentId}, '@maja', 'active', ${input.cap})`);
    return { companyId, agentId, personaId, assetId };
  }

  it("shape: persona carries its own identity, agent links to a persona and has a limits box, agent_id is optional and no longer unique", async () => {
    const persona = await columns("personas");
    for (const name of ["display_name", "pronouns", "traits", "backstory", "voice", "avatar_asset_id"]) {
      expect(persona.get(name), name).toEqual({ nullable: true, def: null });
    }
    expect(persona.get("agent_id")).toEqual({ nullable: true, def: null });

    const agent = await columns("agents");
    expect(agent.get("persona_id")).toEqual({ nullable: true, def: null });
    expect(agent.get("limits")).toEqual({ nullable: false, def: "'{}'::jsonb" });

    const post = await columns("persona_posts");
    expect(post.get("agent_id")).toEqual({ nullable: true, def: null });

    const indexes = (await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename IN ('personas', 'agents', 'agent_daily_counters') ORDER BY indexname
    `)) as unknown as Row[];
    const names = indexes.map((row) => row.indexname as string);
    expect(names).not.toContain("personas_agent_id_uq");
    expect(names).toContain("agents_company_persona_idx");
    expect(names).toContain("agent_daily_counters_agent_kind_day_uq");

    const fks = (await db.execute(sql`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('agents_persona_id_personas_id_fk', 'personas_avatar_asset_id_assets_id_fk', 'persona_posts_agent_id_agents_id_fk', 'agent_daily_counters_agent_id_agents_id_fk')
      ORDER BY conname
    `)) as unknown as Row[];
    expect(fks.map((row) => [row.conname, row.def])).toEqual([
      ["agent_daily_counters_agent_id_agents_id_fk", "FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE"],
      ["agents_persona_id_personas_id_fk", "FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL"],
      ["persona_posts_agent_id_agents_id_fk", "FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL"],
      ["personas_avatar_asset_id_assets_id_fk", "FOREIGN KEY (avatar_asset_id) REFERENCES assets(id) ON DELETE SET NULL"],
    ]);
  });

  it("agent_daily_counters is granted and policed like every other tenant table", async () => {
    const rows = (await db.execute(sql`
      SELECT c.relrowsecurity AS rls, p.policyname AS policy,
             has_table_privilege('paperclip_app_scoped', 'agent_daily_counters', 'INSERT') AS scoped,
             has_table_privilege('paperclip_app_bypass_login', 'agent_daily_counters', 'UPDATE') AS bypass
      FROM pg_class c
      LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'paperclip_company_scope'
      WHERE c.relname = 'agent_daily_counters'
    `)) as unknown as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rls: true, policy: "paperclip_company_scope", scoped: true, bypass: true });
  });

  it("backfills an existing persona from its agent: name, backstory, voice, picture, the agent link and the picture limit", async () => {
    const seeded = await seedOldShape({ name: "Maja", personality: "Grew up by the sea.", tone: "Warm, direct.", cap: 5 });

    await rerunMigration();

    const [persona] = (await db.execute(
      sql`SELECT display_name, backstory, voice, avatar_asset_id, agent_id FROM personas WHERE id = ${seeded.personaId}`,
    )) as unknown as Row[];
    expect(persona).toEqual({
      display_name: "Maja",
      backstory: "Grew up by the sea.",
      voice: "Warm, direct.",
      avatar_asset_id: seeded.assetId,
      agent_id: seeded.agentId,
    });

    const [agent] = (await db.execute(
      sql`SELECT name, personality, tone, persona_id, limits FROM agents WHERE id = ${seeded.agentId}`,
    )) as unknown as Row[];
    expect(agent).toEqual({
      // The agent row itself is left exactly as it was.
      name: "Maja",
      personality: "Grew up by the sea.",
      tone: "Warm, direct.",
      persona_id: seeded.personaId,
      limits: { dailyImageGenerations: 5 },
    });
  });

  it("only fills what is empty: a persona that already has its own words, and an agent with its own limits, keep them", async () => {
    const seeded = await seedOldShape({ name: "Sales agent 1", personality: "Old text", tone: "Old tone", cap: 3 });
    await db.execute(sql`UPDATE personas SET display_name = 'Maja', voice = 'Playful' WHERE id = ${seeded.personaId}`);
    await db.execute(sql`UPDATE agents SET limits = '{"dailyImageGenerations": 9, "notes": "keep"}'::jsonb WHERE id = ${seeded.agentId}`);

    await rerunMigration();

    const [persona] = (await db.execute(
      sql`SELECT display_name, backstory, voice FROM personas WHERE id = ${seeded.personaId}`,
    )) as unknown as Row[];
    expect(persona).toEqual({ display_name: "Maja", backstory: "Old text", voice: "Playful" });
    const [agent] = (await db.execute(sql`SELECT persona_id, limits FROM agents WHERE id = ${seeded.agentId}`)) as unknown as Row[];
    expect(agent).toEqual({ persona_id: seeded.personaId, limits: { dailyImageGenerations: 9, notes: "keep" } });
  });

  it("a persona with no picture limit leaves the agent's limits box empty, and a null personality stays null", async () => {
    const seeded = await seedOldShape({ name: "Quick helper", personality: null, tone: null, cap: null });
    await db.execute(sql`UPDATE agents SET avatar_asset_id = NULL WHERE id = ${seeded.agentId}`);

    await rerunMigration();

    const [persona] = (await db.execute(
      sql`SELECT display_name, backstory, voice, avatar_asset_id FROM personas WHERE id = ${seeded.personaId}`,
    )) as unknown as Row[];
    expect(persona).toEqual({ display_name: "Quick helper", backstory: null, voice: null, avatar_asset_id: null });
    const [agent] = (await db.execute(sql`SELECT persona_id, limits FROM agents WHERE id = ${seeded.agentId}`)) as unknown as Row[];
    expect(agent).toEqual({ persona_id: seeded.personaId, limits: {} });
  });

  it("lets two agents share one persona, and a persona exist with no agent at all", async () => {
    const seeded = await seedOldShape({ name: "Maja", personality: null, tone: null, cap: null });
    await rerunMigration();
    const second = randomUUID();
    await db.execute(sql`INSERT INTO agents (id, company_id, name, persona_id) VALUES (${second}, ${seeded.companyId}, 'Accountant', ${seeded.personaId})`);
    const loose = randomUUID();
    await db.execute(sql`INSERT INTO personas (id, company_id, display_name) VALUES (${loose}, ${seeded.companyId}, 'Nobody yet')`);

    const rows = (await db.execute(
      sql`SELECT name FROM agents WHERE persona_id = ${seeded.personaId} ORDER BY name`,
    )) as unknown as Row[];
    expect(rows.map((row) => row.name)).toEqual(["Accountant", "Maja"]);

    // Deleting the person detaches the jobs; it does not delete them.
    await db.execute(sql`DELETE FROM personas WHERE id = ${seeded.personaId}`);
    const after = (await db.execute(
      sql`SELECT name, persona_id FROM agents WHERE id IN (${seeded.agentId}, ${second}) ORDER BY name`,
    )) as unknown as Row[];
    expect(after).toEqual([
      { name: "Accountant", persona_id: null },
      { name: "Maja", persona_id: null },
    ]);
  });

  it("is idempotent: a further run changes nothing and raises nothing", async () => {
    const before = await columns("personas");
    await rerunMigration();
    await rerunMigration();
    expect(await columns("personas")).toEqual(before);
    const counts = (await db.execute(sql`
      SELECT conname, count(*)::int AS n FROM pg_constraint
      WHERE conname IN ('agents_persona_id_personas_id_fk', 'personas_avatar_asset_id_assets_id_fk', 'persona_posts_agent_id_agents_id_fk')
      GROUP BY conname
    `)) as unknown as Row[];
    expect(counts.map((row) => row.n)).toEqual([1, 1, 1]);
  });

  it("the file never deletes data, never drops a column or table, and only fills NULLs", () => {
    const text = readFileSync(MIGRATION_PATH, "utf8")
      .split("\n")
      .map((line) => line.replace(/^\s*--.*$/, ""))
      .join("\n");
    expect(text).not.toMatch(/\bDROP\s+(TABLE|COLUMN|POLICY|ROLE|CONSTRAINT)\b|\bTRUNCATE\b|\bREVOKE\b|\bDELETE\s+FROM\b/i);
    expect(text).not.toMatch(/information_schema\.(tables|columns)/);
    // The only structural relaxations, by name.
    expect(text).toContain('ALTER COLUMN "agent_id" DROP NOT NULL');
    expect(text).toContain('DROP INDEX IF EXISTS "personas_agent_id_uq"');
    // Every UPDATE is guarded on the target being empty.
    const updates = text.match(/UPDATE\s+"[a-z_]+"\s+\w+\s+SET[\s\S]*?;/g) ?? [];
    expect(updates).toHaveLength(3);
    expect(updates[0]).toMatch(/COALESCE\(p\."display_name"/);
    expect(updates[1]).toMatch(/a\."persona_id" IS NULL/);
    expect(updates[2]).toMatch(/NOT \(a\."limits" \? 'dailyImageGenerations'\)/);
  });
});
