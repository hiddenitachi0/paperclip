import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { laneAConversations } from "./lane_a_conversations.js";

/**
 * A picture an add-on tool made during the turn. The server fills this in
 * only after checking the file is a picture in the conversation's own
 * company, so the chat can show it and the Telegram bridge can send it.
 */
export interface LaneAToolImage {
  /** The company file (issue_attachments id) the picture is stored as. */
  fileId: string;
  /** Same-origin address of the picture; needs a signed-in session. */
  contentPath: string;
  contentType: string;
  /** The seed the picture was made with, when the tool reported one. */
  seed: number | null;
  /** The task it is attached to, or null when it is a company file with no task. */
  issueId: string | null;
}

/** One tool call a quick agent made while answering a message, kept for the operator to see. */
export interface LaneAStoredToolCall {
  tool: string;
  /** Plain-language one-liner of what happened, e.g. "Handed to Bob as task DUR-12". */
  summary: string;
  ok: boolean;
  /** Set when the tool made a picture (see LaneAToolImage). */
  image?: LaneAToolImage;
  /**
   * Set when the tool created a task (a hand-over to a colleague, or a
   * research task for the quick agent itself), so the chat can follow it and
   * show its answer when it is done.
   */
  task?: { issueId: string; identifier: string | null; title: string };
}

// Quick agents (Lane A, round 2): the transcript of a Lane A conversation, one
// row per turn. company_id is force-derived from the parent conversation by a
// BEFORE INSERT/UPDATE trigger (migration 0162), same defense-in-depth pattern
// as lane_a_conversations itself.
export const laneAMessages = pgTable(
  "lane_a_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => laneAConversations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    toolCalls: jsonb("tool_calls").$type<LaneAStoredToolCall[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationCreatedIdx: index("lane_a_messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    companyAgentIdx: index("lane_a_messages_company_agent_idx").on(table.companyId, table.agentId),
  }),
);
