import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * DUR-4004: "API with a key" -- the third kind of tool on the Tools page.
 *
 * Most services (Fal.ai, Fiken, ...) do not ship an MCP server; they hand
 * you an API key and a plain HTTP API. One row here is one such service: a
 * base address, how the key is sent, and a short list of actions (method +
 * path + inputs) an agent may call. The key itself never sits in this row:
 * `auth.secretId` names a company secret, which is bound to this row in
 * company_secret_bindings (target_type 'api_tool', config_path 'auth') and
 * read back in exactly one place, server-side, at call time
 * (server/src/services/api-tools.ts). Nothing an agent can reach returns it.
 *
 * `auth` is { kind: 'bearer' | 'header' | 'query', name?, prefix?, secretId }
 * -- see apiToolAuthSchema in packages/shared. `actions` is an array of
 * { name, method, path, description, inputs } -- see apiToolActionSchema.
 * Both are validated by the shared schema on every write; the database
 * only holds the shape.
 *
 * `daily_cap` is the number of calls this tool may make per UTC day, across
 * every agent of the company; the rows in company_api_tool_calls are what
 * it is counted from.
 */
export const companyApiTools = pgTable(
  "company_api_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Slug derived from the name; the first half of every tool name an agent
    // sees (`<key>__<action>`). Unique per company.
    key: text("key").notNull(),
    description: text("description").notNull().default(""),
    // https only, no username/password, no query string; checked by the
    // shared validator before it gets here.
    baseUrl: text("base_url").notNull(),
    auth: jsonb("auth").$type<Record<string, unknown>>().notNull().default({}),
    actions: jsonb("actions").$type<Array<Record<string, unknown>>>().notNull().default([]),
    openapiUrl: text("openapi_url"),
    dailyCap: integer("daily_cap").notNull().default(300),
    status: text("status").notNull().default("active"),
    // Outcome of the last Test click: one plain sentence, key-shaped text
    // removed before it is written, same as company_secrets.last_test_*.
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastTestOk: boolean("last_test_ok"),
    lastTestMessage: text("last_test_message"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_api_tools_company_id_idx").on(table.companyId),
    companyKeyUq: uniqueIndex("company_api_tools_company_key_uq").on(table.companyId, table.key),
    statusCheck: check("company_api_tools_status_check", sql`${table.status} IN ('active', 'disabled')`),
    dailyCapCheck: check("company_api_tools_daily_cap_check", sql`${table.dailyCap} > 0`),
  }),
);
