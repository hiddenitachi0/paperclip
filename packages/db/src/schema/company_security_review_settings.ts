import { pgTable, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * DUR-4566: which agent is "the company's security reviewer" for the merge-card
 * security-review gate. Lazy-row-on-first-write, same shape as
 * `email_company_settings` -- a company that never sets this has no row, and
 * absence reads as "no reviewer configured yet" (the Request button then
 * explains one has to be chosen first, rather than silently doing nothing).
 */
export const companySecurityReviewSettings = pgTable(
  "company_security_review_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    securityReviewerAgentId: uuid("security_reviewer_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("company_security_review_settings_company_uq").on(table.companyId),
  }),
);
