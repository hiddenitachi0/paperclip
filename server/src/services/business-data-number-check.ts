/**
 * DUR-3972 S4: the number check on a quick agent's reply.
 *
 * When `read_business_data` ran in a turn, EVERY number in the drafted reply
 * -- single digits included ("5 returer") -- must appear in that turn's
 * business-data tool output. Otherwise the reply is replaced by the answer
 * card itself. A wrong number is worse than no number.
 *
 * Before comparing, both sides are normalised the same way:
 *   - number formats in both languages: "1 234", "1.234", "1 234" and "1,234"
 *     are 1234; "12,5 %" and "12.5 %" are 12.5
 *   - a sign does not matter ("-3" and "down 3" are the same claim about 3)
 *   - lookup ids (UUIDs), shop addresses, dates, times and years next to a
 *     month name are not numbers about sales and are removed first
 *   - a day-and-month date ("31 July", "31. juli") is set aside in the REPLY
 *     only when the tool output names that same day, so "net 13 July:" or
 *     "netto 13. juli" cannot hide a wrong 13 behind a month name
 *   - the card's "No data" lines give no allowed numbers: "no data" must
 *     never make a "0" in the reply look grounded
 *   - number words ("five returns", "fem returer") are checked when they sit
 *     next to a count word, so a model cannot slip an invented figure past
 *     the check by spelling it out
 */

const MONTHS =
  "januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember|" +
  "jan|feb|mar|apr|jun|jul|aug|sep|sept|okt|nov|des|" +
  "january|february|march|may|june|july|october|december|oct|dec";

/**
 * Day-and-month dates as the card writes them ("1–31 July 2026") and as
 * Norwegian writes them ("1.–31. juli 2026"): the day is followed by a dot
 * or by a space, then a month name in either case.
 */
const MONTH_NAME = `(?:${MONTHS})`;
const DAY_MONTH_RANGE_RE = new RegExp(
  `\\b(\\d{1,2})\\.?\\s*[–-]\\s*(\\d{1,2})(?:\\.\\s*|\\s+)(${MONTH_NAME})\\b\\.?(?:\\s+\\d{4})?`,
  "gi",
);
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:\\.\\s*|\\s+)(${MONTH_NAME})\\b\\.?(?:\\s+\\d{4})?`, "gi");

function dayKey(day: string, month: string): string {
  return `${Number(day)}.${month.slice(0, 3).toLowerCase()}`;
}

/** Every "day. month" the text names, ranges expanded to both end days. */
export function knownDayMonthDates(text: string): Set<string> {
  const known = new Set<string>();
  const normalised = text.replace(/[\u00a0\u202f\u2009]/g, " ");
  for (const match of normalised.matchAll(DAY_MONTH_RANGE_RE)) {
    known.add(dayKey(match[1]!, match[3]!));
    known.add(dayKey(match[2]!, match[3]!));
  }
  for (const match of normalised.matchAll(DAY_MONTH_RE)) known.add(dayKey(match[1]!, match[2]!));
  return known;
}

const NUMBER_WORDS: Record<string, number> = {
  null: 0, ingen: 0, zero: 0, no: 0,
  to: 2, tre: 3, fire: 4, fem: 5, seks: 6, sju: 7, syv: 7, "åtte": 8, ni: 9, ti: 10, elleve: 11, tolv: 12,
  tretten: 13, fjorten: 14, femten: 15, seksten: 16, sytten: 17, atten: 18, nitten: 19, tjue: 20,
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

// A number word is only a claim when a count word follows within two words.
const COUNT_WORDS =
  "stk|stykker|enhet|enheter|retur|returer|returnert|returnerte|solgt|solgte|salg|ordre|ordrer|" +
  "produkt|produkter|varer|sofa|sofaer|" +
  "unit|units|item|items|return|returns|sold|sale|sales|order|orders|product|products|sofas|prosent|percent";

/**
 * Removes everything that carries digits but is not a claim about quantities.
 * With `knownDates`, a day-and-month date is only removed when every day in it
 * is one of those dates; otherwise its day number stays and is checked.
 */
function stripNonQuantities(text: string, knownDates?: Set<string>): string {
  const isKnown = (...keys: string[]) => !knownDates || keys.every((key) => knownDates.has(key));
  return (
    text
      .replace(/[   ]/g, " ")
      .replace(/−/g, "-")
      // lookup ids
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ")
      // shop addresses and other host names
      .replace(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:myshopify\.com|com|no|net|org)\b/gi, " ")
      // ISO timestamps and dates, month keys
      .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, " ")
      .replace(/\b\d{4}-\d{2}\b/g, " ")
      // 21.09.2026, 21.09
      .replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g, " ")
      // times 10:14
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
      // "1–31 July 2026", "31 July", "1.–31. juli 2026", "31. juli", "1.-31. aug."
      .replace(DAY_MONTH_RANGE_RE, (whole, from: string, to: string, month: string) =>
        isKnown(dayKey(from, month), dayKey(to, month)) ? " " : whole,
      )
      .replace(DAY_MONTH_RE, (whole, day: string, month: string) => (isKnown(dayKey(day, month)) ? " " : whole))
      // "July 2026", "juli 2026", "aug. 2025"
      .replace(new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{4}\\b`, "gi"), " ")
  );
}

function canonical(value: number): string {
  return String(Math.abs(Math.round(value * 1000) / 1000));
}

// Three shapes, tried in this order: Norwegian grouping ("1 234", "1.234",
// optionally ",5"), English grouping ("1,234", optionally ".5"), then a plain
// number with either decimal separator.
const NUMBER_PATTERN = "\\d{1,3}(?:(?: |\\.)\\d{3})+(?:,\\d+)?(?!\\d)|\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?(?![\\d,])|\\d+(?:[.,]\\d+)?";
const NUMBER_RE = new RegExp(NUMBER_PATTERN, "g");

function parseNumberToken(token: string): number | null {
  // Norwegian thousands grouping: "1 234" / "1.234" (groups of exactly three digits).
  if (/^\d{1,3}(?:(?: |\.)\d{3})+(?:,\d+)?$/.test(token)) {
    const [whole, fraction] = token.split(",");
    return Number(`${whole!.replace(/[ .]/g, "")}${fraction ? `.${fraction}` : ""}`);
  }
  // English thousands grouping: "1,234" / "1,234.5".
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(token)) {
    return Number(token.replace(/,/g, ""));
  }
  const value = Number(token.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/**
 * Every quantity in `text`, as canonical strings ("1234", "12.5", "5").
 * `knownDates`: see stripNonQuantities.
 */
export function extractQuantities(text: string, knownDates?: Set<string>): string[] {
  const cleaned = stripNonQuantities(text, knownDates);
  const found: string[] = [];
  for (const match of cleaned.matchAll(NUMBER_RE)) {
    const value = parseNumberToken(match[0]);
    if (value !== null) found.push(canonical(value));
  }
  const wordRe = new RegExp(
    `\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b(?=(?:\\s+[\\p{L}-]+)?\\s+(?:${COUNT_WORDS})\\b)`,
    "giu",
  );
  for (const match of cleaned.matchAll(wordRe)) {
    const value = NUMBER_WORDS[match[1]!.toLowerCase()];
    if (value !== undefined) found.push(canonical(value));
  }
  return found;
}

/** The quantities in `reply` that no business-data output of this turn contains. */
export function findUngroundedNumbers(reply: string, toolOutputs: string[]): string[] {
  // "No data" lines (the card's marker; "Ingen data" on older cards) state
  // that a period has NO numbers; nothing on them may ground a number in the
  // reply.
  const grounding = toolOutputs.map((output) =>
    output
      .split("\n")
      .filter((line) => !/^\s*(?:no data|ingen data)\b/i.test(line))
      .join("\n"),
  );
  const allowed = new Set(grounding.flatMap((output) => extractQuantities(output)));
  const knownDates = new Set(toolOutputs.flatMap((output) => [...knownDayMonthDates(output)]));
  const missing: string[] = [];
  for (const value of extractQuantities(reply, knownDates)) {
    if (!allowed.has(value) && !missing.includes(value)) missing.push(value);
  }
  return missing;
}

export const NUMBER_CHECK_REPLACEMENT_NOTE = "(The figures come straight from the data source.)";
/** When a lookup was asked for but nothing came back to relay (e.g. the per-message tool cap). */
export const NO_NUMBERS_SENTENCE = "I could not fetch figures from the data source for this question, so I am not giving any figures. Please ask again.";

export interface BusinessDataTurnOutput {
  /** Exactly what the model was shown. */
  content: string;
  /** The platform footer for a successful lookup (units, periods, source, lookup id). */
  footer: string | null;
  lookupId: string | null;
}

export interface NumberCheckResult {
  text: string;
  replaced: boolean;
  ungrounded: string[];
  footerAdded: boolean;
}

/**
 * The check plus the footer. Runs only when business data was read in this
 * turn. A reply that fails is replaced by the tool output itself (the fixed
 * cards, which already state period, units and source); a reply that passes
 * gets the platform footer appended for each successful lookup it does not
 * already carry, so period, source and "units" are always stated.
 */
export function applyBusinessDataNumberCheck(reply: string, outputs: BusinessDataTurnOutput[]): NumberCheckResult {
  if (outputs.length === 0) return { text: reply, replaced: false, ungrounded: [], footerAdded: false };
  const ungrounded = findUngroundedNumbers(reply, outputs.map((output) => output.content));
  if (ungrounded.length > 0 || reply.trim().length === 0) {
    const cards = outputs.map((output) => output.content.trim()).filter(Boolean);
    if (cards.length === 0) {
      return { text: NO_NUMBERS_SENTENCE, replaced: true, ungrounded, footerAdded: false };
    }
    return {
      text: `${cards.join("\n\n")}\n\n${NUMBER_CHECK_REPLACEMENT_NOTE}`,
      replaced: true,
      ungrounded,
      footerAdded: false,
    };
  }
  let text = reply.trimEnd();
  let footerAdded = false;
  for (const output of outputs) {
    if (!output.footer || !output.lookupId) continue;
    // The card relayed word for word already states all of it.
    if (text.includes(output.content.trim())) continue;
    const missing = output.footer.split("\n").filter((line) => line.trim() && !text.includes(line.trim()));
    if (missing.length === 0) continue;
    text = `${text}\n\n${missing.join("\n")}`;
    footerAdded = true;
  }
  return { text, replaced: false, ungrounded: [], footerAdded };
}

/** Sent instead of a reply that states sales figures without a lookup in this turn. */
export const NO_LOOKUP_SENTENCE =
  "I have not fetched the figures afresh for this answer, so I am not giving any figures here. " +
  "Ask me for the figures again and I will look them up in the data source.";

// Words that make a nearby number a claim about sales, for the no-lookup guard.
const SALES_WORDS = `${COUNT_WORDS}|netto|net|totalt|total|sum|returnerte|endring`;

/**
 * The quantities in `reply` that sit next to a sales word ("27 stk",
 * "netto 13", "totalt: 27", "fem returer"). Dates, ids and addresses are
 * set aside first, exactly as in the main check.
 */
export function findSalesQuantityClaims(reply: string): string[] {
  const cleaned = stripNonQuantities(reply);
  const digits = `(?:${NUMBER_PATTERN})`;
  const number = `(?:${digits}|${Object.keys(NUMBER_WORDS).join("|")})`;
  // Spelled-out numbers only count BEFORE a sales word ("fem returer"):
  // after one, "to" is as often the English preposition as the number two.
  const after = new RegExp(`(?<![\\p{L}\\d])[+-]?(${number})(?![\\p{L}\\d])(?=\\s*%|(?:\\s+[\\p{L}-]+)?\\s+(?:${SALES_WORDS})(?![\\p{L}]))`, "giu");
  const before = new RegExp(`(?<![\\p{L}])(?:${SALES_WORDS})(?![\\p{L}])\\s*:?\\s*(?:på\\s+|of\\s+|var\\s+|was\\s+)?[+-]?(${digits})(?![\\p{L}\\d])`, "giu");
  const found: string[] = [];
  for (const re of [after, before]) {
    for (const match of cleaned.matchAll(re)) {
      const token = match[1]!;
      const word = NUMBER_WORDS[token.toLowerCase()];
      const value = word !== undefined ? word : parseNumberToken(token);
      if (value === null) continue;
      const key = canonical(value);
      if (!found.includes(key)) found.push(key);
    }
  }
  return found;
}

export interface NoLookupGuardResult {
  text: string;
  replaced: boolean;
  claims: string[];
}

/**
 * The guard for a turn where the sales tool was offered, or earlier turns in
 * the conversation read business data, but NO lookup ran this turn. Such a
 * reply may only repeat what the model remembers, or its own arithmetic on
 * it, and nothing can check that. Any sales figure in it is replaced by a
 * plain sentence asking the person to have the figures looked up again.
 */
export function applyNoLookupGuard(reply: string): NoLookupGuardResult {
  const claims = findSalesQuantityClaims(reply);
  if (claims.length === 0) return { text: reply, replaced: false, claims };
  return { text: NO_LOOKUP_SENTENCE, replaced: true, claims };
}
