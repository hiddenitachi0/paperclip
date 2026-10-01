import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";

/**
 * Watchers (migration 0181): cheap scheduled checks of a market price that
 * alert the operator on Telegram only when a rule fires.
 *
 * One row per watcher. The scheduler tick (server/src/services/watchers.ts)
 * picks rows whose next_check_at has passed, claims each one by setting
 * check_lease_until (so one watcher is never checked twice at once), fetches
 * the price in code, evaluates the rule in code, and writes the outcome back
 * here. No AI is involved in a check.
 *
 * The key a source needs (Finnhub for US stocks) is never stored here:
 * key_secret_id names a company secret, bound to this row through
 * company_secret_bindings (target_type 'watcher', config_path 'source_key').
 *
 * condition_met is the level rule's memory: true once an alert went out for
 * the current crossing, false again once the price is back on the other side.
 * checks_today / alerts_today are counted per UTC day (counters_day).
 */
export const watchers = pgTable(
  "watchers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    source: text("source").notNull(),
    symbol: text("symbol").notNull(),
    rule: jsonb("rule").$type<Record<string, unknown>>().notNull(),
    checkEveryMinutes: integer("check_every_minutes").notNull().default(15),
    cooldownMinutes: integer("cooldown_minutes").notNull().default(360),
    enabled: boolean("enabled").notNull().default(true),
    withPicture: boolean("with_picture").notNull().default(false),
    keySecretId: uuid("key_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    checkLeaseUntil: timestamp("check_lease_until", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastPrice: doublePrecision("last_price"),
    lastPriceAt: timestamp("last_price_at", { withTimezone: true }),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastCheckOk: boolean("last_check_ok"),
    lastCheckMessage: text("last_check_message"),
    lastAlertAt: timestamp("last_alert_at", { withTimezone: true }),
    lastAlertPrice: doublePrecision("last_alert_price"),
    conditionMet: boolean("condition_met").notNull().default(false),
    countersDay: text("counters_day"),
    checksToday: integer("checks_today").notNull().default(0),
    alertsToday: integer("alerts_today").notNull().default(0),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("watchers_company_idx").on(table.companyId, table.createdAt),
    dueIdx: index("watchers_due_idx").on(table.enabled, table.nextCheckAt),
    sourceCheck: check("watchers_source_check", sql`${table.source} IN ('crypto', 'us_stock', 'oslo_stock', 'web_page')`),
    checkEveryCheck: check("watchers_check_every_minutes_check", sql`${table.checkEveryMinutes} >= 5`),
    cooldownCheck: check("watchers_cooldown_minutes_check", sql`${table.cooldownMinutes} >= 0`),
  }),
);

/**
 * The small price history a watcher keeps for windows its source cannot give
 * directly ("up 5% within 6 hours"). One row per successful check; rows
 * older than the longest window (plus a day) are deleted as new ones arrive.
 */
export const watcherPricePoints = pgTable(
  "watcher_price_points",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    watcherId: uuid("watcher_id").notNull().references(() => watchers.id, { onDelete: "cascade" }),
    price: doublePrecision("price").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    watcherObservedIdx: index("watcher_price_points_watcher_observed_idx").on(table.watcherId, table.observedAt),
  }),
);

/**
 * One alert: written as 'composing' the moment a rule fires, filled in by the
 * quick agent (text, optional picture) and set 'ready', then picked up by the
 * Telegram bridge from the outbox and set 'delivered' (or 'failed'). A ready
 * alert nobody picked up within a day becomes 'expired' so an old price move
 * is never announced late. `facts` is what the code measured; the agent only
 * words it.
 */
export const watcherAlerts = pgTable(
  "watcher_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    watcherId: uuid("watcher_id").notNull().references(() => watchers.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("composing"),
    isTest: boolean("is_test").notNull().default(false),
    facts: jsonb("facts").$type<Record<string, unknown>>().notNull(),
    text: text("text"),
    imageFileId: uuid("image_file_id"),
    note: text("note"),
    composeAttempts: integer("compose_attempts").notNull().default(0),
    composeLeaseUntil: timestamp("compose_lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("watcher_alerts_company_status_idx").on(table.companyId, table.status, table.createdAt),
    watcherCreatedIdx: index("watcher_alerts_watcher_created_idx").on(table.watcherId, table.createdAt),
    statusCheck: check(
      "watcher_alerts_status_check",
      sql`${table.status} IN ('composing', 'ready', 'delivered', 'failed', 'expired')`,
    ),
  }),
);

/**
 * DUR-4168: the last seen state of a web-page watcher's rule, so the next
 * check has something to compare against. One row per watcher (not per
 * check, unlike watcher_price_points: a web page has no numeric history to
 * window over, only "what did we see last time").
 *
 * Which columns are set depends on the watcher's rule kind: `price` sets
 * last_price, `stock` sets last_in_stock, `new_products` sets
 * last_item_keys, `text_change` sets last_content_hash (+ last_snippet for
 * the alert's short diff). The others stay null for a given kind.
 */
export const watcherWebPageSnapshots = pgTable(
  "watcher_web_page_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    watcherId: uuid("watcher_id")
      .notNull()
      .references(() => watchers.id, { onDelete: "cascade" })
      .unique(),
    lastPrice: doublePrecision("last_price"),
    lastInStock: boolean("last_in_stock"),
    lastItemKeys: jsonb("last_item_keys").$type<string[]>(),
    lastContentHash: text("last_content_hash"),
    lastSnippet: text("last_snippet"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("watcher_web_page_snapshots_company_idx").on(table.companyId),
  }),
);
