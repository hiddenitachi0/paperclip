import { z } from "zod";
import { APPROVAL_TYPES, ESCALATION_GRANT_MAX_DURATION_MINUTES } from "../constants.js";
import { multilineTextSchema } from "./text.js";
import { mcpServerConfigSchema } from "./agent.js";

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

/**
 * `request_board_approval` payload convention for an agent requesting a new
 * tool connection (MCP server) for itself. This is the only path an
 * agent-authenticated caller has to gain a new tool connection at all --
 * `assertNoAgentToolConnectionMutation` in server/src/routes/agents.ts refuses
 * the direct PATCH path unconditionally. `capabilitySummary` is always
 * recomputed server-side from `server` when the approval is filed (see
 * appendToolGrantCapabilitySummary in server/src/routes/approvals.ts) rather
 * than trusted from the requester, since that is exactly the plain-language
 * "what can this reach, what would it be allowed to do" text the operator
 * relies on to decide.
 */
export const toolGrantRequestPayloadSchema = z
  .object({
    kind: z.literal("tool_grant"),
    agentId: z.string().uuid(),
    server: mcpServerConfigSchema,
    reason: multilineTextSchema.pipe(z.string().trim().min(1)),
    title: z.string().min(1),
    summary: multilineTextSchema.optional(),
    capabilitySummary: z.string().optional(),
    risks: z.array(z.string()).optional(),
  })
  .strict();

export type ToolGrantRequestPayload = z.infer<typeof toolGrantRequestPayloadSchema>;

/**
 * `request_board_approval` payload convention for a boss-proposed instructions
 * change (DUR-69/DUR-109). An agent can never edit its own or anyone else's
 * instructions directly -- `assertNoAgentInstructionsConfigMutation` and
 * `assertCanManageInstructionsPath` in server/src/routes/agents.ts refuse
 * every direct route unconditionally. This is the only path: a boss proposes
 * replacement content for a direct report, and nothing is written to disk
 * until an operator approves it (see the `instructions_change` branch of
 * approvalService.approve in server/src/services/approvals.ts).
 *
 * `beforeContent` is always recomputed server-side from the agent's current
 * instructions file at filing time (see server/src/routes/approvals.ts) and
 * never trusted from the requester -- exactly like `capabilitySummary` above,
 * this is the part of the readable diff a proposer can't be trusted to
 * characterize fairly. It defaults to "" here (rather than being required)
 * precisely because the proposing caller is never the one who sets it; the
 * route always overwrites whatever it receives before persisting.
 */
export const instructionsChangeRequestPayloadSchema = z
  .object({
    kind: z.literal("instructions_change"),
    agentId: z.string().uuid(),
    relativePath: z.string().trim().min(1),
    beforeContent: z.string().default(""),
    afterContent: z.string().min(1),
    reason: multilineTextSchema.pipe(z.string().trim().min(1)),
    title: z.string().min(1),
    summary: multilineTextSchema.optional(),
  })
  .strict()
  .refine((data) => data.beforeContent !== data.afterContent, {
    message: "Proposed instructions must differ from the agent's current instructions",
    path: ["afterContent"],
  });

export type InstructionsChangeRequestPayload = z.infer<typeof instructionsChangeRequestPayloadSchema>;
