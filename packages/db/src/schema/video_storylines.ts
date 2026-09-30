import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/**
 * DUR-4127 (backend half of DUR-4095, video storylines): a storyline is a
 * project-scale video -- up to ~700-1400 clips ("shots") rendered in order,
 * each continuing from the previous shot's last frame, then stitched into
 * one film. `media-generation-job` plugin entities (media-jobs.ts) do not
 * scale to that: they are not queryable by ordering, budget, or
 * stitch-readiness, so this is deliberately a first-class table set rather
 * than a plugin entity. Ships behind the media-studio plugin's per-company
 * `plugin_company_settings.settings_json.videoStorylinesEnabled` flag
 * (default off) -- see server/src/services/video-storyline-settings.ts.
 *
 * Rendering itself reuses the Fal/Sogni video *provider* HTTP clients from
 * packages/plugins/media-studio (FalVideoProvider/SogniVideoProvider), but
 * NOT that plugin's ctx-bound job engine (media-jobs.ts) -- this table set
 * is its own render-job bookkeeping, driven by a server-side scheduler tick
 * (see video-storyline-render.ts) rather than the plugin worker RPC
 * boundary. See the PR description's "Questions for Filip" for why.
 */
export const videoStorylines = pgTable(
  "video_storylines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    // draft -> estimated -> rendering <-> paused -> ready_to_stitch -> stitching -> done
    //   any of draft/estimated/rendering/paused/ready_to_stitch/stitching -> failed | cancelled
    status: text("status").notNull().default("draft"),
    // Which video provider (and therefore continuity behavior) this storyline
    // renders with -- fixed per storyline, since mixing providers mid-story
    // would break last-frame continuity assumptions.
    providerId: text("provider_id").notNull().default("fal"),
    model: text("model"),
    // Null until an operator sets one; startRender refuses to begin without
    // it (see the ground rule: refuse or pause rather than silently spend).
    budgetCapCents: integer("budget_cap_cents"),
    spentCents: integer("spent_cents").notNull().default(0),
    // Cached result of the last POST .../estimate call, shown before a
    // render starts; not authoritative once rendering (spentCents is).
    estimatedTotalCents: integer("estimated_total_cents"),
    estimatedTotalSeconds: integer("estimated_total_seconds"),
    // Attachment ids for the character/Look reference pictures shared by
    // every shot in the storyline (a shot may add its own on top).
    characterReferenceAssetIds: jsonb("character_reference_asset_ids").$type<string[]>().notNull().default([]),
    // Direct-storage pointer for the final stitched film -- deliberately NOT
    // an attachments-table row: a multi-hour concatenated film routinely
    // exceeds the 25MB company-attachment cap (attachment-types.ts), and
    // this table already carries its own company-scoped access control.
    finalProvider: text("final_provider"),
    finalObjectKey: text("final_object_key"),
    finalContentType: text("final_content_type"),
    finalByteSize: integer("final_byte_size"),
    finalSha256: text("final_sha256"),
    finalDurationSeconds: integer("final_duration_seconds"),
    // Set (without failing the storyline) when every shot is done but ffmpeg
    // is not available on this host -- see video-storyline-stitch.ts.
    stitchBlockedReason: text("stitch_blocked_reason"),
    errorMessage: text("error_message"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("video_storylines_company_idx").on(table.companyId, table.createdAt),
    companyStatusIdx: index("video_storylines_company_status_idx").on(table.companyId, table.status),
    stitchQueueIdx: index("video_storylines_stitch_queue_idx").on(table.status, table.updatedAt),
    statusCheck: check(
      "video_storylines_status_check",
      sql`${table.status} IN ('draft', 'estimated', 'rendering', 'paused', 'ready_to_stitch', 'stitching', 'done', 'failed', 'cancelled')`,
    ),
    providerCheck: check("video_storylines_provider_check", sql`${table.providerId} IN ('fal', 'sogni')`),
    budgetCapCheck: check("video_storylines_budget_cap_check", sql`${table.budgetCapCents} IS NULL OR ${table.budgetCapCents} >= 0`),
    spentCentsCheck: check("video_storylines_spent_cents_check", sql`${table.spentCents} >= 0`),
  }),
);

export const videoScenes = pgTable(
  "video_scenes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    storylineId: uuid("storyline_id").notNull().references(() => videoStorylines.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(),
    title: text("title").notNull().default(""),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storylineOrderUq: uniqueIndex("video_scenes_storyline_order_uq").on(table.storylineId, table.orderIndex),
    companyIdx: index("video_scenes_company_idx").on(table.companyId),
    orderCheck: check("video_scenes_order_index_check", sql`${table.orderIndex} >= 0`),
  }),
);

/**
 * A shot is the render unit (one clip). `orderIndex` is global across the
 * whole storyline (not per-scene): render dependency and last-frame
 * continuity both run over the storyline's full shot sequence, so a scene
 * boundary does not reset or interrupt the chain.
 */
export const videoShots = pgTable(
  "video_shots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    storylineId: uuid("storyline_id").notNull().references(() => videoStorylines.id, { onDelete: "cascade" }),
    sceneId: uuid("scene_id").notNull().references(() => videoScenes.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(),
    prompt: text("prompt").notNull(),
    cameraNotes: text("camera_notes"),
    durationSeconds: integer("duration_seconds").notNull().default(5),
    // Shot-specific reference pictures, in addition to the storyline's
    // characterReferenceAssetIds.
    lookReferenceAssetIds: jsonb("look_reference_asset_ids").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("draft"),
    providerId: text("provider_id"),
    model: text("model"),
    // Direct-storage pointer for this shot's rendered clip (see
    // videoStorylines.finalObjectKey doc comment -- same reasoning, applied
    // per-clip so a 700-1400 shot storyline never round-trips base64 through
    // the plugin RPC boundary or the attachment size cap).
    resultProvider: text("result_provider"),
    resultObjectKey: text("result_object_key"),
    resultContentType: text("result_content_type"),
    resultByteSize: integer("result_byte_size"),
    resultSha256: text("result_sha256"),
    estimatedCostCents: integer("estimated_cost_cents"),
    actualCostCents: integer("actual_cost_cents"),
    attempt: integer("attempt").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storylineOrderUq: uniqueIndex("video_shots_storyline_order_uq").on(table.storylineId, table.orderIndex),
    storylineStatusIdx: index("video_shots_storyline_status_idx").on(table.storylineId, table.status),
    sceneIdx: index("video_shots_scene_idx").on(table.sceneId),
    orderCheck: check("video_shots_order_index_check", sql`${table.orderIndex} >= 0`),
    durationCheck: check("video_shots_duration_seconds_check", sql`${table.durationSeconds} > 0 AND ${table.durationSeconds} <= 60`),
    attemptCheck: check("video_shots_attempt_check", sql`${table.attempt} >= 0`),
    statusCheck: check(
      "video_shots_status_check",
      sql`${table.status} IN ('draft', 'queued', 'rendering', 'done', 'failed')`,
    ),
  }),
);

/**
 * One row per render attempt, linking a shot to its underlying media job at
 * the provider (the "render-job table" the ticket asks for). A shot
 * re-rendered twice has two rows here; `video_shots.attempt` says which one
 * is current.
 */
export const videoShotRenderJobs = pgTable(
  "video_shot_render_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    storylineId: uuid("storyline_id").notNull().references(() => videoStorylines.id, { onDelete: "cascade" }),
    shotId: uuid("shot_id").notNull().references(() => videoShots.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull().default(1),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    // The provider's own job/workflow id (Fal request id, Sogni workflow
    // id) -- what advanceOne-equivalent polling in video-storyline-render.ts
    // calls MediaJobProvider.poll()/cancel() with.
    externalId: text("external_id").notNull(),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => ({
    shotIdx: index("video_shot_render_jobs_shot_idx").on(table.shotId, table.attempt),
    pollQueueIdx: index("video_shot_render_jobs_poll_queue_idx").on(table.status, table.startedAt),
    statusCheck: check(
      "video_shot_render_jobs_status_check",
      sql`${table.status} IN ('running', 'done', 'failed')`,
    ),
    providerCheck: check("video_shot_render_jobs_provider_check", sql`${table.provider} IN ('fal', 'sogni')`),
  }),
);
