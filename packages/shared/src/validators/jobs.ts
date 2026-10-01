import { z } from "zod";
import {
  JOB_RUN_MODES,
  JOB_STATUSES,
  JOB_VARIABLE_TYPES,
  MODEL_PROFILE_KEYS,
  ROUTINE_TRIGGER_SIGNING_MODES,
} from "../constants.js";
import { isValidRoutineDateString } from "../routine-variables.js";

const jobVariableValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const jobVariableSchema = z
  .object({
    name: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    label: z.string().trim().max(120).optional().nullable().default(null),
    type: z.enum(JOB_VARIABLE_TYPES).optional().default("text"),
    defaultValue: jobVariableValueSchema.optional().nullable().default(null),
    required: z.boolean().optional().default(true),
    options: z.array(z.string().trim().min(1).max(120)).max(50).optional().default([]),
  })
  .superRefine((value, ctx) => {
    if (value.type === "select" && value.options.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Select variables require at least one option",
      });
    }
    if (value.type !== "select" && value.options.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Only select variables can define options",
      });
    }
    if (value.type === "select" && value.defaultValue != null) {
      if (typeof value.defaultValue !== "string" || !value.options.includes(value.defaultValue)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["defaultValue"],
          message: "Select variable defaults must match one of the allowed options",
        });
      }
    }
    if (value.type === "date" && value.defaultValue != null) {
      if (typeof value.defaultValue !== "string" || !isValidRoutineDateString(value.defaultValue)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["defaultValue"],
          message: "Date variable defaults must be valid YYYY-MM-DD calendar dates",
        });
      }
    }
    if (value.type === "file_upload" && value.defaultValue != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: "File-upload variables cannot define a default value",
      });
    }
  });

export const createJobSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().optional().nullable(),
  status: z.enum(JOB_STATUSES).optional().default("active"),
  variables: z.array(jobVariableSchema).optional().default([]),
  runMode: z.enum(JOB_RUN_MODES).optional().default("full_agent"),
  modelProfile: z.enum(MODEL_PROFILE_KEYS).optional().nullable(),
  effort: z.string().trim().max(60).optional().nullable(),
  outputFormat: z.string().trim().max(120).optional().nullable(),
  requiresApproval: z.boolean().optional().default(false),
  positionIds: z.array(z.string().uuid()).max(50).optional().default([]),
});
export type CreateJob = z.infer<typeof createJobSchema>;

export const updateJobSchema = createJobSchema.partial();
export type UpdateJob = z.infer<typeof updateJobSchema>;

export const setJobPositionsSchema = z.object({
  positionIds: z.array(z.string().uuid()).max(50),
});
export type SetJobPositions = z.infer<typeof setJobPositionsSchema>;

const baseJobTriggerSchema = z.object({
  label: z.string().trim().max(120).optional().nullable(),
  enabled: z.boolean().optional().default(true),
});

export const createJobTriggerSchema = z.discriminatedUnion("kind", [
  baseJobTriggerSchema.extend({
    kind: z.literal("schedule"),
    cronExpression: z.string().trim().min(1),
    timezone: z.string().trim().min(1).default("UTC"),
  }),
  baseJobTriggerSchema.extend({
    kind: z.literal("webhook"),
    signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().default("bearer"),
    replayWindowSec: z.number().int().min(30).max(86_400).optional().default(300),
  }),
  baseJobTriggerSchema.extend({
    kind: z.literal("api"),
  }),
  baseJobTriggerSchema.extend({
    // DUR-4182: email trigger storage only -- see packages/db/src/schema/jobs.ts
    // for why inbound-mail dispatch wiring is a tracked follow-up rather than
    // part of this column's contract.
    kind: z.literal("email"),
    emailMatchAddress: z.string().trim().min(3).max(320),
  }),
]);
export type CreateJobTrigger = z.infer<typeof createJobTriggerSchema>;

export const updateJobTriggerSchema = z.object({
  label: z.string().trim().max(120).optional().nullable(),
  enabled: z.boolean().optional(),
  cronExpression: z.string().trim().min(1).optional().nullable(),
  timezone: z.string().trim().min(1).optional().nullable(),
  signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().nullable(),
  replayWindowSec: z.number().int().min(30).max(86_400).optional().nullable(),
  emailMatchAddress: z.string().trim().min(3).max(320).optional().nullable(),
});
export type UpdateJobTrigger = z.infer<typeof updateJobTriggerSchema>;

export const runJobSchema = z.object({
  // Who the created task is assigned to. Required (unlike routines, a job has
  // no single default assignee -- "position jobs appear for every agent hired
  // into that position", so the caller always names which colleague runs it).
  runAgentId: z.string().uuid(),
  triggerId: z.string().uuid().optional().nullable(),
  formValues: z.record(z.string(), jobVariableValueSchema).optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  idempotencyKey: z.string().trim().max(255).optional().nullable(),
  // "telegram" covers a quick-agent persona (e.g. Maja) starting a job on a
  // colleague from a Telegram bridge command -- see job-run contract in
  // server/src/services/jobs.ts.
  source: z.enum(["manual", "api", "telegram"]).optional().default("manual"),
});
export type RunJob = z.infer<typeof runJobSchema>;
