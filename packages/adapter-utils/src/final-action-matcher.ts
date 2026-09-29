/**
 * DUR-4013: the final-button refusal matrix. A soft backstop for free
 * bookings (the hard backstop for money is the server-side clearance gate in
 * step 4 plus the network hold in the egress proxy). `browser_click` and
 * `browser_press_key` (Enter inside a form) run every generic interaction
 * through this before letting it through, so a page cannot walk the agent
 * through "book"/"pay"/"confirm" without the server ever seeing a
 * `request_booking`/`request_purchase` call.
 *
 * Multilingual wordlist per the design doc: NO/SV/DA/EN/DE. Matched as whole
 * words/phrases against normalized (lowercased, whitespace-collapsed) text,
 * not substrings -- "bok" must not match inside an unrelated word.
 */

export type FinalActionLanguage = "no" | "sv" | "da" | "en" | "de";

export interface FinalActionTerm {
  readonly phrase: string;
  readonly language: FinalActionLanguage;
}

/**
 * Each phrase is matched as a whole-word sequence (word-boundary on both
 * ends), so multi-word phrases like "place order" require the exact word
 * sequence but tolerate any whitespace between the words.
 */
export const FINAL_ACTION_TERMS: readonly FinalActionTerm[] = [
  // Norwegian
  { phrase: "bekreft", language: "no" },
  { phrase: "bekreft bestilling", language: "no" },
  { phrase: "bestill", language: "no" },
  { phrase: "bestill na", language: "no" },
  { phrase: "betal", language: "no" },
  { phrase: "betal na", language: "no" },
  { phrase: "kjop", language: "no" },
  { phrase: "kjop na", language: "no" },
  { phrase: "fullfor", language: "no" },
  { phrase: "fullfor bestilling", language: "no" },
  { phrase: "fullfor kjop", language: "no" },
  { phrase: "reserver", language: "no" },
  { phrase: "godkjenn", language: "no" },
  { phrase: "send bestilling", language: "no" },
  { phrase: "legg inn bestilling", language: "no" },
  // Swedish
  { phrase: "bekrafta", language: "sv" },
  { phrase: "boka", language: "sv" },
  { phrase: "bestall", language: "sv" },
  { phrase: "betala", language: "sv" },
  { phrase: "betala nu", language: "sv" },
  { phrase: "kop", language: "sv" },
  { phrase: "kop nu", language: "sv" },
  { phrase: "slutfor", language: "sv" },
  { phrase: "slutfor kopet", language: "sv" },
  { phrase: "reservera", language: "sv" },
  { phrase: "godkann", language: "sv" },
  // Danish
  { phrase: "bekraeft", language: "da" },
  { phrase: "bestil", language: "da" },
  { phrase: "bestil nu", language: "da" },
  { phrase: "betal", language: "da" },
  { phrase: "koeb", language: "da" },
  { phrase: "koeb nu", language: "da" },
  { phrase: "fuldfoer", language: "da" },
  { phrase: "fuldfoer bestilling", language: "da" },
  { phrase: "reserver", language: "da" },
  { phrase: "godkend", language: "da" },
  // English
  { phrase: "confirm", language: "en" },
  { phrase: "confirm booking", language: "en" },
  { phrase: "confirm order", language: "en" },
  { phrase: "confirm and pay", language: "en" },
  { phrase: "book", language: "en" },
  { phrase: "book now", language: "en" },
  { phrase: "pay", language: "en" },
  { phrase: "pay now", language: "en" },
  { phrase: "buy", language: "en" },
  { phrase: "buy now", language: "en" },
  { phrase: "purchase", language: "en" },
  { phrase: "place order", language: "en" },
  { phrase: "submit order", language: "en" },
  { phrase: "checkout", language: "en" },
  { phrase: "check out", language: "en" },
  { phrase: "complete order", language: "en" },
  { phrase: "complete purchase", language: "en" },
  { phrase: "complete booking", language: "en" },
  { phrase: "finish booking", language: "en" },
  { phrase: "reserve", language: "en" },
  { phrase: "approve", language: "en" },
  { phrase: "pay invoice", language: "en" },
  { phrase: "pay by invoice", language: "en" },
  // German
  { phrase: "bestatigen", language: "de" },
  { phrase: "bestellung bestatigen", language: "de" },
  { phrase: "buchen", language: "de" },
  { phrase: "jetzt buchen", language: "de" },
  { phrase: "bezahlen", language: "de" },
  { phrase: "jetzt bezahlen", language: "de" },
  { phrase: "kaufen", language: "de" },
  { phrase: "jetzt kaufen", language: "de" },
  { phrase: "abschliessen", language: "de" },
  { phrase: "bestellung abschliessen", language: "de" },
  { phrase: "reservieren", language: "de" },
  { phrase: "bestellen", language: "de" },
  { phrase: "jetzt bestellen", language: "de" },
];

/**
 * Invoice / "pay later" wording counts as final too (design: "'Faktura'/
 * invoice options count as final"), even though it does not charge a card
 * immediately -- it still creates a binding obligation the agent must not
 * incur without a clearance.
 */
export const INVOICE_TERMS: readonly FinalActionTerm[] = [
  { phrase: "faktura", language: "no" },
  { phrase: "betal senere", language: "no" },
  { phrase: "faktura", language: "sv" },
  { phrase: "faktura", language: "da" },
  { phrase: "invoice", language: "en" },
  { phrase: "invoice me", language: "en" },
  { phrase: "pay later", language: "en" },
  { phrase: "buy now pay later", language: "en" },
  { phrase: "rechnung", language: "de" },
  { phrase: "auf rechnung", language: "de" },
];

// Invoice terms checked first: "pay later" must classify as invoice, not as
// a bare match of the shorter final-action term "pay" it contains.
const ALL_TERMS: readonly FinalActionTerm[] = [...INVOICE_TERMS, ...FINAL_ACTION_TERMS];

/**
 * Strip diacritics (æ/ø/å/ä/ö/ü/ß-adjacent letters etc.) so a page's actual
 * rendered text ("Bekreft kjøp") matches our ASCII wordlist entries
 * ("bekreft kjop") without hand-duplicating every accented form.
 */
function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks
    .replace(/[øØ]/g, "o")
    .replace(/[æÆ]/g, "ae")
    .replace(/[åÅ]/g, "a")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface FinalActionMatch {
  readonly term: FinalActionTerm;
  readonly kind: "final_action" | "invoice";
}

/**
 * Whole-word/phrase match against the wordlist. Returns the first match
 * (there is no need to enumerate every match -- one is enough to refuse).
 */
export function matchFinalActionWording(text: string): FinalActionMatch | null {
  const normalized = normalize(text);
  if (!normalized) return null;
  for (const term of ALL_TERMS) {
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term.phrase)}(?:$|[^a-z0-9])`, "i");
    if (pattern.test(` ${normalized} `)) {
      return {
        term,
        kind: INVOICE_TERMS.includes(term) ? "invoice" : "final_action",
      };
    }
  }
  return null;
}

export type FinalActionRefusalReason =
  | "final_action_wording"
  | "invoice_wording"
  | "submit_in_payment_form";

export interface FinalActionRefusal {
  readonly reason: FinalActionRefusalReason;
  readonly match?: FinalActionMatch;
  readonly message: string;
}

export interface EvaluateFinalActionInput {
  /** Visible text / accessible name of the clicked element, or of the Enter target. */
  text?: string;
  /** True when this is a form submit (button[type=submit], or Enter inside a form). */
  isFormSubmit?: boolean;
  /** True when the enclosing form contains a field that looks like a payment field. */
  formHasPaymentField?: boolean;
}

/**
 * The one function `browser_click` and `browser_press_key` (Enter) both call.
 * Refuses on wording (final-action or invoice terms) OR on a bare submit
 * button inside a form that has a payment field, even when its label is
 * generic ("Next", "Continue") -- the design's residual-risk note is about
 * a mislabeled *booking* button, not about a card-form submit with no
 * recognizable label at all, which this second check catches independently
 * of wording.
 */
export function evaluateFinalActionRisk(input: EvaluateFinalActionInput): FinalActionRefusal | null {
  const match = input.text ? matchFinalActionWording(input.text) : null;
  if (match) {
    return {
      reason: match.kind === "invoice" ? "invoice_wording" : "final_action_wording",
      match,
      message:
        match.kind === "invoice"
          ? `"${input.text}" reads as an invoice / pay-later option. That is a final step and needs request_booking or request_purchase first.`
          : `"${input.text}" reads as a final action (${match.term.language}: "${match.term.phrase}"). That needs request_booking or request_purchase first.`,
    };
  }
  if (input.isFormSubmit && input.formHasPaymentField) {
    return {
      reason: "submit_in_payment_form",
      message: "This submits a form with a payment field. That needs request_purchase and a live clearance first.",
    };
  }
  return null;
}
