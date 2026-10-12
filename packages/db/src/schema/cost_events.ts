import { pgTable, uuid, text, timestamp, integer, bigint, doublePrecision, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // DUR-4329: nullable for a board-user-triggered cost with no agent
    // involved at all (Media Studio's Create tab direct generation) --
    // every other write path still always sets this. createdByUserId below
    // is this row's counterpart to assets.createdByUserId (same bare text
    // column, no FK: board user identity isn't a packages/db table).
    agentId: uuid("agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    issueId: uuid("issue_id").references(() => issues.id),
    projectId: uuid("project_id").references(() => projects.id),
    goalId: uuid("goal_id").references(() => goals.id),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    billingCode: text("billing_code"),
    provider: text("provider").notNull(),
    biller: text("biller").notNull().default("unknown"),
    billingType: text("billing_type").notNull().default("unknown"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    // DUR-4470: prompt-cache WRITES (billed 1.25x/2x input), distinct from
    // cachedInputTokens which counts cache reads only.
    cacheWriteInputTokens: integer("cache_write_input_tokens").notNull().default(0),
    cacheWrite1hInputTokens: integer("cache_write_1h_input_tokens").notNull().default(0),
    cacheWriteCostCents: doublePrecision("cache_write_cost_cents").notNull().default(0),
    costCents: integer("cost_cents").notNull(),
    // DUR-4453: exact sub-cent cost (1 USD = 1,000,000). Nullable: older rows
    // only carry cost_cents; readers fall back to cost_cents * 10000.
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
    // "provider" (exact, reported by the provider), "estimate", "static_table".
    costSource: text("cost_source"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOccurredIdx: index("cost_events_company_occurred_idx").on(table.companyId, table.occurredAt),
    companyAgentOccurredIdx: index("cost_events_company_agent_occurred_idx").on(
      table.companyId,
      table.agentId,
      table.occurredAt,
    ),
    companyProviderOccurredIdx: index("cost_events_company_provider_occurred_idx").on(
      table.companyId,
      table.provider,
      table.occurredAt,
    ),
    companyBillerOccurredIdx: index("cost_events_company_biller_occurred_idx").on(
      table.companyId,
      table.biller,
      table.occurredAt,
    ),
    companyHeartbeatRunIdx: index("cost_events_company_heartbeat_run_idx").on(
      table.companyId,
      table.heartbeatRunId,
    ),
  }),
);
