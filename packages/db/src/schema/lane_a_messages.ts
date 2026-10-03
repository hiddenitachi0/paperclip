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

/**
 * One model call the fallback loop made while answering a turn (DUR-4347).
 * `rule` names why this entry was tried: `keyword:<ruleId>` (keyword routing
 * picked it as the starting model), `no_answer_chain:<n>` / `refusal_chain:<n>`
 * (its 0-based position in that chain), or `null` for a bare main-model
 * attempt with no routing involved. Kept for the agent page / message-detail
 * view only -- the reply text sent to the person is unchanged regardless of
 * which attempt answered.
 */
export interface LaneAAttemptRecord {
  provider: string;
  model: string;
  outcome: "answered" | "retryable_error" | "refusal" | "error";
  durationMs: number;
  costCents: number;
  rule: string | null;
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
    // "recap" (no migration: the column is plain text): the one row a
    // continued conversation opens with, holding the earlier messages picked
    // for it. It rides in the system prompt, never replayed as a turn
    // (server/src/services/lane-a-continue.ts).
    role: text("role").$type<"user" | "assistant" | "recap">().notNull(),
    content: text("content").notNull(),
    toolCalls: jsonb("tool_calls").$type<LaneAStoredToolCall[]>(),
    // DUR-4347: every model attempt the fallback loop made answering this
    // turn (main + any backups tried), in order. Null/empty for every row
    // written before this column existed, and for a turn that never entered
    // the loop (e.g. a `recap` row). See LaneAAttemptRecord above.
    attempts: jsonb("attempts").$type<LaneAAttemptRecord[]>(),
    // Which chain (if any) produced the reply: "main" (no routing involved),
    // "keyword" (a keyword rule picked the starting model and it answered),
    // "no_answer_chain" or "refusal_chain" (a backup further down one of
    // those chains answered). Null for a row written before this column
    // existed, or for a `recap` row.
    answeredBy: text("answered_by").$type<"main" | "keyword" | "no_answer_chain" | "refusal_chain">(),
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
