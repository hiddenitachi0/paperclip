import { z } from "zod";
import { multilineTextSchema } from "./validators/text.js";

/**
 * DUR-4566: which agent is "the company's security reviewer" for the
 * merge-card security-review gate. Mirrors `EmailSettings`'s lazy-row shape --
 * absence of a row reads as `{ securityReviewerAgentId: null }`, which the
 * "Request security review" button renders as "choose a reviewer first"
 * rather than silently doing nothing.
 */
export interface SecurityReviewSettings {
  securityReviewerAgentId: string | null;
}

export const updateSecurityReviewSettingsSchema = z
  .object({
    securityReviewerAgentId: z.string().uuid().nullable(),
  })
  .strict();
export type UpdateSecurityReviewSettingsInput = z.infer<typeof updateSecurityReviewSettingsSchema>;

/**
 * The plain-words state a merge card shows, computed per the approval's
 * current head commit (`payload.commit`) -- never stored as a single flag, so
 * a later push can turn a `passed` review `out_of_date` without deleting the
 * review history. See `securityReviewService` in
 * server/src/services/security-review.ts.
 */
export const SECURITY_REVIEW_STATES = [
  "not_requested",
  "no_reviewer_configured",
  "in_progress",
  "passed",
  "failed",
  "out_of_date",
] as const;
export type SecurityReviewStateKind = (typeof SECURITY_REVIEW_STATES)[number];

export interface SecurityReviewState {
  state: SecurityReviewStateKind;
  headCommit: string | null;
  reviewIssueId: string | null;
  reviewIssueIdentifier: string | null;
  verdictNote: string | null;
  verdictCommentUrl: string | null;
  decidedAt: string | null;
  /** Only set for `out_of_date`: what the stale verdict actually was. */
  priorState: "passed" | "failed" | null;
}

export const recordSecurityReviewVerdictSchema = z
  .object({
    verdict: z.enum(["passed", "failed"]),
    note: multilineTextSchema.pipe(z.string().trim().min(1)),
    commentUrl: z.string().trim().url().optional(),
  })
  .strict();
export type RecordSecurityReviewVerdictInput = z.infer<typeof recordSecurityReviewVerdictSchema>;
