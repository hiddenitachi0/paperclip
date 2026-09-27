import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companyApiTools } from "./company_api_tools.js";

/**
 * DUR-4004: one row per call an "API with a key" tool makes (or refuses to
 * make), modelled on data_read_events.
 *
 * Two jobs: the audit trail ("which agent called which action, when, and how
 * it went") and the counter the tool's daily_cap is enforced from, so the
 * limit survives a restart instead of living in memory.
 *
 * A call is written as `started` before the request goes out (no row, no
 * call) and updated to its outcome after; a refusal at the daily cap writes
 * at most one `rate_limited` row per tool per hour.
 *
 * Deliberately narrow: no request input, no response body, no error text.
 * Those can carry anything the upstream sent back, so they stay out of the
 * database; the activity log (quick agents) and the run log (full agents)
 * carry the bounded summaries.
 */
export const companyApiToolCalls = pgTable(
  "company_api_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Null once the tool is deleted; the audit row stays.
    toolId: uuid("tool_id").references(() => companyApiTools.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    // Who called: a quick agent in chat, a full agent in a run, a board user
    // (the Test button or a manual run). Agent and user ids are plain
    // columns without a foreign key, same as data_read_events, so a deleted
    // agent never deletes its audit trail.
    channel: text("channel").notNull(),
    agentId: uuid("agent_id"),
    userId: text("user_id"),
    runId: text("run_id"),
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("company_api_tool_calls_company_created_idx").on(table.companyId, table.createdAt),
    toolCreatedIdx: index("company_api_tool_calls_tool_created_idx").on(table.toolId, table.createdAt),
    channelCheck: check(
      "company_api_tool_calls_channel_check",
      sql`${table.channel} IN ('quick_chat', 'agent_run', 'board', 'settings_test')`,
    ),
    statusCheck: check(
      "company_api_tool_calls_status_check",
      sql`${table.status} IN ('started', 'ok', 'upstream_error', 'network_error', 'refused', 'rate_limited')`,
    ),
  }),
);
