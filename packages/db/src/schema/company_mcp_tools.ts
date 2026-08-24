import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// DUR-143: company_mcp_tools -- the "tool library". A named, company-scoped
// MCP server definition an operator adds once in Settings (structured fields,
// never raw JSON) and then assigns to any agent with a checkbox. `connection`
// stores transport/command/args/url plus a `credentials` array of
// {field,key,secretId,version} bindings -- every credential is always a
// secret_ref (enforced by packages/shared/src/validators/company-mcp-tool.ts),
// never a plaintext value.
export const companyMcpTools = pgTable(
  "company_mcp_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Server-derived slug, unique within a company. Doubles as the MCP server
    // `name` merged into an assigned agent's adapterConfig.mcpServers[*].name.
    key: text("key").notNull(),
    // One-line human description shown at assignment time ("makes images").
    description: text("description").notNull(),
    connection: jsonb("connection").$type<Record<string, unknown>>().notNull(),
    // Set when this tool was installed from the built-in catalog (e.g. "fal_ai").
    catalogKey: text("catalog_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: index("company_mcp_tools_company_id_idx").on(table.companyId),
    companyKeyIdx: index("company_mcp_tools_company_key_idx").on(table.companyId, table.key),
  }),
);
