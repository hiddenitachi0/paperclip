import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { issueAttachments } from "./issue_attachments.js";

// Media Studio code-rendered videos (D14): one row per job sent to the
// locked-down render worker (docker/render-worker). The worker keeps its own
// job state in memory only; this row is Paperclip's record of who asked,
// what it counts against the caps, and where the finished file was saved.
export const codeRenderJobs = pgTable(
  "code_render_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // check | snapshot | render
    kind: text("kind").notNull(),
    // queued | running | saving | done | failed | cancelled
    status: text("status").notNull().default("queued"),
    title: text("title").notNull(),
    // When set, the result is attached to this task instead of saved as a company file.
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    // The worker's id for the job; null until the worker accepted it.
    workerJobId: text("worker_job_id"),
    // The video length asked for (render), whole seconds rounded up; what the daily caps count.
    requestedSeconds: integer("requested_seconds").notNull().default(0),
    // The finished video's real length, in milliseconds.
    videoMs: integer("video_ms"),
    progressPct: integer("progress_pct"),
    // fps, quality, frames, entry, file and asset counts.
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    resultFileId: uuid("result_file_id").references(() => issueAttachments.id, { onDelete: "set null" }),
    resultContentType: text("result_content_type"),
    resultBytes: bigint("result_bytes", { mode: "number" }),
    // Check jobs: whether Hyperframes found no errors, and its report.
    passed: boolean("passed"),
    report: jsonb("report").$type<Record<string, unknown>>(),
    error: text("error"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("code_render_jobs_company_created_idx").on(t.companyId, t.createdAt),
    index("code_render_jobs_company_status_idx").on(t.companyId, t.status),
    index("code_render_jobs_agent_created_idx").on(t.createdByAgentId, t.createdAt),
    index("code_render_jobs_status_idx").on(t.status),
  ],
);
