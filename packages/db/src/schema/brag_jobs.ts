import { index, integer, jsonb, boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";

// DUR-4519: "Brag" launch-video jobs (parent DUR-4518). One row per video
// request on a project; scenes hold the per-scene still + approval state.
export const bragJobs = pgTable(
  "brag_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    // draft | planning | awaiting_approval | rendering | completed | failed | cancelled
    status: text("status").notNull().default("draft"),
    // Source: a repo URL / website URL (code is read from the project workspace when null)
    sourceRepoUrl: text("source_repo_url"),
    sourceUrl: text("source_url"),
    tone: text("tone"),
    // landscape | vertical | square
    format: text("format").notNull().default("landscape"),
    lengthSeconds: integer("length_seconds").notNull().default(20),
    music: boolean("music").notNull().default(false),
    note: text("note"),
    estimatedCostCents: integer("estimated_cost_cents").notNull().default(0),
    actualCostCents: integer("actual_cost_cents").notNull().default(0),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("brag_jobs_company_project_idx").on(t.companyId, t.projectId),
    index("brag_jobs_company_status_idx").on(t.companyId, t.status),
  ],
);

export const bragScenes = pgTable(
  "brag_scenes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull().references(() => bragJobs.id, { onDelete: "cascade" }),
    sceneOrder: integer("scene_order").notNull(),
    description: text("description"),
    // Reference to the still image (asset id / storage key)
    stillRef: text("still_ref"),
    // pending | approved | rejected
    approvalStatus: text("approval_status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("brag_scenes_job_order_idx").on(t.jobId, t.sceneOrder),
    index("brag_scenes_company_idx").on(t.companyId),
  ],
);
