import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * A time-boxed, money-capped model/effort boost granted to an existing agent for
 * one task, filed by the agent and approved by the operator (DUR-31). Scoped to
 * `issueId` + `agentId`: it never creates or persists a new agent, and it never
 * touches `agents.adapterConfig` -- see mergeModelProfileAdapterConfig in
 * server/src/services/heartbeat.ts for how it's applied at dispatch.
 */
export const escalationGrants = pgTable(
  "escalation_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id),
    grantedModel: text("granted_model"),
    grantedEffort: text("granted_effort"),
    reason: text("reason").notNull(),
    maxSpendCents: integer("max_spend_cents").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("active"),
    expiredReason: text("expired_reason"),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueStatusIdx: index("escalation_grants_company_issue_status_idx").on(
      table.companyId,
      table.issueId,
      table.status,
    ),
    agentStatusIdx: index("escalation_grants_agent_status_idx").on(table.agentId, table.status),
    approvalIdx: index("escalation_grants_approval_idx").on(table.approvalId),
  }),
);
