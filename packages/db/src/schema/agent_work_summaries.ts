import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * DUR-4197: a short, already-redacted work summary saved at the end of each
 * successful full-agent heartbeat run (server/src/services/heartbeat.ts
 * writes it, reusing buildDetectedSuccessfulRunProgressSummary for the text),
 * so a later run of the same agent can search what it did before instead of
 * starting cold. One row per run (run_id is unique: a retried finalize is a
 * no-op, never a duplicate).
 *
 * Always read and written company-scoped, and search is additionally scoped
 * to the requesting agent's own summaries only -- see
 * server/src/services/agent-work-summaries.ts and
 * routes/agent-work-summaries.ts. issue_id is nullable and set null if the
 * issue is later deleted: the summary itself is independent evidence of what
 * happened and is kept.
 */
export const agentWorkSummaries = pgTable(
  "agent_work_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentCreatedIdx: index("agent_work_summaries_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    runUniqueIdx: uniqueIndex("agent_work_summaries_run_unique_idx").on(table.runId),
    summaryLengthCheck: check(
      "agent_work_summaries_summary_length_check",
      sql`char_length(${table.summary}) BETWEEN 1 AND 2000`,
    ),
  }),
);
