import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Media Studio film studio, Phase 1 (migration 0259): the LoRA library, the
 * saved model setups ("Action" = MiniMax H3 + Better Motion at 0.8, ...) and
 * the company's new-project defaults. The setup trials (the register's
 * scores) live in media_model_setup_trials.ts.
 *
 *   media_loras            the company's saved LoRAs: a Sogni catalog id, the
 *                          account's own imported Sogni LoRA ("personal-..."),
 *                          or a link (Hugging Face, Civitai) the server never
 *                          fetches; it is only handed to the provider.
 *                          content_tag: sfw | mature | refused | unreviewed
 *                          (unreviewed counts as mature until an owner or
 *                          admin reviews it). Filter-bypass LoRAs are refused
 *                          on save and never stored.
 *   media_model_setups     a saved recipe: kind (image | video), provider,
 *                          exact model id, LoRAs from the library with an
 *                          explicit strength each, params (promptExpansion is
 *                          always explicit), content rating (raised to
 *                          mature when any part is mature), status
 *                          (draft | approved | archived; agents only ever see
 *                          approved ones).
 *   media_project_defaults one row per company: default picture and video
 *                          setups, the default content rating (also used by
 *                          the Create tab and agent pictures) and the default
 *                          continuity mode. setups_seeded_at records that the
 *                          starter setups were created once (deleting them
 *                          later does not bring them back).
 *
 * builtin_key marks the starters every company gets; they are ordinary rows
 * the company may edit, archive or delete.
 *
 * Enumerations are plain text columns with CHECKs, validated again by the zod
 * schemas in packages/shared/src/media-setups.ts. A video setup may only use
 * fal or sogni, because video_storylines and video_shot_render_jobs allow
 * only those two.
 */
export const mediaLoras = pgTable(
  "media_loras",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // sogni | fal
    provider: text("provider").notNull(),
    // catalog | personal | url
    source: text("source").notNull(),
    // The Sogni catalog id ("h3-better-motion"), the personal id ("personal-..."), or an https link.
    ref: text("ref").notNull(),
    name: text("name").notNull(),
    notes: text("notes").notNull().default(""),
    triggerWords: text("trigger_words").array().notNull().default([]),
    // h3 | krea2 | moss | flux | wan21 | wan22 | ltx2 | ... (free text, used to check fit)
    family: text("family"),
    // Exact model ids the LoRA works with ({} = decided by the family).
    compatibleModelIds: text("compatible_model_ids").array().notNull().default([]),
    contentTag: text("content_tag").notNull().default("unreviewed"),
    // What the provider itself says (Sogni ui.nsfw / ui.sexual); a flagged LoRA can never be tagged sfw.
    providerNsfw: boolean("provider_nsfw").notNull().default(false),
    providerSexual: boolean("provider_sexual").notNull().default(false),
    // The LoRA's own strength scale (native values, never percentages).
    strengthMin: real("strength_min"),
    strengthMax: real("strength_max"),
    strengthDefault: real("strength_default").notNull().default(0.6),
    recommendedMin: real("recommended_min"),
    recommendedMax: real("recommended_max"),
    builtinKey: text("builtin_key"),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("media_loras_company_idx").on(table.companyId, table.provider),
    companyRefUq: uniqueIndex("media_loras_company_ref_uq")
      .on(table.companyId, table.provider, table.ref)
      .where(sql`${table.archivedAt} IS NULL`),
    companyBuiltinUq: uniqueIndex("media_loras_company_builtin_uq")
      .on(table.companyId, table.builtinKey)
      .where(sql`${table.builtinKey} IS NOT NULL`),
    providerCheck: check("media_loras_provider_check", sql`${table.provider} IN ('sogni', 'fal')`),
    sourceCheck: check("media_loras_source_check", sql`${table.source} IN ('catalog', 'personal', 'url')`),
    contentTagCheck: check("media_loras_content_tag_check", sql`${table.contentTag} IN ('sfw', 'mature', 'refused', 'unreviewed')`),
  }),
);

export const mediaModelSetups = pgTable(
  "media_model_setups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // image | video
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // sogni | fal | higgsfield | comfyui (video: sogni | fal only)
    provider: text("provider").notNull(),
    family: text("family"),
    // t2i | edit | t2v | i2v | flf2v | r2v | extend
    mode: text("mode"),
    modelId: text("model_id").notNull(),
    // Used when a step needs more reference pictures than the main model takes.
    editModelId: text("edit_model_id"),
    // [{ loraId, strength }] -- every strength explicit (Sogni runs a LoRA at 1.0 when it is left out).
    loras: jsonb("loras").$type<Array<{ loraId: string; strength: number }>>().notNull().default([]),
    // { promptExpansion: boolean, ... } -- promptExpansion is always set.
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    // sfw | mature (raised to mature when the model or any LoRA is mature)
    contentRating: text("content_rating").notNull().default("sfw"),
    matureEnabledByUserId: text("mature_enabled_by_user_id"),
    // draft | approved | archived
    status: text("status").notNull().default("draft"),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    tags: text("tags").array().notNull().default([]),
    favorite: boolean("favorite").notNull().default(false),
    notes: text("notes").notNull().default(""),
    builtinKey: text("builtin_key"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKindIdx: index("media_model_setups_company_kind_idx").on(table.companyId, table.kind, table.status),
    companyNameUq: uniqueIndex("media_model_setups_company_name_uq").on(table.companyId, sql`lower(${table.name})`),
    companyBuiltinUq: uniqueIndex("media_model_setups_company_builtin_uq")
      .on(table.companyId, table.builtinKey)
      .where(sql`${table.builtinKey} IS NOT NULL`),
    kindCheck: check("media_model_setups_kind_check", sql`${table.kind} IN ('image', 'video')`),
    providerCheck: check(
      "media_model_setups_provider_check",
      sql`${table.provider} IN ('sogni', 'fal', 'higgsfield', 'comfyui') AND (${table.kind} = 'image' OR ${table.provider} IN ('sogni', 'fal'))`,
    ),
    contentRatingCheck: check("media_model_setups_content_rating_check", sql`${table.contentRating} IN ('sfw', 'mature')`),
    statusCheck: check("media_model_setups_status_check", sql`${table.status} IN ('draft', 'approved', 'archived')`),
  }),
);

export const mediaProjectDefaults = pgTable(
  "media_project_defaults",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    defaultImageSetupId: uuid("default_image_setup_id").references(() => mediaModelSetups.id, { onDelete: "set null" }),
    defaultVideoSetupId: uuid("default_video_setup_id").references(() => mediaModelSetups.id, { onDelete: "set null" }),
    // sfw | mature
    defaultContentRating: text("default_content_rating").notNull().default("sfw"),
    // stills | keyframes (keyframes only once the pilot passes, D6)
    defaultContinuityMode: text("default_continuity_mode").notNull().default("stills"),
    setupsSeededAt: timestamp("setups_seeded_at", { withTimezone: true }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("media_project_defaults_company_uq").on(table.companyId),
    contentRatingCheck: check("media_project_defaults_content_rating_check", sql`${table.defaultContentRating} IN ('sfw', 'mature')`),
    continuityModeCheck: check(
      "media_project_defaults_continuity_mode_check",
      sql`${table.defaultContinuityMode} IN ('stills', 'keyframes')`,
    ),
  }),
);
