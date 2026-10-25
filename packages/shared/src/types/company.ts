import type { CompanyStatus, PauseReason } from "../constants.js";

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  attachmentMaxBytes: number;
  requireBoardApprovalForNewAgents: boolean;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  brandColor: string | null;
  worktreeCleanupRetentionDays: number | null;
  /**
   * Franchise migration: set when an owner/admin marked this (source) company
   * as moved to another Paperclip. The UI shows "This company has moved to
   * <url>" while it is set. Optional so older fixtures stay valid.
   */
  migratedToUrl?: string | null;
  migratedAt?: Date | null;
  migratedByUserId?: string | null;
  /** Sub-tasks get their parent task's model/effort setting unless they set their own. Default true. */
  subtasksInheritModelEffort: boolean;
  /** "Brag videos for finished tasks" switch (default on). Off hides/disables the task tick box. */
  bragOnDoneEnabled?: boolean;
  /** Most one finished-task video may cost, in cents. null = the default cap. */
  bragOnDoneMaxCostCents?: number | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
