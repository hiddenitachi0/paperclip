import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { MorningReportFacts } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { laneAConversations } from "./lane_a_conversations.js";

/**
 * Morning report (migration 0184): the daily briefing a quick agent sends to
 * its operator's Telegram chat at a configured local time.
 *
 * Settings live on agents.morning_report_settings (a jsonb column, see
 * packages/db/src/schema/agents.ts). This table is only the outbox: one row
 * per day a report was actually generated, written 'ready' the moment the
 * one LLM call for that day finishes (server/src/services/morning-report.ts),
 * then picked up by the host-side Telegram bridge (the same poll pattern as
 * watcher_alerts) and flipped to 'delivered' or 'failed'. A ready row nobody
 * picked up within a day becomes 'expired', mirroring watcher_alerts, so an
 * old briefing is never sent late.
 *
 * Unlike watcher_alerts there is no 'composing' status: the LLM call happens
 * inside the detached tick continuation before the row is inserted at all, so
 * a row only ever exists once its text is final.
 */
export const morningReportOutbox = pgTable(
  "morning_report_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("ready"),
    text: text("text").notNull(),
    // Plain words about anything that did not go to plan (a source that could
    // not be fetched, the agent could not write it so the facts went out
    // plain) — same idea as watcher_alerts.note.
    note: text("note"),
    // DUR-4059: the structured facts the report was built from (headlines
    // with their source URL, prices with change%, weather text, picture
    // fileIds) — see packages/shared/src/morning-report.ts's
    // MorningReportFacts. Null for a report written before this column
    // existed; readers fall back to the plain `text` above.
    facts: jsonb("facts").$type<MorningReportFacts>(),
    // DUR-4059: the Lane A conversation this report was appended to as an
    // assistant turn, so a later Telegram reply ("tell me more about number
    // 3") continues the same chat history. Null when the agent is not a
    // quick agent, there is no board owner to attribute it to, or the insert
    // failed — a missing link must never fail the report itself.
    conversationId: uuid("conversation_id").references(() => laneAConversations.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("morning_report_outbox_company_status_idx").on(table.companyId, table.status, table.createdAt),
    agentCreatedIdx: index("morning_report_outbox_agent_created_idx").on(table.agentId, table.createdAt),
    statusCheck: check(
      "morning_report_outbox_status_check",
      sql`${table.status} IN ('ready', 'delivered', 'failed', 'expired')`,
    ),
  }),
);
