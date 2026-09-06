import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { personas } from "./personas.js";

// DUR-134: one row per platform account a persona publishes to. The 23
// August operator decision makes this a per-persona-per-channel safety
// matrix, not a single instance-wide switch -- every safety-relevant column
// here is deliberately NOT NULL with no application-level fallback for the
// three the operator called out (aiDisclosureEnabled, dailyPostCap): the
// creation validator (packages/shared/src/validators/persona-account.ts)
// requires all three explicitly, and the DB column itself carries no
// `.default()` for aiDisclosureEnabled/dailyPostCap so a bug in the
// validator would fail loud (NOT NULL violation) instead of silently
// defaulting. autonomyMode is the one exception: its DB default is
// "requires_approval" as defense in depth ("a channel with no configured
// autonomy setting defaults to require-approval -- never
// autonomous-by-omission"), even though the validator also requires it.
export const personaAccounts = pgTable(
  "persona_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    personaId: uuid("persona_id").notNull().references(() => personas.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    // Operator-facing label, e.g. "Maja — Fanvue". Not the handle/username.
    accountLabel: text("account_label").notNull(),
    // The platform's own account/creator id (Fanvue creator id). Opaque.
    externalAccountId: text("external_account_id").notNull(),
    connectionStatus: text("connection_status").notNull().default("pending"),
    // No default -- required at creation, per persona per channel.
    aiDisclosureEnabled: boolean("ai_disclosure_enabled").notNull(),
    // Defaults safe (requires_approval) as defense in depth; the API layer
    // still requires the operator make an explicit choice at creation.
    autonomyMode: text("autonomy_mode").notNull().default("requires_approval"),
    // No default -- required at creation, no global fallback number.
    dailyPostCap: integer("daily_post_cap").notNull(),
    // "First handful of posts require approval regardless of autonomyMode."
    // Fixed per-account at creation (copied from a code default -- see
    // persona-accounts.ts service) rather than editable, so warm-up can't be
    // shortened by a config change after the fact.
    warmupPostsRequired: integer("warmup_posts_required").notNull(),
    // Cumulative successful publishes on this account, used only to compare
    // against warmupPostsRequired. Incremented exactly once per successful
    // publish, in the same transaction that marks a persona_posts row
    // "published" (see persona-publisher.ts).
    publishedPostCount: integer("published_post_count").notNull().default(0),
    // Per-persona-account kill switch. Checked at the top of every publish
    // attempt; effective on the very next attempt, no propagation delay.
    publishingPaused: boolean("publishing_paused").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("persona_accounts_company_idx").on(table.companyId),
    personaIdx: index("persona_accounts_persona_idx").on(table.personaId),
    // "Unique on (personaId, platform, externalAccountId)" per the ticket.
    personaPlatformAccountUq: uniqueIndex("persona_accounts_persona_platform_account_uq").on(
      table.personaId,
      table.platform,
      table.externalAccountId,
    ),
  }),
);
