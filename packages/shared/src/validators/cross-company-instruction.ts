import { z } from "zod";
import { multilineTextSchema } from "./text.js";

/**
 * Body of `POST /api/companies/{companyId}/cross-company-instructions`
 * (the sending company is the path param). Only plain text crosses the
 * company wall, so the body is deliberately just a subject, the instruction
 * itself and the receiving company's id -- no attachments, no references to
 * issues/files/secrets, no free-form metadata.
 */
export const sendCrossCompanyInstructionSchema = z
  .object({
    toCompanyId: z.string().uuid(),
    subject: z.string().trim().min(1).max(200),
    instruction: multilineTextSchema.pipe(z.string().trim().min(1).max(20_000)),
  })
  .strict();

export type SendCrossCompanyInstruction = z.infer<typeof sendCrossCompanyInstructionSchema>;

export const CROSS_COMPANY_INSTRUCTION_STATUSES = ["pending_approval", "delivered", "rejected"] as const;
export type CrossCompanyInstructionStatus = (typeof CROSS_COMPANY_INSTRUCTION_STATUSES)[number];

/** Approval payload the receiving company's board sees (kind-tagged like deploy / tool_grant). */
export const crossCompanyInstructionRequestPayloadSchema = z
  .object({
    kind: z.literal("cross_company_instruction"),
    instructionId: z.string().uuid(),
    fromCompanyId: z.string().uuid(),
    fromCompanyName: z.string().min(1),
    fromAgentId: z.string().uuid(),
    fromAgentName: z.string().min(1),
    toAgentId: z.string().uuid(),
    toAgentName: z.string().min(1),
    subject: z.string().min(1),
    instruction: z.string().min(1),
    // Generic board-card fields (title / summary / nextActionOnApproval /
    // risks) so the existing approval card renders it in plain language.
    title: z.string().min(1),
    summary: z.string().min(1),
    nextActionOnApproval: z.string().min(1),
    risks: z.array(z.string()).default([]),
  })
  .strict();

export type CrossCompanyInstructionRequestPayload = z.infer<typeof crossCompanyInstructionRequestPayloadSchema>;
