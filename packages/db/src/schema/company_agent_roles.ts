import { pgTable, uuid, text, jsonb, boolean, timestamp, index, unique } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// DUR-114: company_agent_roles ("jobs") — a named role belonging to a company
// that carries default instructions, default MCP servers, and default permission
// grants. Assigning one to an agent applies those defaults once at assignment time.
// DUR-149 added is_builtin/skill_keys/connector_keys (0142) — is_builtin is
// provenance-only, a seeded role stays just as editable/deletable as any other.
export const companyAgentRoles = pgTable(
  "company_agent_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Human-readable name ("Tech developer", "Customer support rep")
    name: text("name").notNull(),
    // Server-derived slug, unique within a company. Never entered or displayed.
    key: text("key").notNull(),
    description: text("description"),
    // Free-text starting instructions applied to an agent at assignment time
    defaultInstructions: text("default_instructions"),
    // Array of mcpServerConfig objects (same shape as adapterConfig.mcpServers)
    defaultMcpServers: jsonb("default_mcp_servers")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    // Array of {permissionKey, scope} grants (same shape as grantsForHumanRole).
    // This is the ticket's "permission_grants" concept — kept under its
    // original DUR-114 column name rather than renamed, to avoid churning
    // every already-shipped, already-tested read/write site for a cosmetic
    // difference; flagged for Fork Lead/Security Reviewer in the PR.
    defaultGrants: jsonb("default_grants")
      .$type<Array<{ permissionKey: string; scope: Record<string, unknown> | null }>>()
      .notNull()
      .default([]),
    // Opaque keys into the company skill catalog / MCP tool library. Not
    // resolved into live agent state by this change — see resolveAgentRoleProvisioning.
    skillKeys: text("skill_keys").array().notNull().default([]),
    connectorKeys: text("connector_keys").array().notNull().default([]),
    // Provenance only — never gates edit/delete.
    isBuiltin: boolean("is_builtin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("company_agent_roles_company_id_idx").on(t.companyId),
    index("company_agent_roles_company_key_idx").on(t.companyId, t.key),
    // Matches the UNIQUE(company_id, key) table constraint that 0136 already
    // created at the DB level — the Drizzle model just never declared it.
    unique("company_agent_roles_company_id_key_unique").on(t.companyId, t.key),
  ]
);
