import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issueAttachments } from "./issue_attachments.js";
import { costEvents } from "./cost_events.js";

/**
 * DUR-4329: a small, purpose-built index for "my own recent Create-tab
 * direct generations" (the history endpoint) -- cost_events has no kind or
 * fileId column (it is a billing-aggregation table, not a per-action log),
 * so this table is the minimal record the ticket's "reuse cost_events or
 * add a minimal record" note allows, rather than overloading
 * cost_events.billingCode to smuggle a kind through it. Every row also gets
 * a cost_events row (costEventId) so the same spend rolls into the
 * company's budget the way agent-driven generation already does.
 */
export const mediaStudioDirectCreations = pgTable(
  "media_studio_direct_creations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** Bare text, no FK: board user identity isn't a packages/db table (same convention as assets.createdByUserId). */
    createdByUserId: text("created_by_user_id").notNull(),
    kind: text("kind").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    prompt: text("prompt"),
    costCents: integer("cost_cents").notNull(),
    fileId: uuid("file_id").references(() => issueAttachments.id, { onDelete: "set null" }),
    costEventId: uuid("cost_event_id").references(() => costEvents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserCreatedIdx: index("media_studio_direct_creations_company_user_created_idx").on(
      table.companyId,
      table.createdByUserId,
      table.createdAt,
    ),
  }),
);
