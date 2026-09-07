import type { CrossCompanyInstructionStatus } from "../validators/cross-company-instruction.js";

/**
 * What the SENDING company sees of an instruction it sent across the company
 * wall: its own side (who sent it, to which company, the text) plus the
 * outcome (status, when it was decided). Nothing that belongs to the receiving
 * company's side -- which of its agents is the liaison, its approval card, the
 * board's decision note, who decided, the task it became -- is ever returned to
 * the sender.
 */
export interface CrossCompanyInstructionSenderView {
  id: string;
  fromCompanyId: string;
  fromAgentId: string;
  toCompanyId: string;
  subject: string;
  instruction: string;
  status: CrossCompanyInstructionStatus;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The full row, returned only to the RECEIVING company (the side that owns
 * the liaison, the approval card, the decision and the delivered task).
 */
export interface CrossCompanyInstruction extends CrossCompanyInstructionSenderView {
  toAgentId: string;
  approvalId: string | null;
  deliveredIssueId: string | null;
  decidedByUserId: string | null;
  decisionNote: string | null;
}

/** One list entry: the full row when the caller received it, the sender view when it sent it. */
export type CrossCompanyInstructionView = CrossCompanyInstruction | CrossCompanyInstructionSenderView;
