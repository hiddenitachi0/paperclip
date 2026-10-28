import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0259_media_setup_register (Media Studio film studio, Phase 1): the
 * LoRA library, model setups, setup trials and per-company project defaults,
 * plus the nullable setup columns on directors and storylines. Applies on the
 * embedded-Postgres path, keeps the CHECKs (a video setup only on fal or
 * sogni), polices all four tables by company, is safe to run twice, and rolls
 * back by dropping what it added.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0259 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0259_media_setup_register";
const MIGRATION_PATH = fileURLToPath(new URL(`./migrations/${MIGRATION_TAG}.sql`, import.meta.url));
const TABLES = ["media_loras", "media_model_setups", "media_model_setup_trials", "media_project_defaults"];

type Row = Record<string, unknown>;

function migrationStatements(): string[] {
  return readFileSync(MIGRATION_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

d(`migration ${MIGRATION_TAG}`, () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyA = "";
  let companyB = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0259-media-setups-");
    db = createDb(tempDb.connectionString);
    companyA = randomUUID();
    companyB = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyA}, 'Setups A', 'MSA')`);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyB}, 'Setups B', 'MSB')`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }

  async function insertSetup(companyId: string, fields: { name: string; kind?: string; provider?: string }) {
    const [row] = await rows(
      sql`INSERT INTO media_model_setups (company_id, kind, name, provider, model_id) VALUES (${companyId}, ${fields.kind ?? "video"}, ${fields.name}, ${fields.provider ?? "sogni"}, 'wan3.0-video') RETURNING id`,
    );
    return row.id as string;
  }

  it("creates the four tables with their defaults", async () => {
    const [lora] = await rows(
      sql`INSERT INTO media_loras (company_id, provider, source, ref, name) VALUES (${companyA}, 'sogni', 'catalog', 'h3-better-motion', 'Better Motion') RETURNING content_tag, strength_default, trigger_words, compatible_model_ids, archived_at`,
    );
    expect(lora.content_tag).toBe("unreviewed");
    expect(lora.strength_default).toBeCloseTo(0.6);
    expect(lora.trigger_words).toEqual([]);
    expect(lora.compatible_model_ids).toEqual([]);
    expect(lora.archived_at).toBeNull();

    const setupId = await insertSetup(companyA, { name: "Romantic / calm" });
    const [setup] = await rows(sql`SELECT status, content_rating, loras, params, tags, favorite FROM media_model_setups WHERE id = ${setupId}`);
    expect(setup).toMatchObject({ status: "draft", content_rating: "sfw", loras: [], params: {}, tags: [], favorite: false });

    await db.execute(sql`INSERT INTO media_model_setup_trials (company_id, setup_id, scores) VALUES (${companyA}, ${setupId}, '{"naturalness": 4}'::jsonb)`);
    const [trial] = await rows(sql`SELECT rater_kind, flagged_by_check, scores FROM media_model_setup_trials WHERE setup_id = ${setupId}`);
    expect(trial).toMatchObject({ rater_kind: "human", flagged_by_check: false, scores: { naturalness: 4 } });

    await db.execute(sql`INSERT INTO media_project_defaults (company_id, default_video_setup_id) VALUES (${companyA}, ${setupId})`);
    const [defaults] = await rows(sql`SELECT default_content_rating, default_continuity_mode, setups_seeded_at FROM media_project_defaults WHERE company_id = ${companyA}`);
    expect(defaults).toMatchObject({ default_content_rating: "sfw", default_continuity_mode: "stills", setups_seeded_at: null });
    await expect(db.execute(sql`INSERT INTO media_project_defaults (company_id) VALUES (${companyA})`)).rejects.toThrow();
  });

  it("refuses a video setup outside fal and sogni, unknown values and a duplicate name", async () => {
    await expect(insertSetup(companyA, { name: "Higgs video", kind: "video", provider: "higgsfield" })).rejects.toThrow();
    await insertSetup(companyA, { name: "Higgs stills", kind: "image", provider: "higgsfield" });
    await expect(insertSetup(companyA, { name: "Odd", kind: "audio" })).rejects.toThrow();
    await expect(insertSetup(companyA, { name: "ROMANTIC / CALM" })).rejects.toThrow();
    // The same name in another company is fine.
    await insertSetup(companyB, { name: "Romantic / calm" });
    await expect(
      db.execute(sql`INSERT INTO media_loras (company_id, provider, source, ref, name) VALUES (${companyA}, 'higgsfield', 'catalog', 'x', 'x')`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`INSERT INTO media_loras (company_id, provider, source, ref, name, content_tag) VALUES (${companyA}, 'sogni', 'catalog', 'y', 'y', 'nice')`),
    ).rejects.toThrow();
    // One live row per (company, provider, ref); an archived copy does not block a new one.
    await expect(
      db.execute(sql`INSERT INTO media_loras (company_id, provider, source, ref, name) VALUES (${companyA}, 'sogni', 'catalog', 'h3-better-motion', 'Again')`),
    ).rejects.toThrow();
    await db.execute(sql`UPDATE media_loras SET archived_at = now() WHERE company_id = ${companyA} AND ref = 'h3-better-motion'`);
    await db.execute(sql`INSERT INTO media_loras (company_id, provider, source, ref, name) VALUES (${companyA}, 'sogni', 'catalog', 'h3-better-motion', 'Again')`);
  });

  it("adds nullable setup columns to directors and storylines, set to null when the setup is deleted", async () => {
    const setupId = await insertSetup(companyA, { name: "Action" });
    const [director] = await rows(
      sql`INSERT INTO video_storyline_directors (company_id, name, default_video_setup_id, default_content_rating, default_continuity_mode) VALUES (${companyA}, 'Action director', ${setupId}, 'sfw', 'keyframes') RETURNING id`,
    );
    await expect(
      db.execute(sql`INSERT INTO video_storyline_directors (company_id, name, default_content_rating) VALUES (${companyA}, 'Bad', 'spicy')`),
    ).rejects.toThrow();
    const [storyline] = await rows(
      sql`INSERT INTO video_storylines (company_id, title, video_setup_id) VALUES (${companyA}, 'Film', ${setupId}) RETURNING id, image_setup_id`,
    );
    expect(storyline.image_setup_id).toBeNull();
    const [plain] = await rows(sql`INSERT INTO video_storylines (company_id, title) VALUES (${companyA}, 'Old film') RETURNING video_setup_id`);
    expect(plain.video_setup_id).toBeNull();

    await db.execute(sql`DELETE FROM media_model_setups WHERE id = ${setupId}`);
    const [afterDirector] = await rows(sql`SELECT default_video_setup_id FROM video_storyline_directors WHERE id = ${director.id as string}`);
    expect(afterDirector.default_video_setup_id).toBeNull();
    const [afterStoryline] = await rows(sql`SELECT video_setup_id FROM video_storylines WHERE id = ${storyline.id as string}`);
    expect(afterStoryline.video_setup_id).toBeNull();
  });

  it("polices all four tables by company", async () => {
    for (const table of TABLES) {
      const [flags] = await rows(sql`SELECT relrowsecurity FROM pg_class WHERE relname = ${table} AND relkind = 'r'`);
      expect(flags.relrowsecurity, table).toBe(true);
      const [policy] = await rows(sql`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = ${table} AND policyname = 'paperclip_company_scope'`);
      expect(policy.n, table).toBe(1);
    }
    await insertSetup(companyB, { name: "Company B only" });

    const scoped = postgres(tempDb!.connectionString, { max: 1, onnotice: () => {} });
    try {
      await scoped`SET ROLE paperclip_app_scoped`;
      await scoped`SELECT set_config('app.current_company_id', ${companyA}, false)`;
      const setups = await scoped<{ company_id: string }[]>`SELECT company_id FROM media_model_setups`;
      expect(setups.length).toBeGreaterThan(0);
      expect(new Set(setups.map((r) => r.company_id))).toEqual(new Set([companyA]));
      const loras = await scoped<{ company_id: string }[]>`SELECT company_id FROM media_loras`;
      expect(new Set(loras.map((r) => r.company_id))).toEqual(new Set([companyA]));
      await expect(
        scoped`INSERT INTO media_model_setups (company_id, kind, name, provider, model_id) VALUES (${companyB}, 'video', 'Sneaky', 'sogni', 'x')`,
      ).rejects.toThrow(/row-level security|violates/);
      expect(await scoped`UPDATE media_model_setups SET notes = 'x' WHERE company_id = ${companyB} RETURNING id`).toHaveLength(0);
      expect(await scoped`DELETE FROM media_project_defaults WHERE company_id = ${companyB} RETURNING id`).toHaveLength(0);
    } finally {
      await scoped.end();
    }
  });

  it("is idempotent", async () => {
    for (const statement of migrationStatements()) {
      await db.execute(sql.raw(statement));
    }
    for (const table of TABLES) {
      const [policies] = await rows(sql`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = ${table}`);
      expect(policies.n, table).toBe(1);
    }
    const [checks] = await rows(
      sql`SELECT count(*)::int AS n FROM pg_constraint WHERE conname IN ('video_storyline_directors_content_rating_check', 'video_storyline_directors_continuity_mode_check')`,
    );
    expect(checks.n).toBe(2);
  });

  it("rolls back by dropping what it added, leaving the rest alone", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE "video_storylines" DROP COLUMN "video_setup_id", DROP COLUMN "image_setup_id"`);
      await tx.execute(
        sql`ALTER TABLE "video_storyline_directors" DROP CONSTRAINT "video_storyline_directors_continuity_mode_check", DROP CONSTRAINT "video_storyline_directors_content_rating_check", DROP COLUMN "default_continuity_mode", DROP COLUMN "default_content_rating", DROP COLUMN "default_video_setup_id", DROP COLUMN "default_image_setup_id"`,
      );
      await tx.execute(sql`DROP TABLE "media_model_setup_trials", "media_project_defaults", "media_model_setups", "media_loras"`);
      const [left] = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('media_loras', 'media_model_setups', 'media_model_setup_trials', 'media_project_defaults')`,
      )) as unknown as Row[];
      expect(left.n).toBe(0);
      const [kept] = (await tx.execute(sql`SELECT count(*)::int AS n FROM video_storylines`)) as unknown as Row[];
      expect(kept.n).toBeGreaterThan(0);
      throw new Error("rollback");
    }).catch((error: Error) => expect(error.message).toBe("rollback"));
    const [present] = await rows(sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'media_model_setups'`);
    expect(present.n).toBe(1);
  });
});
