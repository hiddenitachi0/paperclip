import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { approvals } from "./approvals.js";
import { budgetPolicies } from "./budget_policies.js";
import { companies } from "./companies.js";

export const budgetIncidents = pgTable(
  "budget_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    policyId: uuid("policy_id").notNull().references(() => budgetPolicies.id),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    metric: text("metric").notNull(),
    windowKind: text("window_kind").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    thresholdType: text("threshold_type").notNull(),
    amountLimit: integer("amount_limit").notNull(),
    amountObserved: integer("amount_observed").notNull(),
    status: text("status").notNull().default("open"),
    approvalId: uuid("approval_id").references(() => approvals.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("budget_incidents_company_status_idx").on(table.companyId, table.status),
    companyScopeIdx: index("budget_incidents_company_scope_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
      table.status,
    ),
    // At most one OPEN incident per policy, window and threshold: one breach
    // still going on gets one card. Resolved and dismissed incidents are
    // history and may repeat, so a second stop in the same month after the
    // operator approved the first can file a new one (migration 0167).
    // createIncidentIfNeeded in server/src/services/budgets.ts relies on this
    // index as the arbiter when two cost events race to file the same one.
    policyWindowOpenIdx: uniqueIndex("budget_incidents_policy_window_threshold_open_idx").on(
      table.policyId,
      table.windowStart,
      table.thresholdType,
    ).where(sql`${table.status} = 'open'`),
  }),
);
