/**
 * Security fix (DUR-4045 review of DUR-4037): a coarse, self-contained
 * "did the visible price on this page get worse" check for the booking
 * gate. This is deliberately not the full currency-threshold parser from
 * design section 5 (packages/shared/src/payments/threshold.ts, phase 6,
 * not built yet) -- it does no FX conversion and does not decide auto-clear
 * vs. approval (every booking always goes to Filip regardless). Its only
 * job is comparing the same page's snapshot text at request_booking time
 * against confirm_final_step time so a merchant cannot swap in a higher
 * price (or a price where none was shown) between Filip's approval and the
 * agent's click without the gate refusing and asking for a fresh
 * request_booking.
 */

export interface ParsedPageAmount {
  /** Amount in minor units (e.g. øre/cents), rounded to the nearest whole unit. */
  valueMinor: number;
  /** The matched currency token, lowercased, compared literally (not normalized to an ISO code -- a token change between the two reads is itself treated as suspicious). */
  currencyToken: string;
}

const CURRENCY_TOKEN = "(?:kr|nok|eur|usd|gbp|sek|dkk|\\$|€|£)";
const NUMBER = "(?:\\d{1,3}(?:[\\s.,\\u00a0\\u2009]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
const AMOUNT_PATTERN = new RegExp(`(${CURRENCY_TOKEN})\\s?(${NUMBER})|(${NUMBER})\\s?(${CURRENCY_TOKEN})`, "gi");

function toMinorUnits(numberText: string): number | null {
  const trimmed = numberText.trim();
  const decimalMatch = trimmed.match(/[.,](\d{1,2})$/);
  let integerPart: string;
  let fractionPart: string;
  if (decimalMatch) {
    fractionPart = decimalMatch[1].padEnd(2, "0");
    integerPart = trimmed.slice(0, trimmed.length - decimalMatch[0].length);
  } else {
    fractionPart = "00";
    integerPart = trimmed;
  }
  const digitsOnly = integerPart.replace(/\D/g, "");
  if (!digitsOnly) return null;
  const value = Number(digitsOnly) * 100 + Number(fractionPart);
  return Number.isFinite(value) ? value : null;
}

/**
 * Scans free text (the accessibility snapshot tree) for currency-tagged
 * amounts and returns the largest one found, per the design's "several
 * candidates -> largest labelled total" heuristic -- or null when no
 * currency-tagged amount is found at all (an ordinary free booking page).
 */
export function parseLargestPageAmount(text: string): ParsedPageAmount | null {
  let best: ParsedPageAmount | null = null;
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const currencyToken = (match[1] ?? match[4] ?? "").toLowerCase();
    const numberText = match[2] ?? match[3];
    if (!currencyToken || !numberText) continue;
    const valueMinor = toMinorUnits(numberText);
    if (valueMinor === null) continue;
    if (!best || valueMinor > best.valueMinor) {
      best = { valueMinor, currencyToken };
    }
  }
  return best;
}

/**
 * Whether it is safe to proceed given what Filip's approval screen showed
 * (`atRequest`) versus what the page shows right now (`atConfirm`): both
 * absent (free both times) is fine, and the same currency token at an equal
 * or lower amount is fine. Anything else -- a price appeared where there
 * was none, a price disappeared where there was one, or the currency token
 * changed, or the amount increased -- is not verifiably safe and returns
 * false so the caller refuses and asks for a fresh request_booking.
 */
export function isAmountStillAcceptable(atRequest: ParsedPageAmount | null, atConfirm: ParsedPageAmount | null): boolean {
  if (!atRequest && !atConfirm) return true;
  if (!atRequest || !atConfirm) return false;
  if (atRequest.currencyToken !== atConfirm.currencyToken) return false;
  return atConfirm.valueMinor <= atRequest.valueMinor;
}
