// DUR-4466: client-side text masking for presentation mode. Nothing here ever
// reads from or writes to the network — it operates purely on strings already
// present in the rendered UI. Inspired by the masking patterns in Nate Herk's
// "Recording Mode" Claude Code mod (MIT) — adapted and reimplemented for
// Paperclip's own component model rather than copied.

export const MASK_TOKEN = "•••";

export interface PresentationMaskOptions {
  /** Names that must never be masked even if they'd otherwise match. */
  keepList?: string[];
  /** Additional display names to treat as sensitive and mask. */
  extraMaskedNames?: string[];
  /** "strict" also masks every large number and percentage, not just money/business figures. */
  strict?: boolean;
}

const BUSINESS_WORDS =
  "revenue|margin|payroll|budget|cost|costs|spend|spending|salary|salaries|profit|income|price|pricing|fee|fees|invoice|expense|expenses";

// Currency symbols/codes that make a number unambiguously a money amount.
const CURRENCY_UNIT = "kr|nok|usd|eur|gbp|chf|sek|dkk|\\$|€|£";

// A numeric amount: digit groups separated by "," "." or spaces (covers both
// en thousands-comma/decimal-dot and nb-NO thousands-dot-or-space/decimal-comma),
// with an optional decimal tail.
const AMOUNT = "-?\\d+(?:[.,\\s]\\d{3})*(?:[.,]\\d{1,2})?";

// Amount with a currency unit directly before or after it (with optional space).
const CURRENCY_AMOUNT_RE = new RegExp(
  `(?:(?:${CURRENCY_UNIT})\\s?${AMOUNT})|(?:${AMOUNT}\\s?(?:${CURRENCY_UNIT}))`,
  "gi",
);

// A percentage, e.g. "45%", "45 %", "12,5%".
const PERCENTAGE_RE = new RegExp(`${AMOUNT}\\s?%`, "gi");

// An amount preceded within a short window by a business word, e.g.
// "revenue: 1 234 567" or "Payroll 84000".
const BUSINESS_AMOUNT_RE = new RegExp(
  `\\b(?:${BUSINESS_WORDS})\\b[^\\d\\n]{0,24}(${AMOUNT})`,
  "gi",
);

// Any standalone number of 3+ significant digits — only used in strict mode.
const STRICT_LARGE_NUMBER_RE = new RegExp(`\\b${AMOUNT}\\b`, "g");

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Phone numbers: optional leading +, groups of digits separated by spaces,
// dashes, dots or parens, at least 7 digits total. Deliberately permissive
// to catch NO ("+47 912 34 567", "91234567") and generic international forms.
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,5}\d{2,4}/g;

// Street addresses: a heuristic for "<digits/word> <street-ish word>" patterns
// in common English and Norwegian forms, e.g. "221B Baker Street",
// "Storgata 12", "123 Main St". Deliberately narrow to avoid false positives.
const ADDRESS_RE =
  /\b\d{1,5}[A-Za-z]?\s+[A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*)?\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Way|Plass|Vei|Veien|Gate|Gata)\b|\b[A-ZÆØÅ][\p{L}]*(?:gate|gata|veien|vei|plass)\s+\d{1,4}[A-Za-z]?\b/gu;

// Key/token-looking strings: common provider prefixes (sk-, ghp_, AIza...) or
// long opaque alphanumeric runs (>=20 chars, mixed case/digits) typical of API
// keys, JWTs and hashes.
const KEY_TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b|\b[A-Za-z0-9_-]{20,}\b/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskAllMatches(text: string, regex: RegExp): string {
  return text.replace(regex, MASK_TOKEN);
}

export function maskEmails(text: string): string {
  return maskAllMatches(text, EMAIL_RE);
}

export function maskPhones(text: string): string {
  return text.replace(PHONE_RE, (match) => {
    const digitCount = (match.match(/\d/g) ?? []).length;
    if (digitCount < 7) return match; // avoid masking short unrelated numbers
    return MASK_TOKEN;
  });
}

export function maskAddresses(text: string): string {
  return maskAllMatches(text, ADDRESS_RE);
}

export function maskKeysAndTokens(text: string): string {
  return maskAllMatches(text, KEY_TOKEN_RE);
}

export function maskMoney(text: string, { strict = false }: { strict?: boolean } = {}): string {
  let result = text.replace(CURRENCY_AMOUNT_RE, MASK_TOKEN);
  result = result.replace(PERCENTAGE_RE, MASK_TOKEN);
  result = result.replace(BUSINESS_AMOUNT_RE, (match, amount: string) => match.replace(amount, MASK_TOKEN));
  if (strict) {
    result = result.replace(STRICT_LARGE_NUMBER_RE, (match) => {
      const digits = match.replace(/[^\d]/g, "");
      return digits.length >= 3 ? MASK_TOKEN : match;
    });
  }
  return result;
}

/**
 * Masks occurrences of known sensitive names (default masked names plus any
 * operator-configured `extraMaskedNames`), skipping anything on `keepList`.
 * Matching is whole-word, case-insensitive, and keepList always wins over
 * extraMaskedNames for the same name.
 */
export function maskNames(
  text: string,
  { names, keepList = [] }: { names: string[]; keepList?: string[] },
): string {
  const keepSet = new Set(keepList.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const toMask = names.map((n) => n.trim()).filter((n) => n && !keepSet.has(n.toLowerCase()));
  if (toMask.length === 0) return text;

  // Longest names first so "John Smith" is masked before a lone "John" would be.
  const sorted = [...toMask].sort((a, b) => b.length - a.length);
  let result = text;
  for (const name of sorted) {
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi");
    result = result.replace(re, MASK_TOKEN);
  }
  return result;
}

/**
 * Applies the full presentation-mode mask pipeline to a single string.
 * Order matters: keys/emails/phones/addresses are structurally distinctive
 * and safe to mask first; money is next; names last since they're the most
 * permissive patterns.
 */
export function maskText(text: string, options: PresentationMaskOptions = {}): string {
  if (!text) return text;
  let result = text;
  result = maskKeysAndTokens(result);
  result = maskEmails(result);
  result = maskPhones(result);
  result = maskAddresses(result);
  result = maskMoney(result, { strict: options.strict });
  if (options.extraMaskedNames?.length) {
    result = maskNames(result, { names: options.extraMaskedNames, keepList: options.keepList });
  }
  return result;
}
