// DUR-133 (persona-mcp Ticket B, item 10): a persona is who an agent IS —
// a name, a face and a voice — layered on top of the `agents` row, which
// stays the worker (adapter, budget, MCP tools, etc). One persona per agent
// (unique on agentId): the persona/agent split exists so "delete the
// persona" (item 14: disconnect/delete/pause from the Personas page) never
// has to touch the underlying agent's run history, budget or audit trail.
import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { assets } from "./assets.js";

export const personas = pgTable(
  "personas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // One persona per agent. The agent row is the worker (adapter, budget,
    // MCP tools); this row is her identity layered on top of it.
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    // Free-text handle/short name used in copy ("Maja"), distinct from any
    // platform account handle (those live on persona_accounts, Ticket C).
    handle: text("handle"),
    // Who she is: backstory, age, interests — rendered into PERSONA.md
    // (item 11). Kept separate from `voice` so the two can be edited and
    // rendered independently.
    bio: text("bio"),
    // How she writes: tone, vocabulary, things she'd never say.
    voice: text("voice"),
    avatarAssetId: uuid("avatar_asset_id").references(() => assets.id, { onDelete: "set null" }),
    // "active" | "paused" — pausing (item 14) stops her routine and blocks
    // her generation/publishing queue without deleting her identity.
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdUq: uniqueIndex("personas_agent_id_uq").on(table.agentId),
    companyStatusIdx: index("personas_company_status_idx").on(table.companyId, table.status),
  }),
);
