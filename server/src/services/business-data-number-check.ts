/**
 * DUR-3972 S4: the number check on a quick agent's reply.
 *
 * When `read_business_data` ran in a turn, EVERY number in the drafted reply
 * -- single digits included ("5 returer") -- must appear in that turn's
 * business-data tool output. Otherwise the reply is replaced by the answer
 * card itself. A wrong number is worse than no number.
 *
 * Before comparing, both sides are normalised the same way:
 *   - Norwegian formats: "1 234", "1.234" and "1 234" are 1234; "12,5 %" is 12.5
 *   - a sign does not matter ("-3" and "ned 3" are the same claim about 3)
 *   - lookup ids (UUIDs), shop addresses, dates, times and years next to a
 *     month name are not numbers about sales and are removed first
 *   - number words ("fem returer") are checked when they sit next to a count
 *     word, so a model cannot slip an invented figure past the check by
 *     spelling it out
 */

const MONTHS =
  "januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember|" +
  "jan|feb|mar|apr|jun|jul|aug|sep|sept|okt|nov|des|" +
  "january|february|march|may|june|july|october|december|oct|dec";

const NUMBER_WORDS: Record<string, number> = {
  to: 2, tre: 3, fire: 4, fem: 5, seks: 6, sju: 7, syv: 7, "åtte": 8, ni: 9, ti: 10, elleve: 11, tolv: 12,
  tretten: 13, fjorten: 14, femten: 15, seksten: 16, sytten: 17, atten: 18, nitten: 19, tjue: 20,
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

// A number word is only a claim when a count word follows within two words.
const COUNT_WORDS =
  "stk|stykker|enhet|enheter|retur|returer|returnert|returnerte|solgt|solgte|salg|ordre|ordrer|" +
  "produkt|produkter|varer|sofa|sofaer|units|items|returns|sold|orders|prosent|percent";

/** Removes everything that carries digits but is not a claim about quantities. */
function stripNonQuantities(text: string): string {
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
      // "1.–31. juli 2026", "31. juli", "1.-31. aug."
      .replace(new RegExp(`\\b\\d{1,2}\\.?\\s*[–-]\\s*\\d{1,2}\\.\\s*(?:${MONTHS})\\b\\.?(?:\\s+\\d{4})?`, "gi"), " ")
      .replace(new RegExp(`\\b\\d{1,2}\\.\\s*(?:${MONTHS})\\b\\.?(?:\\s+\\d{4})?`, "gi"), " ")
      // "juli 2026", "aug. 2025"
      .replace(new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{4}\\b`, "gi"), " ")
  );
}

function canonical(value: number): string {
  return String(Math.abs(Math.round(value * 1000) / 1000));
}

const NUMBER_RE = /\d{1,3}(?:(?: |\.)\d{3})+(?:,\d+)?(?!\d)|\d+(?:[.,]\d+)?/g;

function parseNumberToken(token: string): number | null {
  // Thousands grouping: "1 234" / "1.234" (groups of exactly three digits).
  if (/^\d{1,3}(?:(?: |\.)\d{3})+(?:,\d+)?$/.test(token)) {
    const [whole, fraction] = token.split(",");
    return Number(`${whole!.replace(/[ .]/g, "")}${fraction ? `.${fraction}` : ""}`);
  }
  const value = Number(token.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/** Every quantity in `text`, as canonical strings ("1234", "12.5", "5"). */
export function extractQuantities(text: string): string[] {
  const cleaned = stripNonQuantities(text);
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
  const allowed = new Set(toolOutputs.flatMap((output) => extractQuantities(output)));
  const missing: string[] = [];
  for (const value of extractQuantities(reply)) {
    if (!allowed.has(value) && !missing.includes(value)) missing.push(value);
  }
  return missing;
}

export const NUMBER_CHECK_REPLACEMENT_NOTE = "(Tallene er hentet direkte fra datakilden.)";
/** When a lookup was asked for but nothing came back to relay (e.g. the per-message tool cap). */
export const NO_NUMBERS_SENTENCE = "Jeg fikk ikke hentet tall fra datakilden for dette spørsmålet, så jeg gir ingen tall. Spør gjerne igjen.";

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
