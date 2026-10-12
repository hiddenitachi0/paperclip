import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * DUR-4566: the security-review state of a `kind: "merge_pr"` approval, tracked
 * per head commit so a later push makes a prior `passed`/`failed` row stale
 * ("out of date") without deleting the review history. One row per request; the
 * card's current state is the newest row for that approval.
 *
 * `headCommit` is `payload.commit` on the approval at the moment the review was
 * requested or decided (the same field the rest of the merge_pr pipeline treats
 * as that card's head -- see `stripUntrustedMergeCommitSha` in
 * server/src/routes/approvals.ts) -- not a live GitHub lookup.
 *
 * `reviewerAgentId`/`reviewerUserId` is whoever actually recorded the verdict,
 * which server-side authorization restricts to the company's configured
 * security reviewer agent or a board user (never the approval's own requester).
 *
 * The partial unique index enforces single-flight: pressing "Request security
 * review" twice while one is already open for this exact head commit cannot
 * create a second row (and so not a second review task either).
 *
 * Rollback: DROP TABLE "merge_security_reviews". Derived/advisory data only --
 * no other table's invariants depend on it existing.
 */
export const mergeSecurityReviews = pgTable(
  "merge_security_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => approvals.id, { onDelete: "cascade" }),
    reviewIssueId: uuid("review_issue_id").references(() => issues.id, { onDelete: "set null" }),
    headCommit: text("head_commit").notNull(),
    status: text("status").notNull().default("requested"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id),
    reviewerUserId: text("reviewer_user_id"),
    verdictNote: text("verdict_note"),
    verdictCommentUrl: text("verdict_comment_url"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdByRunId: text("created_by_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    approvalCreatedIdx: index("merge_security_reviews_approval_created_idx").on(
      table.approvalId,
      table.createdAt,
    ),
    companyIdx: index("merge_security_reviews_company_idx").on(table.companyId),
    singleFlightOpenIdx: uniqueIndex("merge_security_reviews_open_request_uq")
      .on(table.approvalId, table.headCommit)
      .where(sql`${table.status} = 'requested'`),
  }),
);
