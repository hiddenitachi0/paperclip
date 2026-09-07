import type { CrossCompanyInstructionStatus } from "../validators/cross-company-instruction.js";

/**
 * One instruction sent across the company wall. Visible to both the
 * sending and the receiving company; the text is the only thing either side
 * ever learns about the other through this channel.
 */
export interface CrossCompanyInstruction {
  id: string;
  fromCompanyId: string;
  fromAgentId: string;
  toCompanyId: string;
  toAgentId: string;
  subject: string;
  instruction: string;
  status: CrossCompanyInstructionStatus;
  approvalId: string | null;
  deliveredIssueId: string | null;
  decidedByUserId: string | null;
  decisionNote: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
