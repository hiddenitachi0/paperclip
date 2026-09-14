/**
 * DUR-3976: the monthly spending limit a new hire starts with.
 *
 * Employing an agent spends the company's money every month. Before this, a
 * hire made by hand always started with no limit (the employment form sent 0
 * and the create schema defaulted to 0), so the budget guard could never trip
 * on it and the first signal was the bill. On 12 Sep 2026 three Nordstrand
 * agents were found running with no limit, one at $230 for the month, while
 * the one agent that did have a limit paused itself exactly as intended.
 *
 * Operator decision (14 Sep 2026): a new hire starts at $50 a month. The
 * operator can change that on the employment form. Having no limit at all is
 * still possible, but only as an explicit 0, which the approval card shows as
 * "No monthly limit".
 *
 * What actually enforces the number is a budget policy (budget_policies,
 * scope "agent", window "calendar_month_utc", metric "billed_cents") created
 * via budgetService.upsertPolicy. The agents.budget_monthly_cents column is
 * only a copy of that policy's amount for display. The hire routes
 * (routes/agents.ts) and approving a hire card (services/approvals.ts) create
 * that policy whenever this amount is above 0.
 */

/** $50.00 a month. */
export const DEFAULT_HIRE_MONTHLY_SPENDING_LIMIT_CENTS = 5000;

/**
 * The monthly limit a hire approval card stands for, in cents. This is the one
 * reading used both by the card the board reads (ui ApprovalPayload) and by
 * the code that applies the card on approval (server services/approvals.ts),
 * so the board approves exactly the number it read.
 *
 * - A number: that amount (0 means an explicit "no monthly limit").
 * - Missing or unreadable: the standard limit. Every card the hire route files
 *   carries a number, so this only affects a hand-made card. A card that does
 *   not say must not quietly mean "no limit".
 */
export function hireMonthlySpendingLimitCentsFromPayload(
  payload: Record<string, unknown> | null | undefined,
): number {
  const value = payload?.budgetMonthlyCents;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_HIRE_MONTHLY_SPENDING_LIMIT_CENTS;
  }
  return Math.max(0, Math.floor(value));
}
