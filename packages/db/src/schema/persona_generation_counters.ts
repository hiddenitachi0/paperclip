import { pgTable, uuid, date, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { personas } from "./personas.js";

// DUR-177: enforces personas.dailyGenerationCap in code, at the moment an
// agent invokes the media-studio `generate-image` tool -- not as prompt
// guidance. One row per (persona, UTC calendar day); `count` is the number
// of generations reserved (allowed through the gate) so far that day.
//
// Deliberately its own table rather than inferred from `issue_attachments` /
// `assets`: those rows can be created by paths that have nothing to do with
// "an image generation" (manual attachment upload, agent avatar upload,
// etc.), which would make the cap over- or under-count depending on what
// else the persona's agent identity happens to touch that day. This table
// is written to from exactly one place -- the generate-image tool handler --
// so it counts precisely what the ticket asks it to cap.
export const personaGenerationCounters = pgTable(
  "persona_generation_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    personaId: uuid("persona_id").notNull().references(() => personas.id, { onDelete: "cascade" }),
    // UTC calendar day, e.g. "2026-08-25". See persona-generation-cap.ts for
    // why UTC (no per-company timezone concept exists elsewhere for this).
    day: date("day").notNull(),
    count: integer("count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    personaDayUq: uniqueIndex("persona_generation_counters_persona_day_uq").on(table.personaId, table.day),
  }),
);
