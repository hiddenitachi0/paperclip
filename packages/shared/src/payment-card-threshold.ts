/**
 * DUR-4040 (Maja browser step 5): the NOK-threshold rule for whether an
 * agent's browser purchase needs board approval before it can complete, and
 * the total-amount parser that reads a checkout page's text to find the
 * number this rule runs on.
 *
 * Currency rule (from Filip, overrides the original per-currency design):
 * every currency converts to NOK via an operator-editable FX table and is
 * compared against one 500 NOK line. No currency is refused for being
 * foreign -- being unable to read or convert the amount is what requires
 * approval, not the currency itself. Purchasing (fill/arm/confirm, clearance
 * plumbing, card consumption) is step 6 and is not built here; this module is
 * pure functions only, so it is fully unit-testable before that lands.
 */

/** 500 NOK, strictly below is auto-approved, at or above needs approval. */
export const NOK_APPROVAL_THRESHOLD = 500;

/**
 * Seed rates, NOK per one unit of the given currency. Deliberately only the
 * two Filip gave a number for (plus the NOK identity) -- guessing a rate for
 * a currency nobody asked for risks under-converting a purchase past the
 * threshold unnoticed, which is the one direction this rule must never fail
 * in. An operator (or a later settings screen) extends this table; callers
 * needing a different table pass their own via `fxRatesToNok`.
 */
export const DEFAULT_FX_RATES_TO_NOK: Readonly<Record<string, number>> = {
  NOK: 1,
  USD: 11.5,
  EUR: 12.5,
};

export const PURCHASE_CAPS = {
  dailyNok: 1000,
  weeklyNok: 2500,
  autoPurchasesPerDay: 3,
  perMerchantPerDay: 1,
  perMerchantPerWeek: 2,
} as const;

function normalizeCurrencyCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Currency symbol/prefix -> ISO code, checked longest-first so "US$" wins over "$". */
const CURRENCY_TOKENS: ReadonlyArray<{ token: string; code: string }> = [
  { token: "US$", code: "USD" },
  { token: "NOK", code: "NOK" },
  { token: "KR", code: "NOK" },
  { token: "EUR", code: "EUR" },
  { token: "€", code: "EUR" }, // €
  { token: "$", code: "USD" },
];

// NBSP ( ) and thin space ( ) are the separators a checkout page
// actually renders for grouped thousands (e.g. "1 234,56 kr"); normalize
// them to a plain space up front so every regex below only has to know one
// whitespace character.
function normalizeSpaces(text: string): string {
  return text.replace(/[   ]/g, " ");
}

/**
 * A run of digits with optional grouping/decimal separators, e.g. "1 234,56",
 * "1,234.56", "1234.56", "99". Deliberately permissive; `parseAmountNumber`
 * below decides which separator (if any) is the decimal point.
 */
const NUMBER_TOKEN = String.raw`\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;

/**
 * Tells a thousands separator apart from a decimal separator in a
 * money-shaped digit run, without knowing the currency's own convention up
 * front (a checkout page mixes "1.234,56 kr" and "$1,234.56" freely).
 * Heuristic, in order:
 *   - Only one kind of separator present, used exactly once, followed by
 *     exactly 1-2 digits -> that is the decimal separator.
 *   - Only one kind of separator present, used exactly once, followed by
 *     exactly 3 digits -> ambiguous on its own ("1.234" could be 1234 or
 *     1.234), treated as a thousands separator (the far more common case
 *     for a whole-currency-unit total), so the number is grouped, not
 *     fractional.
 *   - A separator used more than once, or two different separators present
 *     -> whichever separator appears last is the decimal point (or none, if
 *     the trailing group is exactly 3 digits, e.g. "1.234.567"), the rest are
 *     thousands separators.
 *   - A trailing run of exactly 3 digits after the last separator is always
 *     read as a thousands group, never a decimal (nobody writes cents to 3
 *     places), even if it is the only separator use.
 */
function parseAmountNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[\d.,\s]+$/.test(trimmed)) return null;
  const groups = trimmed.split(/([.,\s])/).filter((part) => part.length > 0);
  const digitsOnly = trimmed.replace(/[.,\s]/g, "");
  if (digitsOnly.length === 0) return null;

  const separators = trimmed.match(/[.,\s]/g) ?? [];
  if (separators.length === 0) {
    return Number(digitsOnly);
  }

  const lastSepIndex = trimmed.length - 1 - [...trimmed].reverse().findIndex((ch) => /[.,\s]/.test(ch));
  const afterLastSep = trimmed.slice(lastSepIndex + 1);
  const lastSepChar = trimmed[lastSepIndex];

  const isDecimalTail = afterLastSep.length > 0 && afterLastSep.length <= 2 && lastSepChar !== " ";
  if (!isDecimalTail) {
    // Every separator is a thousands grouping (or a trailing 3-digit group).
    return Number(digitsOnly);
  }

  const wholePart = trimmed.slice(0, lastSepIndex).replace(/[.,\s]/g, "");
  const fractionPart = afterLastSep;
  const value = Number(`${wholePart || "0"}.${fractionPart}`);
  void groups;
  return Number.isFinite(value) ? value : null;
}

export interface MoneyCandidate {
  /** The amount in major units of `currency` (e.g. kroner, dollars), not minor units. */
  amount: number;
  /** ISO-ish currency code resolved from the matched symbol/word, e.g. "NOK", "USD", "EUR". */
  currency: string;
  /** The exact substring matched, for debugging/audit. */
  raw: string;
  /** True when a total-style label (case-insensitive) sits on the same line. */
  labelled: boolean;
}

const TOTAL_LABEL_RE = /\b(total|totalt|totalbeløp|totalsum|grand total|amount due|sum|å betale|to pay)\b/i;

/**
 * Finds every amount+currency pair in free text, tagging each with whether a
 * "total"-shaped label sits on the same line. Handles kr/NOK (prefix or
 * suffix), €, US$ and bare $ (read as USD, the common web convention),
 * including NBSP/thin-space grouped thousands.
 */
export function findMoneyCandidates(text: string): MoneyCandidate[] {
  const normalized = normalizeSpaces(text);
  const lines = normalized.split(/\r?\n/);
  const found: MoneyCandidate[] = [];

  for (const line of lines) {
    const labelled = TOTAL_LABEL_RE.test(line);

    // Prefix currency: "$99.90", "US$99.90", "€99,90", "NOK 1200", "kr 1200".
    const prefixRe = new RegExp(
      `(US\\$|NOK|kr\\.?|\\u20AC|\\$)\\s?(${NUMBER_TOKEN})`,
      "gi",
    );
    for (const match of line.matchAll(prefixRe)) {
      const amount = parseAmountNumber(match[2]);
      const currency = resolveCurrencyToken(match[1]);
      if (amount !== null && currency) {
        found.push({ amount, currency, raw: match[0], labelled });
      }
    }

    // Suffix currency: "99.90 kr", "1 234,56 kr", "99,90 €".
    const suffixRe = new RegExp(
      `(${NUMBER_TOKEN})\\s?(kr\\.?|NOK|\\u20AC)`,
      "gi",
    );
    for (const match of line.matchAll(suffixRe)) {
      const amount = parseAmountNumber(match[1]);
      const currency = resolveCurrencyToken(match[2]);
      if (amount !== null && currency) {
        found.push({ amount, currency, raw: match[0], labelled });
      }
    }
  }

  return found;
}

function resolveCurrencyToken(token: string): string | null {
  const upper = token.trim().toUpperCase().replace(/\.$/, "");
  for (const entry of CURRENCY_TOKENS) {
    if (entry.token.toUpperCase().replace(/\.$/, "") === upper) return entry.code;
  }
  if (upper === "KR") return "NOK";
  return null;
}

export interface ParsedTotal {
  amount: number;
  currency: string;
  raw: string;
}

/**
 * Picks the one total to evaluate: the largest labelled candidate when any
 * exist (a checkout page with a subtotal and a grand total both labelled
 * "total" -- taking the largest is the safe direction, since under-reading
 * the real total is the failure mode that must never happen). Falls back to
 * the single unlabelled candidate when there is exactly one amount anywhere
 * in the text and nothing is labelled. Fails closed (returns null, "needs
 * approval") when there are multiple unlabelled candidates with nothing to
 * prefer between them, or when the largest labelled candidate is smaller
 * than some other candidate on the page -- a smaller "total"-labelled line
 * next to a larger unlabelled amount is a decoy/mislabel, not a total to
 * trust, and under-reading the charge must never happen silently.
 */
export function pickTotal(text: string): ParsedTotal | null {
  const candidates = findMoneyCandidates(text);
  if (candidates.length === 0) return null;

  const labelled = candidates.filter((candidate) => candidate.labelled);
  if (labelled.length === 0) {
    if (candidates.length !== 1) return null;
    const [only] = candidates;
    return { amount: only.amount, currency: only.currency, raw: only.raw };
  }

  const largestOverall = candidates.reduce((best, current) => (current.amount > best.amount ? current : best));
  const largestLabelled = labelled.reduce((best, current) => (current.amount > best.amount ? current : best));

  // The labelled total disagrees with a larger amount elsewhere on the page --
  // ambiguous, do not trust the smaller labelled number.
  if (largestLabelled.amount < largestOverall.amount) return null;

  return { amount: largestLabelled.amount, currency: largestLabelled.currency, raw: largestLabelled.raw };
}

export type PurchaseAmountReason =
  | "below_threshold"
  | "at_or_above_threshold"
  | "unparseable"
  | "ambiguous_currency";

export interface EvaluatePurchaseAmountResult {
  requiresApproval: boolean;
  reason: PurchaseAmountReason;
  /** The NOK-converted amount, or null when it could not be determined. */
  amountNok: number | null;
  detected: ParsedTotal | null;
}

export interface EvaluatePurchaseAmountInput {
  /** Raw checkout page text (or an already-known amount string) to parse. */
  text: string;
  fxRatesToNok?: Record<string, number>;
  thresholdNok?: number;
}

/**
 * The one rule: parse the page text for its total, convert to NOK, and say
 * whether that crosses the (default 500 NOK) approval line. Unparseable text
 * and a recognized-but-unconvertible currency both require approval -- this
 * function never returns "no approval needed" without a specific NOK number
 * it is confident in.
 */
export function evaluatePurchaseAmount(input: EvaluatePurchaseAmountInput): EvaluatePurchaseAmountResult {
  const threshold = input.thresholdNok ?? NOK_APPROVAL_THRESHOLD;
  const fxRates = input.fxRatesToNok ?? DEFAULT_FX_RATES_TO_NOK;
  const detected = pickTotal(input.text);
  if (!detected) {
    return { requiresApproval: true, reason: "unparseable", amountNok: null, detected: null };
  }

  const currency = normalizeCurrencyCode(detected.currency);
  const rate = fxRates[currency];
  if (rate === undefined) {
    return { requiresApproval: true, reason: "ambiguous_currency", amountNok: null, detected };
  }

  const amountNok = detected.amount * rate;
  const requiresApproval = amountNok >= threshold;
  return {
    requiresApproval,
    reason: requiresApproval ? "at_or_above_threshold" : "below_threshold",
    amountNok,
    detected,
  };
}

export interface PurchaseCapsInput {
  amountNok: number;
  merchant?: string | null;
  /** Already-completed auto-purchase spend today, NOT including this one. */
  spendTodayNok: number;
  spendThisWeekNok: number;
  autoPurchasesToday: number;
  merchantPurchasesToday: number;
  merchantPurchasesThisWeek: number;
  /**
   * Already-completed auto-purchase spend at this SAME merchant in the
   * trailing 24 hours, NOT including this one -- Filip's anti-splitting
   * rule ("a merchant's 24h sum reaching 500 NOK needs approval, no
   * splitting"). Required (not defaulted) so a caller cannot forget to wire
   * this counter and silently under-detect splitting, which is the one
   * failure direction this rule must never allow.
   */
  merchantSpendLast24hNok: number;
}

export type PurchaseCapKind =
  | "daily_amount"
  | "weekly_amount"
  | "daily_auto_purchase_count"
  | "merchant_daily"
  | "merchant_weekly"
  | "merchant_24h_splitting";

export interface EvaluatePurchaseCapsResult {
  requiresApproval: boolean;
  breachedCaps: PurchaseCapKind[];
}

/**
 * The spend/count caps, counted in NOK: 1,000/day, 2,500/week, 3 auto
 * purchases/day, 1 per merchant/day, 2 per merchant/week, plus the
 * anti-splitting rule (a merchant's trailing-24h sum reaching the 500 NOK
 * approval line needs approval even if each individual purchase was under
 * it). Pure given already-known counters -- collecting those counters from
 * finance events is step 6 (purchasing); this is just the rule of whether
 * adding one more purchase of `amountNok` would breach any of them.
 */
export function evaluatePurchaseCaps(input: PurchaseCapsInput): EvaluatePurchaseCapsResult {
  const breached: PurchaseCapKind[] = [];
  if (input.spendTodayNok + input.amountNok > PURCHASE_CAPS.dailyNok) breached.push("daily_amount");
  if (input.spendThisWeekNok + input.amountNok > PURCHASE_CAPS.weeklyNok) breached.push("weekly_amount");
  if (input.autoPurchasesToday + 1 > PURCHASE_CAPS.autoPurchasesPerDay) breached.push("daily_auto_purchase_count");
  if (input.merchant) {
    if (input.merchantPurchasesToday + 1 > PURCHASE_CAPS.perMerchantPerDay) breached.push("merchant_daily");
    if (input.merchantPurchasesThisWeek + 1 > PURCHASE_CAPS.perMerchantPerWeek) breached.push("merchant_weekly");
    // "Reaching" the threshold, i.e. >=, matches evaluatePurchaseAmount's own
    // at_or_above_threshold semantics -- the same line an unsplit purchase of
    // this size would already have needed approval for.
    if (input.merchantSpendLast24hNok + input.amountNok >= NOK_APPROVAL_THRESHOLD) {
      breached.push("merchant_24h_splitting");
    }
  }
  return { requiresApproval: breached.length > 0, breachedCaps: breached };
}

/**
 * Design section 5 / Filip's ruling: subscription/trial wording on a
 * checkout page always needs approval, regardless of the parsed amount --
 * a "free trial" today can auto-renew into a real charge later with no
 * further chance to catch it, so the auto-clear path must never see this
 * page as "just a small purchase". Checked against the same free text the
 * total parser reads (the accessibility snapshot tree), case-insensitive,
 * English/Norwegian/Danish/Swedish/German since the same fixture languages
 * apply here as `final-action-matcher.ts`'s wording lists.
 */
const SUBSCRIPTION_WORDING_RE =
  /\b(subscription|subscribe|recurring|auto-renew|auto renew|renews automatically|free trial|trial period|membership|abonnement|abonner|løpende avtale|prøveperiode|prøveabonnement|mitgliedschaft|testphase)\b/i;

export function containsSubscriptionOrTrialWording(text: string): boolean {
  return SUBSCRIPTION_WORDING_RE.test(text);
}

/**
 * The purchase analogue of `isAmountStillAcceptable` in browser-amount.ts
 * (the booking gate's coarse re-check), but built on the currency-aware
 * `ParsedTotal` from `pickTotal`/`evaluatePurchaseAmount` instead of a bare
 * currency token -- `confirm_final_step` for a purchase re-parses the total
 * with the SAME parser `request_purchase` used, not the booking gate's
 * looser one. Both null (unparseable both times, e.g. a page evaluated as
 * "needs approval" is being re-checked after the same unparseable text) is
 * fine; a mismatch in currency, or one present/other absent, or an increase,
 * is not verifiably safe and returns false.
 */
export function isPurchaseTotalStillAcceptable(atRequest: ParsedTotal | null, atConfirm: ParsedTotal | null): boolean {
  if (!atRequest && !atConfirm) return true;
  if (!atRequest || !atConfirm) return false;
  if (normalizeCurrencyCode(atRequest.currency) !== normalizeCurrencyCode(atConfirm.currency)) return false;
  return atConfirm.amount <= atRequest.amount;
}
