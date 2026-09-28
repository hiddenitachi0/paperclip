/**
 * DUR-4013: payment-field and card-number detection for `browser_type`. Two
 * independent refusal signals, per the design: "refuses 13-19-digit Luhn
 * runs and payment fields" -- either one alone is enough to refuse the type
 * action. Neither depends on the other, because a card number can be typed
 * into a field that does not look like a card field (a mislabeled form), and
 * a field that looks like a card field can be about to receive something
 * that is not yet a full valid number (typed one keystroke at a time -- the
 * caller decides whether it checks the whole string or the field kind, this
 * module only answers "is this risky" for whatever text/field it is given).
 */

/**
 * Standard Luhn checksum, used to tell an actual card-number-shaped digit
 * run apart from an ordinary long number (an order id, a phone number).
 */
export function isLuhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/**
 * Finds every 13-19 digit run in `text` that passes the Luhn check, after
 * stripping the spaces/dashes a person normally types a card number with
 * (so "4242 4242 4242 4242" and "4242-4242-4242-4242" are both caught, not
 * just an unspaced run). Returns the matched digit runs (digits only), not
 * their positions -- callers only need to know whether any exist.
 */
export function findLuhnValidRuns(text: string): string[] {
  const found: string[] = [];
  // A "card-number-shaped" token: digits with optional single spaces/dashes
  // between groups, so we do not merge two unrelated numbers that happen to
  // sit next to each other in free text.
  const tokenPattern = /\d(?:[\s-]?\d){11,18}/g;
  for (const match of text.matchAll(tokenPattern)) {
    const digitsOnly = match[0].replace(/[\s-]/g, "");
    if (digitsOnly.length >= 13 && digitsOnly.length <= 19 && isLuhnValid(digitsOnly)) {
      found.push(digitsOnly);
    }
  }
  return found;
}

export function containsCardNumber(text: string): boolean {
  return findLuhnValidRuns(text).length > 0;
}

export interface PaymentFieldSignals {
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
  type?: string | null;
  placeholder?: string | null;
  /** The accessible label/name Playwright resolves for the field. */
  label?: string | null;
}

/**
 * Autocomplete tokens the HTML spec defines for payment fields (the primary,
 * most reliable signal -- a well-built checkout sets these). See
 * https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill-field-name
 */
const PAYMENT_AUTOCOMPLETE_TOKENS = new Set([
  "cc-name",
  "cc-given-name",
  "cc-additional-name",
  "cc-family-name",
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-type",
]);

/**
 * Fallback keyword heuristics for forms that do not set autocomplete
 * correctly (common in the wild). Matched against name/id/placeholder/label,
 * case-insensitively, as substrings -- false positives here just mean an
 * extra refusal an agent has to explain, which is the safe direction to
 * err in; false negatives mean a card leaks, which is not acceptable.
 */
const PAYMENT_KEYWORD_PATTERNS = [
  /card[\s_-]?number/i,
  /cardnumber/i,
  /\bcvv\b/i,
  /\bcvc\b/i,
  /\bcvv2\b/i,
  /security[\s_-]?code/i,
  /card[\s_-]?holder/i,
  /expir(y|ation)/i,
  /\bexp[\s_-]?(date|month|year|mm|yy)\b/i,
  /\bpan\b/i,
];

function normalizeSignal(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

/**
 * True when any of the given field metadata suggests this is a card-payment
 * field (number, CVC/CVV, expiry, cardholder name), so `browser_type` and
 * `browser_click`/autofill should refuse anything but a server-side fill
 * bound to a live clearance.
 */
export function looksLikePaymentField(signals: PaymentFieldSignals): boolean {
  const autocomplete = normalizeSignal(signals.autocomplete);
  if (autocomplete) {
    for (const token of autocomplete.split(/\s+/)) {
      if (PAYMENT_AUTOCOMPLETE_TOKENS.has(token)) return true;
    }
  }
  const haystacks = [signals.name, signals.id, signals.placeholder, signals.label]
    .map(normalizeSignal)
    .filter(Boolean);
  for (const haystack of haystacks) {
    for (const pattern of PAYMENT_KEYWORD_PATTERNS) {
      if (pattern.test(haystack)) return true;
    }
  }
  return false;
}

export type TypeRefusalReason = "card_number_in_text" | "payment_field";

export interface TypeRefusal {
  readonly reason: TypeRefusalReason;
  readonly message: string;
}

/**
 * The one function `browser_type` calls: refuses when the text being typed
 * contains a Luhn-valid card number, or when the target field looks like a
 * payment field, whichever fires first.
 */
export function evaluateTypeSafety(text: string, field: PaymentFieldSignals): TypeRefusal | null {
  if (containsCardNumber(text)) {
    return {
      reason: "card_number_in_text",
      message: "That text contains what looks like a card number. Card numbers are never typed directly -- use fill_payment_details with a live clearance instead.",
    };
  }
  if (looksLikePaymentField(field)) {
    return {
      reason: "payment_field",
      message: "This field looks like a payment field. Payment fields are only filled by fill_payment_details with a live clearance, never typed into directly.",
    };
  }
  return null;
}
