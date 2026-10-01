import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companyAgentRoles } from "./company_agent_roles.js";
import { companySecrets } from "./company_secrets.js";
import { goals } from "./goals.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import type { JobVariable } from "@paperclipai/shared";

// DUR-4182: a Job is a one-press task definition attached to one or more
// Positions (company_agent_roles). Every agent hired into a linked position
// sees this job as a one-click action. Deliberately NOT an extension of the
// `routines` table (see routines.ts) -- a routine is owned by a single
// assignee agent, while a job's whole point is to be available to every
// agent that currently holds a linked position, so it needed its own
// assignment model rather than widening routines' single-assigneeAgentId
// shape.
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    // Instructions/description template for the task created when this job
    // runs. Supports the same {{variableName}} interpolation as routines
    // (see packages/shared/src/routine-variables.ts, reused as-is for jobs).
    instructions: text("instructions"),
    status: text("status").notNull().default("active"),
    variables: jsonb("variables").$type<JobVariable[]>().notNull().default([]),
    // "quick_agent" | "full_agent" -- see JOB_RUN_MODES.
    runMode: text("run_mode").notNull().default("full_agent"),
    // Optional MODEL_PROFILE_KEYS value applied via the created issue's
    // assigneeAdapterOverrides.modelProfile. Null keeps the assignee's
    // normal default.
    modelProfile: text("model_profile"),
    // Free-text effort level, applied via
    // assigneeAdapterOverrides.adapterConfig.effort (adapter-specific, same
    // loosely-typed contract the per-task model/effort selector already
    // uses -- see issueAssigneeAdapterOverridesSchema).
    effort: text("effort"),
    // Optional hint for the output shape the job should produce (e.g.
    // "markdown_document", "redline"). Free text -- rendered by the UI,
    // not validated server-side.
    outputFormat: text("output_format"),
    // The "needs Filip's approval before done" gate. See
    // server/src/services/job-approval-gate.ts for how this is enforced on
    // the issue a run creates.
    requiresApproval: boolean("requires_approval").notNull().default(false),
    isBuiltin: boolean("is_builtin").notNull().default(false),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("jobs_company_status_idx").on(table.companyId, table.status),
    companyProjectIdx: index("jobs_company_project_idx").on(table.companyId, table.projectId),
  }),
);

// Many-to-many Job <-> Position (company_agent_roles). "Position jobs appear
// for every agent hired into that position" is resolved by joining an
// agent's current role (agents.roleId) against this table.
export const jobPositions = pgTable(
  "job_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    positionId: uuid("position_id").notNull().references(() => companyAgentRoles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobPositionUq: uniqueIndex("job_positions_job_position_uq").on(table.jobId, table.positionId),
    companyPositionIdx: index("job_positions_company_position_idx").on(table.companyId, table.positionId),
  }),
);

export const jobTriggers = pgTable(
  "job_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    // "manual" | "schedule" | "webhook" | "api" | "email" -- see JOB_TRIGGER_KINDS.
    kind: text("kind").notNull(),
    label: text("label"),
    enabled: boolean("enabled").notNull().default(true),
    cronExpression: text("cron_expression"),
    timezone: text("timezone"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    publicId: text("public_id"),
    secretId: uuid("secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    signingMode: text("signing_mode"),
    replayWindowSec: integer("replay_window_sec"),
    // For kind="email": the inbound address/match rule this trigger fires
    // on. Replaces the old "Duties" concept. Actual inbound-mail dispatch
    // wiring (connecting this to the mail-secretary pipeline) is tracked as
    // a follow-up -- this column only carries the match configuration today.
    emailMatchAddress: text("email_match_address"),
    lastResult: text("last_result"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyJobIdx: index("job_triggers_company_job_idx").on(table.companyId, table.jobId),
    companyKindIdx: index("job_triggers_company_kind_idx").on(table.companyId, table.kind),
    publicIdUq: uniqueIndex("job_triggers_public_id_uq").on(table.publicId),
  }),
);

export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    triggerId: uuid("trigger_id").references(() => jobTriggers.id, { onDelete: "set null" }),
    // Who the created task is for. Distinct from the caller: "a quick agent
    // like Maja can start jobs on colleagues" means runAgentId commonly
    // differs from the run's createdByAgentId below.
    runAgentId: uuid("run_agent_id").notNull().references(() => agents.id),
    source: text("source").notNull(),
    status: text("status").notNull().default("received"),
    formValues: jsonb("form_values").$type<Record<string, unknown>>().notNull().default({}),
    linkedIssueId: uuid("linked_issue_id").references(() => issues.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key"),
    failureReason: text("failure_reason"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyJobIdx: index("job_runs_company_job_idx").on(table.companyId, table.jobId, table.createdAt),
    runAgentIdx: index("job_runs_run_agent_idx").on(table.runAgentId),
    linkedIssueIdx: index("job_runs_linked_issue_idx").on(table.linkedIssueId),
    idempotencyIdx: index("job_runs_idempotency_idx").on(table.jobId, table.idempotencyKey),
  }),
);
