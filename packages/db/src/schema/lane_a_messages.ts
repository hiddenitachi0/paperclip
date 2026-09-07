import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { laneAConversations } from "./lane_a_conversations.js";

/** One tool call a quick agent made while answering a message, kept for the operator to see. */
export interface LaneAStoredToolCall {
  tool: string;
  /** Plain-language one-liner of what happened, e.g. "Handed to Bob as task DUR-12". */
  summary: string;
  ok: boolean;
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
