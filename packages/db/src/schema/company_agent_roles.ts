import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// DUR-114: a "job" belonging to a company. Carries exactly three defaults
// (instructions starting point, MCP tool servers, permission grants) that
// are applied once to an agent at assignment time -- see agents.role_id and
// the role_applied_* snapshot columns in agents.ts for how the "apply once,
// no reconciliation" model is represented on the agent side.
export const companyAgentRoles = pgTable(
  "company_agent_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    // Server-derived slug from `name` at creation time. Never entered or
    // displayed in the UI -- purely an internal stable identifier.
    key: text("key").notNull(),
    description: text("description"),
    defaultInstructions: text("default_instructions"),
    // Array shaped like packages/shared/src/validators/agent.ts
    // `mcpServerConfigSchema` -- reuses the existing adapterConfig.mcpServers
    // shape rather than inventing a parallel connector store.
    defaultMcpServers: jsonb("default_mcp_servers").$type<Array<Record<string, unknown>>>().notNull().default([]),
    // Array of { permissionKey, scope } mirroring
    // company-member-roles.ts `grantsForHumanRole`'s return shape.
    defaultPermissionGrants: jsonb("default_permission_grants")
      .$type<Array<{ permissionKey: string; scope: Record<string, unknown> | null }>>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyIdx: uniqueIndex("company_agent_roles_company_key_idx").on(table.companyId, table.key),
  }),
);
