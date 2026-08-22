import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";

/**
 * Audit record for a boss-proposed instructions change that an operator
 * approved (DUR-69/DUR-109). Distinct from `agent_config_revisions`, which
 * only snapshots the `agents` table columns (name/role/adapterConfig paths,
 * etc.) and never captures the actual instructions markdown content that
 * lives on disk. This table stores the readable before/after content itself,
 * plus who proposed it and who approved it, so both parties are named on the
 * record the operator ruling requires -- not just whichever single actor
 * `agent_config_revisions.createdBy*` happens to track for that write.
 */
export const agentInstructionsRevisions = pgTable(
  "agent_instructions_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    approvedByUserId: text("approved_by_user_id").notNull(),
    reason: text("reason").notNull(),
    relativePath: text("relative_path").notNull(),
    beforeContent: text("before_content").notNull(),
    afterContent: text("after_content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentCreatedIdx: index("agent_instructions_revisions_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    approvalIdx: index("agent_instructions_revisions_approval_idx").on(table.approvalId),
  }),
);
