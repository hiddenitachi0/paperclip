import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issueAttachments } from "./issue_attachments.js";

/**
 * Payment notices (migration 0186, DUR-4037 -- Maja browser step 4): the
 * outbox for the browser/booking flow's plain-language notifications that
 * are not themselves an approval card -- a receipt once a booking went
 * through, or a hand-over ("Filip, this needs a 2FA/BankID/SMS code I can't
 * see"). Modelled on `watcher_alerts` (see packages/db/src/schema/watchers.ts)
 * with one difference: every row here is written `ready` by the server
 * (`server/src/services/browser-service.ts`) at the moment the fact is known,
 * never `composing` -- there is no quick agent writing prose after the fact,
 * so agent-supplied text is always quoted into `text` rather than trusted as
 * a fact to compose from.
 *
 * `image_file_id` is a same-company `issue_attachments.id` with `issue_id`
 * null (the general "Files" mechanism `chat image`/`GET
 * /api/attachments/:id/content` already reads, exactly like a watcher
 * alert's picture) -- not a fresh storage mechanism.
 */
export const paymentNotices = pgTable(
  "payment_notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("ready"),
    text: text("text").notNull(),
    imageFileId: uuid("image_file_id").references(() => issueAttachments.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("payment_notices_company_status_idx").on(table.companyId, table.status, table.createdAt),
    agentCreatedIdx: index("payment_notices_agent_created_idx").on(table.agentId, table.createdAt),
    kindCheck: check(
      "payment_notices_kind_check",
      sql`${table.kind} IN ('booking_receipt', 'purchase_receipt', 'hand_over')`,
    ),
    statusCheck: check(
      "payment_notices_status_check",
      sql`${table.status} IN ('ready', 'delivered', 'failed', 'expired')`,
    ),
  }),
);
