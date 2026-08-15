import { z } from "zod";
import { APPROVAL_TYPES, ESCALATION_GRANT_MAX_DURATION_MINUTES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;

/**
 * `request_board_approval` payload convention for deploy requests filed against
 * a project's `deployPolicy`. Formalizes the `{kind:"deploy", ...}` shape the
 * on-box deploy runner already expects informally.
 */
export const deployRequestPayloadSchema = z
  .object({
    kind: z.literal("deploy"),
    projectId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    commit: z.string().optional(),
    title: z.string().min(1),
    note: multilineTextSchema,
  })
  .strict();

export type DeployRequestPayload = z.infer<typeof deployRequestPayloadSchema>;

/**
 * `request_board_approval` payload convention for a temporary model/effort boost
 * (DUR-31): a working agent asks for a stronger model/effort on its CURRENT task
 * only. Approving this never hires or creates an agent -- see `escalation_grants`
 * in packages/db, which records the time-boxed, money-capped grant this creates.
 */
export const modelBoostRequestPayloadSchema = z
  .object({
    kind: z.literal("model_boost"),
    issueId: z.string().uuid(),
    agentId: z.string().uuid(),
    requestedModel: z.string().trim().min(1).optional(),
    requestedEffort: z.string().trim().min(1).optional(),
    reason: multilineTextSchema.pipe(z.string().trim().min(1)),
    estimatedExtraCostCents: z.number().int().positive(),
    maxSpendCents: z.number().int().positive(),
    durationMinutes: z.number().int().positive().max(ESCALATION_GRANT_MAX_DURATION_MINUTES).optional(),
    title: z.string().min(1),
    summary: multilineTextSchema,
  })
  .strict()
  .refine((data) => Boolean(data.requestedModel || data.requestedEffort), {
    message: "Must request a model and/or effort boost",
    path: ["requestedModel"],
  });

export type ModelBoostRequestPayload = z.infer<typeof modelBoostRequestPayloadSchema>;
