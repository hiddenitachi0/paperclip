import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, jsonb, check, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { reportScripts } from "./report_scripts.js";
import { approvals } from "./approvals.js";

export const REPORT_SCRIPT_VERSION_STATUS_VALUES = ["draft", "awaiting_approval", "approved", "retired"] as const;
export type ReportScriptVersionStatus = (typeof REPORT_SCRIPT_VERSION_STATUS_VALUES)[number];

/**
 * DUR-4072 PR1: one immutable version of a calculation script -- its source
 * files and the JSON schemas the runner validates input/output against.
 * Never edited after creation; a change is always a new version_no.
 *
 * v1 is Python STANDARD LIBRARY ONLY: there is no lockfile column and no
 * package install step; a version that ships pyproject.toml, uv.lock,
 * requirements*.txt or similar is refused when it is created.
 *
 * `sha256` is a digest over the entrypoint and every file (sorted by path).
 * Before EVERY run the server recomputes it from this row's `files` and
 * refuses to execute if it does not match -- the source of truth is the
 * database row, never a directory on disk.
 *
 * `status`: 'draft' (agent or person drafted it; it has NEVER executed --
 * not even against a fixture) -> 'awaiting_approval' (an approval card
 * showing the full source was filed) -> 'approved' (a company owner/admin,
 * a person, approved this exact sha256; the approve action ran every fixture
 * first and refused if any failed) -> 'retired'. Nothing executes a version
 * whose status is not 'approved', except the owner's own approve action,
 * which runs the fixtures as part of the approval.
 */
export const reportScriptVersions = pgTable(
  "report_script_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scriptId: uuid("script_id").notNull().references(() => reportScripts.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    /** Relative file path -> source text. Always includes the entrypoint. */
    files: jsonb("files").$type<Record<string, string>>().notNull().default({}),
    entrypoint: text("entrypoint").notNull().default("main.py"),
    sha256: text("sha256").notNull(),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull().default({}),
    outputSchema: jsonb("output_schema").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<ReportScriptVersionStatus>().notNull().default("draft"),
    changeSummary: text("change_summary"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    /** The approval card (approvals row) that shows this version's full source. */
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scriptVersionUq: uniqueIndex("report_script_versions_script_version_uq").on(table.scriptId, table.versionNo),
    companyIdx: index("report_script_versions_company_idx").on(table.companyId),
    scriptIdx: index("report_script_versions_script_idx").on(table.scriptId),
    statusCheck: check(
      "report_script_versions_status_check",
      sql`${table.status} IN ('draft', 'awaiting_approval', 'approved', 'retired')`,
    ),
    // A version can only be 'approved' together with the person who approved
    // it; only the owner/admin approve action in the service sets both.
    approvalPairCheck: check(
      "report_script_versions_approval_pair_check",
      sql`(${table.status} <> 'approved') OR (${table.approvedByUserId} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)`,
    ),
  }),
);
