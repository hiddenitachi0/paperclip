import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// DUR-217: Lane A conversation anchor. company_id is force-derived from
// agent_id by a BEFORE INSERT/UPDATE trigger (see migration 0128) so a
// caller-supplied mismatched companyId cannot smuggle a cross-company row in
// even if the app-layer check has a bug — same defense-in-depth pattern as
// DUR-110's enforce_issue_child_company_id().
export const laneAConversations = pgTable(
  "lane_a_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    turnCount: integer("turn_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("lane_a_conversations_company_agent_idx").on(table.companyId, table.agentId),
    // Backs the persisted per-employee daily cap: sum turn_count for a
    // requester within a UTC-day window without a full table scan.
    companyRequesterLastMessageIdx: index("lane_a_conversations_company_requester_last_message_idx").on(
      table.companyId,
      table.requestedByUserId,
      table.requestedByAgentId,
      table.lastMessageAt,
    ),
  }),
);
