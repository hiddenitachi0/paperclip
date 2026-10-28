import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

/**
 * Migration 0258_storyline_content_rating (DUR-4895, film studio Phase 0):
 * video_storylines.content_rating (+ set_by/set_at) defaulting to 'sfw', and the
 * data fix that clears the provider/model pin of unfinished shots with no render
 * job in flight while finished shots keep theirs.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping migration 0258 test: ${support.reason ?? "unsupported environment"}`);
}

const MIGRATION_TAG = "0258_storyline_content_rating";
const MIGRATION_PATH = fileURLToPath(new URL(`./migrations/${MIGRATION_TAG}.sql`, import.meta.url));

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
  let companyId = "";
  let storylineId = "";
  let sceneId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-0258-content-rating-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    storylineId = randomUUID();
    sceneId = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Rating Co', 'RTG')`);
    await db.execute(sql`INSERT INTO video_storylines (id, company_id, title) VALUES (${storylineId}, ${companyId}, 'Film')`);
    await db.execute(sql`INSERT INTO video_scenes (id, company_id, storyline_id, order_index) VALUES (${sceneId}, ${companyId}, ${storylineId}, 0)`);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await db.execute(query)) as unknown as Row[];
  }

  let nextOrder = 0;
  async function insertShot(status: string, providerId: string | null, model: string | null): Promise<string> {
    const id = randomUUID();
    await db.execute(
      sql`INSERT INTO video_shots (id, company_id, storyline_id, scene_id, order_index, prompt, status, provider_id, model) VALUES (${id}, ${companyId}, ${storylineId}, ${sceneId}, ${nextOrder++}, 'p', ${status}, ${providerId}, ${model})`,
    );
    return id;
  }

  async function insertJob(shotId: string, status: string) {
    await db.execute(
      sql`INSERT INTO video_shot_render_jobs (company_id, storyline_id, shot_id, provider, model, external_id, status) VALUES (${companyId}, ${storylineId}, ${shotId}, 'fal', 'fal-ai/kling-video/v1.6/standard/image-to-video', ${randomUUID()}, ${status})`,
    );
  }

  async function pin(shotId: string): Promise<{ provider_id: string | null; model: string | null }> {
    const [row] = await rows(sql`SELECT provider_id, model FROM video_shots WHERE id = ${shotId}`);
    return row as { provider_id: string | null; model: string | null };
  }

  it("defaults a new storyline to sfw with no setter recorded, and refuses other values", async () => {
    const [row] = await rows(sql`SELECT content_rating, content_rating_set_by, content_rating_set_at FROM video_storylines WHERE id = ${storylineId}`);
    expect(row).toEqual({ content_rating: "sfw", content_rating_set_by: null, content_rating_set_at: null });
    await db.execute(sql`UPDATE video_storylines SET content_rating = 'mature', content_rating_set_by = 'user-1', content_rating_set_at = now() WHERE id = ${storylineId}`);
    await expect(db.execute(sql`UPDATE video_storylines SET content_rating = 'nsfw' WHERE id = ${storylineId}`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE video_storylines SET content_rating = NULL WHERE id = ${storylineId}`)).rejects.toThrow();
    await db.execute(sql`UPDATE video_storylines SET content_rating = 'sfw', content_rating_set_by = NULL, content_rating_set_at = NULL WHERE id = ${storylineId}`);
  });

  it("makes storylines that existed before the migration sfw", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE "video_storylines" DROP CONSTRAINT "video_storylines_content_rating_check"`);
      await tx.execute(sql`ALTER TABLE "video_storylines" DROP COLUMN "content_rating", DROP COLUMN "content_rating_set_by", DROP COLUMN "content_rating_set_at"`);
      for (const statement of migrationStatements()) {
        await tx.execute(sql.raw(statement));
      }
      const result = (await tx.execute(
        sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE content_rating = 'sfw')::int AS sfw FROM video_storylines`,
      )) as unknown as Row[];
      expect(result[0].total).toBeGreaterThan(0);
      expect(result[0].sfw).toBe(result[0].total);
      throw new Error("rollback");
    }).catch((error: Error) => expect(error.message).toBe("rollback"));
  });

  it("clears the pin of unfinished shots with no job in flight, and leaves everything else", async () => {
    const draft = await insertShot("draft", "fal", "m-draft");
    const queued = await insertShot("queued", "fal", "m-queued");
    const failed = await insertShot("failed", "sogni", "m-failed");
    const failedWithOldJob = await insertShot("failed", "fal", "m-failed-job");
    await insertJob(failedWithOldJob, "failed");
    const rendering = await insertShot("rendering", "fal", "m-rendering");
    await insertJob(rendering, "running");
    const stuckRendering = await insertShot("rendering", "fal", "m-stuck");
    await insertJob(stuckRendering, "done");
    const done = await insertShot("done", "fal", "fal-ai/kling-video/v1.6/standard/image-to-video");
    await insertJob(done, "done");
    const doneNoJob = await insertShot("done", "fal", "fal-ai/kling-video/v2.1/master/image-to-video");
    const unpinnedDraft = await insertShot("draft", null, null);

    for (const statement of migrationStatements()) {
      await db.execute(sql.raw(statement));
    }

    const cleared = { provider_id: null, model: null };
    expect(await pin(draft)).toEqual(cleared);
    expect(await pin(queued)).toEqual(cleared);
    expect(await pin(failed)).toEqual(cleared);
    expect(await pin(failedWithOldJob)).toEqual(cleared);
    expect(await pin(stuckRendering)).toEqual(cleared);
    expect(await pin(unpinnedDraft)).toEqual(cleared);
    expect(await pin(rendering)).toEqual({ provider_id: "fal", model: "m-rendering" });
    expect(await pin(done)).toEqual({ provider_id: "fal", model: "fal-ai/kling-video/v1.6/standard/image-to-video" });
    expect(await pin(doneNoJob)).toEqual({ provider_id: "fal", model: "fal-ai/kling-video/v2.1/master/image-to-video" });

    // Up-only and idempotent: a second run changes nothing.
    const before = await rows(sql`SELECT id, provider_id, model, updated_at FROM video_shots ORDER BY id`);
    for (const statement of migrationStatements()) {
      await db.execute(sql.raw(statement));
    }
    expect(await rows(sql`SELECT id, provider_id, model, updated_at FROM video_shots ORDER BY id`)).toEqual(before);
  });

  it("rolls back by dropping the rating columns, leaving the storylines alone", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE "video_storylines" DROP CONSTRAINT "video_storylines_content_rating_check"`);
      await tx.execute(sql`ALTER TABLE "video_storylines" DROP COLUMN "content_rating_set_at", DROP COLUMN "content_rating_set_by", DROP COLUMN "content_rating"`);
      const [gone] = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'video_storylines' AND column_name LIKE 'content_rating%'`,
      )) as unknown as Row[];
      expect(gone.n).toBe(0);
      const [kept] = (await tx.execute(sql`SELECT count(*)::int AS n FROM video_storylines`)) as unknown as Row[];
      expect(kept.n).toBeGreaterThan(0);
      throw new Error("rollback");
    }).catch((error: Error) => expect(error.message).toBe("rollback"));
    const [present] = await rows(sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'video_storylines' AND column_name LIKE 'content_rating%'`);
    expect(present.n).toBe(3);
  });
});
