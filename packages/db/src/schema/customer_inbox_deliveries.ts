import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { routineTriggers, routineRuns } from "./routines.js";
import { issues } from "./issues.js";

/**
 * A ledger row is written for every delivery to the customer-inbox door
 * (`POST /api/customer-inbox/:publicId`), before any signature or shape
 * validation, so nothing that knocks on the door goes unrecorded (DUR-68).
 *
 * `companyId` / `routineTriggerId` are nullable because an `unknown_target`
 * delivery (publicId does not resolve to any trigger) belongs to no company.
 */

export const customerInboxDeliveries = pgTable(
  "customer_inbox_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    routineTriggerId: uuid("routine_trigger_id").references(() => routineTriggers.id, { onDelete: "cascade" }),
    externalMessageId: text("external_message_id"),
    channel: text("channel"),
    fromAddress: text("from_address"),
    fromName: text("from_name"),
    subject: text("subject"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    outcome: text("outcome").notNull(),
    outcomeDetail: text("outcome_detail"),
    linkedRoutineRunId: uuid("linked_routine_run_id").references(() => routineRuns.id, { onDelete: "set null" }),
    linkedIssueId: uuid("linked_issue_id").references(() => issues.id, { onDelete: "set null" }),
    payloadDigest: text("payload_digest"),
    rawPayloadExcerpt: text("raw_payload_excerpt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("customer_inbox_deliveries_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    triggerCreatedIdx: index("customer_inbox_deliveries_trigger_created_idx").on(
      table.routineTriggerId,
      table.createdAt,
    ),
    linkedRunIdx: index("customer_inbox_deliveries_linked_run_idx").on(table.linkedRoutineRunId),
    linkedIssueIdx: index("customer_inbox_deliveries_linked_issue_idx").on(table.linkedIssueId),
    rawExcerptSweepIdx: index("customer_inbox_deliveries_raw_excerpt_sweep_idx")
      .on(table.receivedAt)
      .where(sql`${table.rawPayloadExcerpt} is not null`),
    // A `duplicate` row must always be insertable (it exists to record the
    // exact replay event), so the unique constraint only applies to
    // `accepted` rows with a real external message id.
    acceptedMessageUq: uniqueIndex("customer_inbox_deliveries_accepted_message_uq")
      .on(table.companyId, table.routineTriggerId, table.externalMessageId)
      .where(sql`${table.outcome} = 'accepted' and ${table.externalMessageId} is not null`),
  }),
);
