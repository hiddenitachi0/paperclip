import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// DUR-143: the "tool library" — an MCP server a human adds ONCE in Settings
// (name, one-line human description, connection config), which then shows up
// as a named, checkbox-assignable entry on every agent. This is the no-JSON
// front door for MCP tools; adapterConfig.mcpServers (the raw JSON textarea)
// remains available for anyone who prefers it and is never affected by rows
// in this table.
//
// `connection` mirrors mcpServerConfigSchema minus `name` (transport/command/
// args/env/url/headers) — `key` is the slug used as that server's `name` at
// dispatch time, so it never collides with another entry and never needs to
// be typed by a human. env/headers values may be secret_ref bindings, same
// shape as adapterConfig.mcpServers[*].env — the credential itself always
// lives in company_secret_versions, never in this row.
export const companyMcpTools = pgTable(
  "company_mcp_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    key: text("key").notNull(),
    description: text("description").notNull(),
    connection: jsonb("connection").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("company_mcp_tools_company_id_idx").on(t.companyId),
    index("company_mcp_tools_company_key_idx").on(t.companyId, t.key),
  ]
);
