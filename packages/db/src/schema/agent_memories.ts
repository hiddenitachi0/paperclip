import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { personas } from "./personas.js";

/**
 * Quick-agent memory notebook (migration 0180): short notes a quick agent was
 * asked to remember, in the words of the person who asked, plus notes the
 * operator adds or edits on the agent's page.
 *
 * Who a note belongs to:
 *   - persona_id set   -> the PERSON (personas row). Every job that person
 *                         holds reads it; agent_id only says which job it was
 *                         added through.
 *   - persona_id null  -> the JOB (agents row) named by agent_id.
 * A note is written with the persona of the agent at that moment, so a quick
 * agent with a persona reads its persona's notes, otherwise its own.
 *
 * `source` is who wrote it: 'agent' (the quick agent's `remember` tool, on a
 * person's request), 'user' (typed on the agent's page) or 'reaction' (written
 * by the reaction summariser, DUR-4345; rewritten wholesale on each run).
 * `created_by_user_id` is the person who asked or typed it, when known.
 *
 * The 500-character limit is checked by the API and again here; the
 * 100-notes-per-owner cap is checked in the service
 * (server/src/services/agent-memories.ts).
 */
export const agentMemories = pgTable(
  "agent_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    personaId: uuid("persona_id").references(() => personas.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    source: text("source").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("agent_memories_company_agent_idx").on(table.companyId, table.agentId, table.createdAt),
    companyPersonaIdx: index("agent_memories_company_persona_idx").on(table.companyId, table.personaId, table.createdAt),
    sourceCheck: check("agent_memories_source_check", sql`${table.source} IN ('agent', 'user', 'reaction')`),
    textLengthCheck: check(
      "agent_memories_text_length_check",
      sql`char_length(${table.text}) BETWEEN 1 AND 500`,
    ),
  }),
);
