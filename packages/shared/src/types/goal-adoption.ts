/**
 * DUR-375: goal adoption visibility dashboard.
 *
 * "Adoption" here means an issue carries a non-null `goalId` -- the same
 * column DUR-315's friction-reduction work (DUR-376's create/edit form
 * selector) targets. This is a reporting-only surface: no schema change, no
 * new blocking gate.
 */

export interface GoalAdoptionSnapshot {
  companyId: string;
  /** Non-hidden issues in the company, as of now. */
  totalIssues: number;
  /** Of `totalIssues`, how many have a non-null `goalId`. */
  withGoal: number;
  /** `totalIssues - withGoal`. */
  withoutGoal: number;
  /** `withGoal / totalIssues * 100`, rounded to 2dp. `0` when there are no issues. */
  adoptionPercent: number;
}

export interface GoalAdoptionTrendPoint {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  /**
   * Cumulative count of non-hidden issues created on or before this day,
   * evaluated against each issue's *current* goalId (not a point-in-time
   * snapshot of what the goalId was on that day). This is a computed-on-read
   * approximation, not a stored daily snapshot -- see
   * `goalAdoptionService.trend` for the tradeoff.
   */
  totalIssues: number;
  withGoal: number;
  withoutGoal: number;
  adoptionPercent: number;
}
