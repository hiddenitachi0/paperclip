import { pgTable, uuid, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// DUR-133 / DUR-4000: a persona is a PERSON — a name, pronouns, traits, a
// backstory, a voice and a picture — that lives in one place. An agent is a
// JOB (instructions, tools, data, limits) that may have one persona attached
// through agents.persona_id; the same persona can hold many jobs, full and
// quick. The agent keeps its own name. Nothing here ever writes back onto an
// agent row.
export const personas = pgTable(
  "personas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // LEGACY (pre-0175): the one agent this persona used to belong to. Kept,
    // nullable and no longer unique, so an older build still reads it and
    // the 0175 backfill into agents.persona_id can be checked against it.
    // The server does not write it any more; read agents.persona_id instead.
    // ON DELETE SET NULL (re-pointed in 0175 from 0142's CASCADE): deleting
    // the old job must never delete the person or their other jobs.
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    // The person's own identity (DUR-4000, migration 0175). display_name is
    // required by the API on create; the column is nullable only so the
    // migration could add it to existing rows before backfilling.
    displayName: text("display_name"),
    // Free text, e.g. "she/her", "he/him", "they/them", "hen". Never assumed;
    // when unset, prompts and screens use the person's name or "they".
    pronouns: text("pronouns"),
    // Short: a few words or lines on character ("curious, dry humour, never
    // rushes an answer").
    traits: text("traits"),
    // Long: who this person is — history, likes, dislikes, appearance. Fills
    // the slot agents.personality filled before; when a persona is attached,
    // the agent's own personality text is ignored so nothing is said twice.
    backstory: text("backstory"),
    // How this person writes. When set, it wins over the attached agent's
    // tone (agents.tone stays as the agent's default).
    voice: text("voice"),
    // Plain uuid, no `.references()` — a typed FK reference here would be a
    // schema import cycle (assets.ts imports agents.ts, which this file
    // imports). The FK (assets(id) ON DELETE SET NULL) is declared by hand in
    // 0175_persona_identity.sql, exactly as 0132 did for agents.
    avatarAssetId: uuid("avatar_asset_id"),
    // Social handle, e.g. "@maja.photog". Not validated against any specific
    // platform's rules here — platform-specific accounts live in DUR-134's
    // persona_accounts table.
    handle: text("handle"),
    status: text("status").notNull().default("draft"),
    // LEGACY (pre-0175): the per-persona daily picture limit. Moved to
    // agents.limits.dailyImageGenerations by the 0175 backfill and no longer
    // read or written by the server; kept only so nothing has to be dropped.
    dailyGenerationCap: integer("daily_generation_cap"),
    // DUR-134: the per-persona half of the publishing kill switch (item 6).
    // Stops publishing across every one of this persona's persona_accounts
    // on the next publish attempt. See persona_publishing_company_settings
    // for the company-wide half.
    publishingPaused: boolean("publishing_paused").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("personas_company_idx").on(table.companyId),
  }),
);
