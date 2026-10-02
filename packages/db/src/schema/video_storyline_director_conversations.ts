import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { videoStorylines } from "./video_storylines.js";

/**
 * DUR-4327 (backend half of DUR-4325): the AI director conversation anchor --
 * one per storyline (whole-storyline review -> turn-by-turn dialogue ->
 * per-shot proposals), modeled on lane_a_conversations/lane_a_messages
 * (anchor + append-only turns). This is additive on top of, and separate
 * from, video_storyline_director_runs (video-storyline-director.ts): that
 * table stays the existing single-shot "idea -> drafted shots -> approve"
 * flow for one scene at a time; this table is the whole-storyline
 * review/dialogue/proposal flow and is never written to by that service.
 *
 * company_id is force-derived from storyline_id by a BEFORE INSERT/UPDATE
 * trigger (see this table's migration) so a caller-supplied mismatched
 * companyId cannot smuggle a cross-company row in, same defense-in-depth
 * pattern as lane_a_conversations/lane_a_messages.
 */
export const videoStorylineDirectorConversations = pgTable(
  "video_storyline_director_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    storylineId: uuid("storyline_id")
      .notNull()
      .references(() => videoStorylines.id, { onDelete: "cascade" }),
    // reviewing (whole-storyline review just ran) -> asking (turn-by-turn
    // dialogue in progress) -> proposing (per-shot proposals generated,
    // waiting on accept/edit/reject) -> done (every proposal resolved).
    // Re-running review resets an existing conversation back to 'reviewing'.
    status: text("status").notNull().default("reviewing"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One conversation per storyline -- review/dialogue/proposals all share it.
    storylineUq: uniqueIndex("video_storyline_director_conversations_storyline_uq").on(table.storylineId),
    companyIdx: index("video_storyline_director_conversations_company_idx").on(table.companyId),
    statusCheck: check(
      "video_storyline_director_conversations_status_check",
      sql`${table.status} IN ('reviewing', 'asking', 'proposing', 'done')`,
    ),
  }),
);
