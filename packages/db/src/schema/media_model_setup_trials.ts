import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { mediaModelSetups } from "./media_model_setups.js";
import { personas } from "./personas.js";
import { videoStorylines } from "./video_storylines.js";

/**
 * Media Studio film studio, Phase 1 (migration 0259): the setup register.
 * One row per try of one model setup -- on one benchmark shot, or on a copy
 * of a whole storyline (storyline_id) for a side-by-side comparison such as
 * "30 s on H3 vs Wan 3" -- with the rater's 1-5 scores
 * ({naturalness, movement, faceContinuity, outfitStability, promptFollowing},
 * validated in packages/shared/src/media-setups.ts), what it cost, how long it
 * took, and whether the picture check or the provider flagged the result.
 * The setup's SFW/NSFW tendency is computed from these flags plus the model
 * and LoRA tags; it is never typed in.
 *
 * Kept in its own file so media_model_setups.ts does not import
 * video_storylines.ts (which points back at media_model_setups).
 * style_id and scenery_id arrive in Phase 2, once those tables exist.
 */
export const mediaModelSetupTrials = pgTable(
  "media_model_setup_trials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    setupId: uuid("setup_id").notNull().references(() => mediaModelSetups.id, { onDelete: "cascade" }),
    storylineId: uuid("storyline_id").references(() => videoStorylines.id, { onDelete: "set null" }),
    personaId: uuid("persona_id").references(() => personas.id, { onDelete: "set null" }),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull().default({}),
    prompt: text("prompt"),
    // A picture or clip in the company's Files (no FK: the file may be removed later without losing the score).
    resultFileId: uuid("result_file_id"),
    scores: jsonb("scores").$type<Record<string, number>>().notNull().default({}),
    flaggedByCheck: boolean("flagged_by_check").notNull().default(false),
    flaggedByProvider: boolean("flagged_by_provider").notNull().default(false),
    costCents: integer("cost_cents"),
    secondsTaken: integer("seconds_taken"),
    // human | ai (an AI judge's scores are shown apart from a person's)
    raterKind: text("rater_kind").notNull().default("human"),
    raterId: text("rater_id"),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    setupIdx: index("media_model_setup_trials_setup_idx").on(table.setupId, table.createdAt),
    companyIdx: index("media_model_setup_trials_company_idx").on(table.companyId),
    storylineIdx: index("media_model_setup_trials_storyline_idx").on(table.storylineId),
    raterKindCheck: check("media_model_setup_trials_rater_kind_check", sql`${table.raterKind} IN ('human', 'ai')`),
    costCheck: check("media_model_setup_trials_cost_check", sql`${table.costCents} IS NULL OR ${table.costCents} >= 0`),
    secondsCheck: check("media_model_setup_trials_seconds_check", sql`${table.secondsTaken} IS NULL OR ${table.secondsTaken} >= 0`),
  }),
);
