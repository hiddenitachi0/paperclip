import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, jsonb, check, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { reportScripts } from "./report_scripts.js";

export const REPORT_SCRIPT_VERSION_STATUS_VALUES = ["draft", "tested", "approved", "retired"] as const;
export type ReportScriptVersionStatus = (typeof REPORT_SCRIPT_VERSION_STATUS_VALUES)[number];

/**
 * DUR-4072 PR1: one immutable version of a calculation script -- source
 * files, an optional `uv` lockfile, and the JSON schemas the runner
 * validates input/output against. Never edited after creation; a change is
 * always a new version_no.
 *
 * `sha256` is the script fingerprint the ticket asks for: a digest over
 * every file (sorted by path) plus the lockfile, computed the same way
 * trusted-code.ts fingerprints a code root, so "this exact version ran" is
 * provable from the digest alone. The runner re-derives it from `files` +
 * `lockfile` before every run and refuses to run if it does not match this
 * column (defense against a row edited by anything other than this table's
 * own immutability).
 *
 * `status`: 'draft' (freshly created or edited by the report-builder, never
 * run against real data) -> 'tested' (passed every one of its fixtures) ->
 * 'approved' (a board owner/admin activated it -- agents can create and
 * test versions but can never set this themselves, enforced in the service
 * layer, not just the route) -> 'retired' (superseded, kept for history).
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
    /** `uv.lock` contents, or null for a script with no third-party dependencies. */
    lockfile: text("lockfile"),
    sha256: text("sha256").notNull(),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull().default({}),
    outputSchema: jsonb("output_schema").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<ReportScriptVersionStatus>().notNull().default("draft"),
    changeSummary: text("change_summary"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
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
      sql`${table.status} IN ('draft', 'tested', 'approved', 'retired')`,
    ),
    // An agent-authored version cannot record itself as approved; only the
    // service's board-only approve path may set both together.
    approvalPairCheck: check(
      "report_script_versions_approval_pair_check",
      sql`(${table.status} <> 'approved') OR (${table.approvedByUserId} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)`,
    ),
  }),
);
