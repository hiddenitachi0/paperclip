import { bigint, index, integer, jsonb, boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * Board chat on signed-in Paperclip servers (20 Oct 2026, migration 0255).
 *
 * Three company-scoped tables:
 *
 *   board_chat_company_settings  the company's on/off switch (off by default:
 *                                no row reads as off) and its daily message cap.
 *   board_chat_runs              one row per message sent in a signed-in
 *                                Board chat. Holds the hash of the short-lived
 *                                credential that run uses to call Paperclip as
 *                                the person, scoped to this one company; it
 *                                stops working when the run ends. Also the
 *                                count behind the daily cap, and the run's cost.
 *   board_chat_actions           every change a run wanted to make. A change is
 *                                never made when asked: it waits here as a card
 *                                in the chat until the person clicks Approve
 *                                (or Cancel), and records what happened.
 *
 * No credential value is ever stored, only sha256 hashes.
 */
export const boardChatCompanySettings = pgTable(
  "board_chat_company_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    dailyMessageCap: integer("daily_message_cap").notNull().default(40),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    enabledByUserId: text("enabled_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("board_chat_company_settings_company_uq").on(table.companyId),
  }),
);

export const boardChatRuns = pgTable(
  "board_chat_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    // running | done | failed | timed_out
    status: text("status").notNull().default("running"),
    // One-time code the run's Paperclip connector swaps for its credential.
    bootstrapCodeHash: text("bootstrap_code_hash"),
    tokenHash: text("token_hash"),
    tokenExchangeCount: integer("token_exchange_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
    costEventId: uuid("cost_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => ({
    companyCreatedIdx: index("board_chat_runs_company_created_idx").on(table.companyId, table.createdAt),
    tokenHashUq: uniqueIndex("board_chat_runs_token_hash_uq").on(table.tokenHash),
    bootstrapHashUq: uniqueIndex("board_chat_runs_bootstrap_code_hash_uq").on(table.bootstrapCodeHash),
  }),
);

export const boardChatActions = pgTable(
  "board_chat_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => boardChatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    userId: text("user_id").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    // The exact JSON body that will be sent on Approve, as text (jsonb would
    // reorder keys; the replay is compared against this).
    bodyJson: text("body_json"),
    summary: text("summary").notNull(),
    details: jsonb("details").$type<Array<{ label: string; value: string }>>().notNull().default([]),
    // pending | confirmed | executing | done | failed | cancelled | expired
    status: text("status").notNull().default("pending"),
    execTokenHash: text("exec_token_hash"),
    execTokenExpiresAt: timestamp("exec_token_expires_at", { withTimezone: true }),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    resultStatus: integer("result_status"),
    resultMessage: text("result_message"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueCreatedIdx: index("board_chat_actions_company_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    execTokenHashUq: uniqueIndex("board_chat_actions_exec_token_hash_uq").on(table.execTokenHash),
  }),
);
