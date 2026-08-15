import type { EscalationGrantExpiredReason, EscalationGrantStatus } from "../constants.js";

export interface EscalationGrant {
  id: string;
  companyId: string;
  issueId: string;
  agentId: string;
  approvalId: string;
  grantedModel: string | null;
  grantedEffort: string | null;
  reason: string;
  maxSpendCents: number;
  expiresAt: Date;
  status: EscalationGrantStatus;
  expiredReason: EscalationGrantExpiredReason | null;
  expiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** `EscalationGrant` plus the spend observed against it, for display. */
export interface EscalationGrantWithSpend extends EscalationGrant {
  spentCents: number;
}
