import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { personas } from "./personas.js";
import { personaAccounts } from "./persona_accounts.js";
import { assets } from "./assets.js";
import { approvals } from "./approvals.js";

// DUR-134: the publish queue AND the permanent history of what went out --
// one row per intended post, from the moment the persona enqueues it through
// its terminal state (published/failed/rejected/cancelled). `status` is the
// one-shot-publish guard: a row only ever transitions queued|approved ->
// publishing via a conditional `UPDATE ... WHERE status IN (...) RETURNING`
// (see persona-publisher.ts), so two concurrent publish attempts for the
// same row can never both win the claim.
export const personaPosts = pgTable(
  "persona_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    personaId: uuid("persona_id").notNull().references(() => personas.id, { onDelete: "cascade" }),
    personaAccountId: uuid("persona_account_id").notNull().references(() => personaAccounts.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    caption: text("caption").notNull(),
    // The exact disclosure text appended to the caption at publish time, or
    // null if the account's aiDisclosureEnabled was false. Recorded here
    // (not just derivable from the account's current setting) because the
    // account's setting can change after this post already went out.
    disclosureText: text("disclosure_text"),
    mediaAssetId: uuid("media_asset_id").references(() => assets.id),
    // Set once a persona_publish approval is filed for this row (autonomy
    // gate or warm-up override). Null for posts that never needed one.
    approvalId: uuid("approval_id").references(() => approvals.id),
    // The platform's own id for the created post, set on success only.
    externalPostId: text("external_post_id"),
    publishAttemptedAt: timestamp("publish_attempted_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("persona_posts_company_idx").on(table.companyId),
    accountStatusIdx: index("persona_posts_account_status_idx").on(table.personaAccountId, table.status),
  }),
);
