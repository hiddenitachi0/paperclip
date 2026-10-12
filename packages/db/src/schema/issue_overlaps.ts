import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * DUR-4468 (DUR-4464): one row per detected overlap between two open issues'
 * workspaces -- the same file changed, the same migration number claimed, both
 * touching the migrations journal -- or, for `stale_behind`, one issue whose
 * branch is behind a commit on the base branch that touched a file it also
 * touches (issue_a_id = issue_b_id in that case).
 *
 * (issue_a_id, issue_b_id) is canonical (issue_a_id < issue_b_id) so a pair has
 * exactly one row per kind + detail_key. `detail_key` is the file path or
 * migration number; the unique index lets each detection run upsert instead of
 * duplicating. `warned_at` is set once the one warning comment has been posted;
 * a row that resolves and later re-opens gets warned_at cleared (a new fact).
 *
 * Rollback: DROP TABLE "issue_overlaps". Pure derived data -- the next
 * detection run rebuilds every open row; no other table references it.
 */
export const issueOverlaps = pgTable(
  "issue_overlaps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueAId: uuid("issue_a_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    issueBId: uuid("issue_b_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    detailKey: text("detail_key").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("open"),
    firstDetectedAt: timestamp("first_detected_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    warnedAt: timestamp("warned_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pairKindDetailUq: uniqueIndex("issue_overlaps_pair_kind_detail_uq").on(
      table.companyId,
      table.issueAId,
      table.issueBId,
      table.kind,
      table.detailKey,
    ),
    companyStatusIdx: index("issue_overlaps_company_status_idx").on(table.companyId, table.status),
    issueAIdx: index("issue_overlaps_issue_a_idx").on(table.issueAId),
    issueBIdx: index("issue_overlaps_issue_b_idx").on(table.issueBId),
  }),
);
