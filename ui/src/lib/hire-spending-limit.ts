import { DEFAULT_HIRE_MONTHLY_SPENDING_LIMIT_CENTS } from "@paperclipai/shared";
import { formatCents } from "./utils";

/**
 * DUR-3976: the monthly spending limit chosen while employing someone.
 *
 * The employment form and the hire approval card both take their words from
 * here, so the board approves exactly the sentence the limit was offered in.
 *
 * Every sentence has to be true of what actually happens. When an agent's
 * spending for the month reaches its limit, the budget guard
 * (server/src/services/budgets.ts) pauses the agent, cancels the work in
 * progress, and files a "Budget Override" card whose choices are raising the
 * limit or keeping the agent paused. The agent stays stopped until someone
 * acts: nothing restarts it automatically when the month ends, so the text
 * below never promises that it does.
 */

export const SPENDING_LIMIT_HEADING = "Monthly spending limit";

export const SPENDING_LIMIT_EXPLANATION =
  "The most this person may spend in a calendar month. If they reach it, they stop working and you get a card asking whether to raise the limit or keep them stopped.";

export const NO_SPENDING_LIMIT_CHOICE = "No monthly limit (not recommended)";

export const NO_SPENDING_LIMIT_WARNING =
  "Nothing will stop their spending. The first you hear of it may be the bill.";

/** The standard limit as the form pre-fills it: "50". */
export const DEFAULT_SPENDING_LIMIT_DOLLARS_TEXT = String(DEFAULT_HIRE_MONTHLY_SPENDING_LIMIT_CENTS / 100);

/** Largest amount the database column holds. */
const MAX_LIMIT_CENTS = 2_147_483_647;

/** One line saying what was chosen, identical on the form and on the card. */
export function spendingLimitSummary(cents: number): string {
  return cents > 0 ? `Up to ${formatCents(cents)} a month` : "No monthly limit";
}

export type SpendingLimitChoice =
  | { ok: true; cents: number }
  | { ok: false; message: string };

/**
 * Turns what the operator typed into the cents the API expects.
 *
 * Choice made (DUR-3976): clearing the box or typing 0 does NOT mean "no
 * limit". A hire with no limit is only possible by ticking the separate "No
 * monthly limit" box, which puts a warning on the form and on the card.
 * Otherwise an empty or zero amount is refused, and the form says why.
 */
export function resolveSpendingLimitChoice(input: {
  dollarsText: string;
  noLimit: boolean;
}): SpendingLimitChoice {
  if (input.noLimit) return { ok: true, cents: 0 };
  // Spaces (including the non-breaking kinds) are only ever grouping, as in
  // "1 000", so they are safe to drop.
  let text = input.dollarsText.trim().replace(/^\$/, "").replace(/[\s  ]/g, "");
  if (text.length === 0) {
    return {
      ok: false,
      message: "Enter a monthly spending limit, or tick \"No monthly limit\" if you really want none.",
    };
  }
  // The operator is Norwegian, where the comma is the DECIMAL mark: "50,00" is
  // fifty dollars. Treating every comma as a thousands separator turned that
  // into $5,000 — a limit 100x too high, which is the one mistake a spending
  // limit must never make, because it fails open on money.
  //
  // So a comma or dot followed by one or two digits is a decimal mark. A comma
  // or dot followed by exactly three digits could be either ("1,000" / "1.000")
  // and is refused rather than guessed. So is mixing both separators.
  const ambiguous = "Write the amount without thousands separators, like 1000 or 50.50.";
  if (text.includes(",") && text.includes(".")) return { ok: false, message: ambiguous };
  if (/[.,]\d{3}$/.test(text)) return { ok: false, message: ambiguous };
  if (text.includes(",")) {
    if (!/^\d+,\d{1,2}$/.test(text)) return { ok: false, message: ambiguous };
    text = text.replace(",", ".");
  }
  const dollars = Number(text);
  if (!Number.isFinite(dollars) || dollars < 0) {
    return { ok: false, message: "The monthly spending limit must be an amount in dollars, like 50." };
  }
  const cents = Math.round(dollars * 100);
  if (cents <= 0) {
    return {
      ok: false,
      message: "A limit of $0 would stop this person before they start. Enter an amount, or tick \"No monthly limit\".",
    };
  }
  if (cents > MAX_LIMIT_CENTS) {
    return { ok: false, message: "That monthly spending limit is too large." };
  }
  return { ok: true, cents };
}
