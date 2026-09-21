import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { dataConnections } from "./data_connections.js";

/**
 * DUR-3972 slice S1: one row per business-data lookup, refusals included.
 *
 * Two jobs. It is the audit trail ("which agent read what, when, and what was
 * it handed"), and it is the counter every lookup limit is computed from, so
 * limits survive a restart instead of living in memory.
 *
 * `params` holds only the normalised input and `facts` only the numbers handed
 * back (capped at 8 KB by a check constraint). Neither may ever carry a
 * credential; the writer scrubs both before insert.
 */
export const dataReadEvents = pgTable(
  "data_read_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    connectionId: uuid("connection_id").references(() => dataConnections.id, { onDelete: "set null" }),
    dataset: text("dataset").notNull(),
    channel: text("channel").notNull(),
    agentId: uuid("agent_id"),
    userId: text("user_id"),
    runId: text("run_id"),
    laneAConversationId: uuid("lane_a_conversation_id"),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    outcome: text("outcome").notNull(),
    refusalCode: text("refusal_code"),
    facts: jsonb("facts").$type<Record<string, unknown>>(),
    upstreamRequests: integer("upstream_requests").notNull().default(0),
    costPoints: integer("cost_points").notNull().default(0),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("data_read_events_company_created_idx").on(table.companyId, table.createdAt),
    agentCreatedIdx: index("data_read_events_agent_created_idx").on(table.agentId, table.createdAt),
    runIdx: index("data_read_events_run_idx").on(table.runId),
    channelCheck: check(
      "data_read_events_channel_check",
      sql`${table.channel} IN ('quick_chat', 'telegram', 'settings_test')`,
    ),
    outcomeCheck: check(
      "data_read_events_outcome_check",
      sql`${table.outcome} IN ('ok', 'no_data', 'ambiguous', 'refused', 'rate_limited', 'upstream_error')`,
    ),
    factsSizeCheck: check(
      "data_read_events_facts_size_check",
      sql`${table.facts} IS NULL OR octet_length(${table.facts}::text) <= 8192`,
    ),
  }),
);
