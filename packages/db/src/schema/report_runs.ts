import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, check, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { reportTemplates } from "./report_templates.js";
import { reportScriptRuns } from "./report_script_runs.js";
import { documents } from "./documents.js";

export const REPORT_RUN_STATUS_VALUES = [
  "fetching_data",
  "calculating",
  "drafting_commentary",
  "needs_revision",
  "ready",
  "failed",
] as const;
export type ReportRunStatus = (typeof REPORT_RUN_STATUS_VALUES)[number];

/**
 * DUR-4072 PR2: one run of a report template -- an ordinary task, not a new
 * execution engine. Its stages, in order:
 *   fetch data -> run the template's pinned, approved script (PR1's runner,
 *   via `scriptRunId`) -> `numbers` (the script's JSON output, never
 *   touched again) -> agent commentary (`commentaryText`) -> a report
 *   document (`documentId`, PR1's existing documents/document_revisions
 *   tables, so the report gets ordinary revision history for free).
 *
 * `commentaryText` never calculates: every number in it must already be in
 * `numbers`, checked by applyReportNumberCheck (business-data-number-check.ts's
 * pattern, reused) before a run can move past `drafting_commentary`. A
 * commentary draft that fails the check moves back to `needs_revision`
 * rather than silently publishing an unproven figure.
 */
export const reportRuns = pgTable(
  "report_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").notNull().references(() => reportTemplates.id, { onDelete: "cascade" }),
    status: text("status").$type<ReportRunStatus>().notNull().default("fetching_data"),
    /** The data the script's input was built from -- stored for audit, same as PR1's run ledger stores script input/output. */
    fetchedData: jsonb("fetched_data").$type<unknown>(),
    /** DUR-4072 PR3: sha256 of JSON.stringify(fetchedData) -- the exact input snapshot the script was given. */
    fetchedDataSha256: text("fetched_data_sha256"),
    scriptRunId: uuid("script_run_id").references(() => reportScriptRuns.id, { onDelete: "set null" }),
    /** The script's JSON output verbatim -- the only numbers commentary may ever cite. */
    numbers: jsonb("numbers").$type<unknown>(),
    commentaryText: text("commentary_text"),
    /** Every number in commentaryText that was not found in `numbers`, from the last check. Empty once ready. */
    ungroundedNumbers: jsonb("ungrounded_numbers").$type<string[]>().notNull().default([]),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    error: text("error"),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByUserId: text("requested_by_user_id"),
    requestedByRunId: uuid("requested_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    companyCreatedIdx: index("report_runs_company_created_idx").on(table.companyId, table.createdAt),
    templateIdx: index("report_runs_template_idx").on(table.templateId),
    statusCheck: check("report_runs_status_check", sql`${table.status} IN ('fetching_data', 'calculating', 'drafting_commentary', 'needs_revision', 'ready', 'failed')`),
  }),
);
