import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
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
    // Enforcement (blocking generation once hit) is separate follow-up work
    // in the routine that briefs her; this column is storage only.
    dailyGenerationCap: integer("daily_generation_cap"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("personas_company_idx").on(table.companyId),
    agentIdUq: uniqueIndex("personas_agent_id_uq").on(table.agentId),
  }),
);
