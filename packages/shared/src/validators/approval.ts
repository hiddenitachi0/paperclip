import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
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
