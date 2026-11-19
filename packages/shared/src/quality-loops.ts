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
 * behaviour). A newly created company gets QUALITY_LOOPS_NEW_COMPANY_DEFAULTS (self-check
 * on, finish check off until an owner turns it on).
 */

/** cost_events.billing_code for the independent finish check's model calls. */
export const QUALITY_CHECK_BILLING_CODE = "quality_check";

export const QUALITY_SELF_REVIEW_MAX_PASSES = 3;
export const QUALITY_DONE_CHECK_MAX_ROUNDS = 3;
export const QUALITY_DONE_CHECK_DEFAULT_ROUNDS = 2;
/** Key in project_workspaces.metadata that holds the workspace's "Test command (run before review)". */
export const PROJECT_WORKSPACE_TEST_COMMAND_KEY = "testCommand";
/** Rounds of "tests failed, fix and try again" before a task goes to review anyway. */
export const QUALITY_PRE_REVIEW_MAX_ROUNDS = 2;
/** Default time limit for the project's test command before review. */
export const QUALITY_PRE_REVIEW_TEST_TIMEOUT_MS = 15 * 60 * 1000;

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
  /**
   * Before an agent moves a task to review, run the project's test command and check the
   * diff against what the task asked for. Failures go back to the same agent (at most
   * QUALITY_PRE_REVIEW_MAX_ROUNDS times). Only applies to projects that have a test command.
   */
  preReviewQualityLoop: boolean;
}

// The finish check spends money on a model, so it stays off until an owner turns it on.
export const QUALITY_LOOPS_NEW_COMPANY_DEFAULTS = {
  selfReviewPasses: 1,
  doneCheckEnabled: false,
  doneCheckMaxRounds: QUALITY_DONE_CHECK_DEFAULT_ROUNDS,
} as const;

export const updateCompanyQualityLoopSettingsSchema = z
  .object({
    selfReviewPasses: z.number().int().min(0).max(QUALITY_SELF_REVIEW_MAX_PASSES).optional(),
    doneCheckEnabled: z.boolean().optional(),
    doneCheckMaxRounds: z.number().int().min(1).max(QUALITY_DONE_CHECK_MAX_ROUNDS).optional(),
    doneCheckDirectoryEntryId: z.string().uuid().nullable().optional(),
    defaultReviewerAgentId: z.string().uuid().nullable().optional(),
    preReviewQualityLoop: z.boolean().optional(),
  })
  .strict();
export type UpdateCompanyQualityLoopSettings = z.infer<typeof updateCompanyQualityLoopSettingsSchema>;
