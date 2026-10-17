import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { videoStorylineDirectors } from "./video_storyline_directors.js";
import { videoStorylines } from "./video_storylines.js";

/**
 * The AI story writer's chat for one storyline (step 1), append-only: the
 * person's brief, the picture analysis, the writer's questions and the
 * answers, what was written, change requests, and the lists of changes the
 * person accepts or rejects (status on a 'change_set' row). Payload shapes:
 * packages/shared/src/video-storyline-directors.ts.
 *
 * company_id is forced to the storyline's company by a BEFORE INSERT/UPDATE
 * trigger (see this table's migration), same defence in depth as
 * video_storyline_director_messages.
 */
export const videoStorylineWriterMessages = pgTable(
  "video_storyline_writer_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    storylineId: uuid("storyline_id")
      .notNull()
      .references(() => videoStorylines.id, { onDelete: "cascade" }),
    directorId: uuid("director_id").references(() => videoStorylineDirectors.id, { onDelete: "set null" }),
    role: text("role").notNull(),
    kind: text("kind").notNull(),
    status: text("status"),
    payload: jsonb("payload").notNull().default({}),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storylineCreatedIdx: index("video_storyline_writer_messages_storyline_created_idx").on(table.storylineId, table.createdAt),
    companyIdx: index("video_storyline_writer_messages_company_idx").on(table.companyId),
    roleCheck: check("video_storyline_writer_messages_role_check", sql`${table.role} IN ('writer', 'person', 'system')`),
    kindCheck: check(
      "video_storyline_writer_messages_kind_check",
      sql`${table.kind} IN ('brief', 'analysis', 'question', 'answer', 'storyboard', 'change_request', 'change_set', 'note')`,
    ),
    statusCheck: check(
      "video_storyline_writer_messages_status_check",
      sql`${table.status} IS NULL OR ${table.status} IN ('pending', 'applied', 'partly_applied', 'discarded')`,
    ),
  }),
);
