import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { videoStorylineDirectorConversations } from "./video_storyline_director_conversations.js";

/**
 * DUR-4327: append-only transcript of a whole-storyline director
 * conversation, one row per turn -- same shape as lane_a_messages. `role`
 * is who said it (the AI director, or the person); `kind` is what it is
 * (a whole-storyline review, a dialogue question, a person's answer, a
 * per-shot proposal batch, or a system note). `payload` carries the
 * structured content -- shape depends on `kind` (see
 * packages/shared/src/video-storyline-director-conversation.ts).
 *
 * company_id is force-derived from the parent conversation by a BEFORE
 * INSERT/UPDATE trigger (see this table's migration), same defense-in-depth
 * pattern as lane_a_messages (migration 0162).
 */
export const videoStorylineDirectorMessages = pgTable(
  "video_storyline_director_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => videoStorylineDirectorConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationCreatedIdx: index("video_storyline_director_messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    companyIdx: index("video_storyline_director_messages_company_idx").on(table.companyId),
    roleCheck: check("video_storyline_director_messages_role_check", sql`${table.role} IN ('director', 'person')`),
    kindCheck: check(
      "video_storyline_director_messages_kind_check",
      sql`${table.kind} IN ('review', 'question', 'answer', 'proposal', 'system')`,
    ),
  }),
);
