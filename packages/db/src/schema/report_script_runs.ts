import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, jsonb, check, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { reportScriptVersions } from "./report_script_versions.js";
import { reportFixtures } from "./report_fixtures.js";

export const REPORT_SCRIPT_RUN_TRIGGER_VALUES = ["fixture_test", "manual", "report_run"] as const;
export type ReportScriptRunTrigger = (typeof REPORT_SCRIPT_RUN_TRIGGER_VALUES)[number];

export const REPORT_SCRIPT_RUN_STATUS_VALUES = [
  "running",
  "succeeded",
  "failed",
  "timeout",
  "fingerprint_mismatch",
] as const;
export type ReportScriptRunStatus = (typeof REPORT_SCRIPT_RUN_STATUS_VALUES)[number];

/**
 * DUR-4072 PR1: the execution ledger the ticket asks for -- "stores inputs,
 * outputs and the script fingerprint" for every sandboxed run of a script
 * version, whether it was a fixture test or (once PR2 lands) a real report
 * run. Rows are append-only; a run is never edited after it finishes.
 *
 * `scriptSha256` is copied from the script version at run time (not just
 * joined live) so a run's record of what ran survives even if the version
 * row were ever retired/changed later. `runtimeFingerprint` is the
 * trusted-code-style digest of the built `uv` venv directory the run
 * actually executed in, re-checked immediately before every run.
 */
export const reportScriptRuns = pgTable(
  "report_script_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scriptVersionId: uuid("script_version_id").notNull().references(() => reportScriptVersions.id, { onDelete: "cascade" }),
    fixtureId: uuid("fixture_id").references(() => reportFixtures.id, { onDelete: "set null" }),
    trigger: text("trigger").$type<ReportScriptRunTrigger>().notNull(),
    input: jsonb("input").$type<unknown>().notNull(),
    inputSha256: text("input_sha256").notNull(),
    output: jsonb("output").$type<unknown>(),
    outputSha256: text("output_sha256"),
    scriptSha256: text("script_sha256").notNull(),
    runtimeFingerprint: text("runtime_fingerprint"),
    status: text("status").$type<ReportScriptRunStatus>().notNull().default("running"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    /** Set only for trigger='fixture_test': {ok, tolerance, diffs: [...]}. */
    fixtureResult: jsonb("fixture_result").$type<Record<string, unknown> | null>(),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByUserId: text("requested_by_user_id"),
    requestedByRunId: uuid("requested_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("report_script_runs_company_created_idx").on(table.companyId, table.createdAt),
    scriptVersionIdx: index("report_script_runs_script_version_idx").on(table.scriptVersionId),
    triggerCheck: check(
      "report_script_runs_trigger_check",
      sql`${table.trigger} IN ('fixture_test', 'manual', 'report_run')`,
    ),
    statusCheck: check(
      "report_script_runs_status_check",
      sql`${table.status} IN ('running', 'succeeded', 'failed', 'timeout', 'fingerprint_mismatch')`,
    ),
  }),
);
