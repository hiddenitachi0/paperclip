import { z } from "zod";

/**
 * Agent quality loops (per company, opt-in): the OFFENSIVE side of the loops around an
 * agent's "I'm done". Three checks a company can switch on under Company settings:
 *
 * 1. Self-check: before a task moves to review/done the first time, the agent is woken
 *    once more to compare its work with what the task asked for and fix what is missing.
 * 2. Independent finish check: a cheap call to one of the company's own saved models
 *    reads the request next to the agent's final note and answers "done" or "not done,
 *    here is what is missing". Not done sends the task back (bounded rounds, then the
 *    person is asked).
 * 3. Default reviewer for code tasks: a new code task gets "have <agent> review before
 *    done" set up automatically (the existing review-stage machinery).
 *
 * A company with no settings row has all three OFF (existing companies keep today's
 * behaviour). A newly created company gets QUALITY_LOOPS_NEW_COMPANY_DEFAULTS.
 */

/** cost_events.billing_code for the independent finish check's model calls. */
export const QUALITY_CHECK_BILLING_CODE = "quality_check";

export const QUALITY_SELF_REVIEW_MAX_PASSES = 3;
export const QUALITY_DONE_CHECK_MAX_ROUNDS = 3;
export const QUALITY_DONE_CHECK_DEFAULT_ROUNDS = 2;

export interface CompanyQualityLoopSettings {
  /** True once the company has a settings row (it chose, or was created with defaults). */
  configured: boolean;
  /** Extra self-check passes per task before it may move to review/done (0 = off). */
  selfReviewPasses: number;
  /** Whether the independent finish check runs when an agent marks a task done. */
  doneCheckEnabled: boolean;
  /** "Not done" rounds before the person is asked instead (1-3). */
  doneCheckMaxRounds: number;
  /** The saved model the finish check uses. Null = the helper's default saved model. */
  doneCheckDirectoryEntryId: string | null;
  /**
   * What the finish check will actually use right now (the explicit pick, else the
   * helper's default saved model), or null when the company has no saved model for it --
   * the check is then skipped with a note on the task.
   */
  effectiveDoneCheckModel: { directoryEntryId: string; name: string } | null;
  /** Agent that reviews new code tasks before they are done. Null = none. */
  defaultReviewerAgentId: string | null;
}

export const QUALITY_LOOPS_NEW_COMPANY_DEFAULTS = {
  selfReviewPasses: 1,
  doneCheckEnabled: true,
  doneCheckMaxRounds: QUALITY_DONE_CHECK_DEFAULT_ROUNDS,
} as const;

export const updateCompanyQualityLoopSettingsSchema = z
  .object({
    selfReviewPasses: z.number().int().min(0).max(QUALITY_SELF_REVIEW_MAX_PASSES).optional(),
    doneCheckEnabled: z.boolean().optional(),
    doneCheckMaxRounds: z.number().int().min(1).max(QUALITY_DONE_CHECK_MAX_ROUNDS).optional(),
    doneCheckDirectoryEntryId: z.string().uuid().nullable().optional(),
    defaultReviewerAgentId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type UpdateCompanyQualityLoopSettings = z.infer<typeof updateCompanyQualityLoopSettingsSchema>;
