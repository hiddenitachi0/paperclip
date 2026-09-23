import { pgTable, uuid, text, date, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// DUR-4000 (migration 0175): per-agent daily counters, one row per
// (agent, kind, UTC calendar day). The daily limits an agent carries in
// agents.limits are enforced against these rows in code, at the moment of
// the action (server/src/services/agent-daily-limits.ts), never as prompt
// guidance. `kind` today: "image_generation" (agents.limits.dailyImageGenerations).
//
// Replaces persona_generation_counters as the thing the image limit reads:
// limits belong to the job (the agent), not to the person (the persona),
// because one persona can now hold several jobs with different limits.
//
// Deliberately its own table rather than inferred from assets/attachments:
// those rows can be written by paths that are not "an image generation"
// (manual upload, avatar upload) and would make the count drift. Every kind
// is written from exactly one call site.
export const agentDailyCounters = pgTable(
  "agent_daily_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    // UTC calendar day, e.g. "2026-09-23"; no per-company timezone exists.
    day: date("day").notNull(),
    count: integer("count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentKindDayUq: uniqueIndex("agent_daily_counters_agent_kind_day_uq").on(table.agentId, table.kind, table.day),
    companyIdx: index("agent_daily_counters_company_idx").on(table.companyId),
  }),
);
