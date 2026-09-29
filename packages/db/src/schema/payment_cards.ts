import { pgTable, uuid, text, integer, boolean, timestamp, date, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

/**
 * DUR-4040 (Maja browser step 5): metadata for a payment card an agent may
 * spend from via the browser worker. Metadata ONLY -- the PAN/CVC never live
 * here, only in the encrypted `payment_card_single_use` secret `secretId`
 * points at (packages/shared/src/secret-kinds.ts, added by DUR-4019). Ships
 * with the browser feature fully switched off (agents default to
 * browserAccess "off", companies default to paymentsEnabled false), so this
 * table exists with zero rows and zero visible behavior change until an
 * operator turns both on.
 *
 * Status lifecycle (see PAYMENT_CARD_STATUSES in packages/shared):
 *   available -> reserved (bound to a live purchase clearance -- clearance
 *     plumbing itself is step 6, not built here) -> used | used_unverified.
 *   available | reserved -> expired (the daily expiry tick, once expiresOn
 *     has passed) | disabled (a board user, any time).
 */
export const paymentCards = pgTable(
  "payment_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // The only pointer to the card's actual PAN/CVC. paymentCardService's
    // resolveForFill is the only code path that ever resolves this secret's
    // value.
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    brand: text("brand"),
    last4: text("last4").notNull(),
    currency: text("currency").notNull(),
    loadedAmountCents: integer("loaded_amount_cents").notNull().default(0),
    remainingAmountCents: integer("remaining_amount_cents").notNull().default(0),
    singleUse: boolean("single_use").notNull().default(true),
    status: text("status").notNull().default("available"),
    // Nullable: a card an operator has not given a tracked expiry for is
    // simply never swept by the daily expiry tick, not an error.
    expiresOn: date("expires_on"),
    // Agent ids allowed to have this card resolved for them. Empty array =
    // no agent may use it yet (the safe default), not "everyone may".
    allowedAgentIds: jsonb("allowed_agent_ids").$type<string[]>().notNull().default([]),
    // Loosely typed on purpose: the clearance/purchase tables are step 6, not
    // built here, so these are plain ids with no FK rather than a migration
    // this table would need to grow later.
    reservedForClearanceId: text("reserved_for_clearance_id"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByPurchaseId: text("used_by_purchase_id"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("payment_cards_company_idx").on(table.companyId),
    companyStatusIdx: index("payment_cards_company_status_idx").on(table.companyId, table.status),
    secretIdx: index("payment_cards_secret_idx").on(table.secretId),
    expiresOnIdx: index("payment_cards_expires_on_idx").on(table.expiresOn),
  }),
);
