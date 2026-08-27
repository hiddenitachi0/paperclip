import { pgTable, uuid, text, integer, date, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// DUR-133: marks an agent as a persona — one with a public-facing identity
// that will eventually own social accounts (DUR-134). Name, avatar and
// bio/voice already live on `agents` (avatarAssetId/personality shipped in
// DUR-60/DUR-61, before this table existed), so this table only adds what's
// persona-specific: the handle she posts under, her PERSONA.md rendering
// state, and her lifecycle status. One persona per agent.
export const personas = pgTable(
  "personas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    // Social handle, e.g. "@maja.photog". Not validated against any specific
    // platform's rules here — platform-specific accounts live in DUR-134's
    // persona_accounts table.
    handle: text("handle"),
    status: text("status").notNull().default("draft"),
    // DUR-63 operator decision: no global default cap -- null means
    // unlimited until the operator sets one for this persona at creation.
    dailyGenerationCap: integer("daily_generation_cap"),
    // DUR-177 item 18: how many image generations this persona has used
    // "today" (generationCountDate, UTC) -- enforced atomically by
    // personaGenerationGuard in server/src/services/persona-generation-guard.ts,
    // gating POST /plugins/tools/execute for the media-studio generate-image
    // tool. Lazily reset: a write on a new UTC day resets the counter to 1
    // instead of a scheduled job zeroing every persona out at midnight.
    generationCountToday: integer("generation_count_today").notNull().default(0),
    generationCountDate: date("generation_count_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("personas_company_idx").on(table.companyId),
    agentIdUq: uniqueIndex("personas_agent_id_uq").on(table.agentId),
  }),
);
