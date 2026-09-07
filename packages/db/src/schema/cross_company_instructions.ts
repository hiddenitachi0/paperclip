import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { issues } from "./issues.js";

/**
 * The guarded cross-company instruction channel (migration 0163).
 *
 * The ONLY thing that may cross the wall between two companies on one
 * Paperclip instance is a plain-text instruction from an agent in the
 * sending company to the receiving company's designated liaison agent
 * ("Tech Boss"). No data, files, credentials or access ever cross: the
 * liaison carries the instruction out inside its own company, under its
 * own company's rules, and only after that company's board approved the
 * card that this row is linked to.
 *
 * A row belongs to BOTH companies (from and to), which is why it carries
 * two company columns instead of the usual single company_id, and why its
 * row-level-security policy admits either side.
 */
export const crossCompanyInstructions = pgTable(
  "cross_company_instructions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromCompanyId: uuid("from_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    fromAgentId: uuid("from_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    toCompanyId: uuid("to_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    toAgentId: uuid("to_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    instruction: text("instruction").notNull(),
    /** pending_approval | delivered | rejected */
    status: text("status").notNull().default("pending_approval"),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    deliveredIssueId: uuid("delivered_issue_id").references(() => issues.id, { onDelete: "set null" }),
    decidedByUserId: text("decided_by_user_id"),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    toCompanyStatusIdx: index("cross_company_instructions_to_company_status_idx").on(table.toCompanyId, table.status),
    fromCompanyIdx: index("cross_company_instructions_from_company_idx").on(table.fromCompanyId),
    approvalIdx: index("cross_company_instructions_approval_idx").on(table.approvalId),
  }),
);
