/**
 * DUR-4046 (Maja browser step 6): two small, self-contained helpers for the
 * purchase gate that do not belong on browser-service.ts's own state:
 *
 *  - `classifyPurchaseOutcome`: the design's "fake confirmation pages"
 *    mitigation ("success only on provider response or redirect to a
 *    confirmation URL on the cleared domain with an order reference, else
 *    unverified"). This architecture's `BrowserDriver` has no network-response
 *    capture yet (the real worker/Playwright driver is not built -- see
 *    browser-service.ts's own module docstring), so "the payment provider's
 *    response" is read from the page the provider redirects back to: the
 *    URL/text the browser lands on after `confirm_final_step`, checked for a
 *    same-domain (or known-provider) confirmation shape with an order
 *    reference, never trusted from the agent's own claim. An honest
 *    "unverified" beats a false "confirmed" -- the failure direction that
 *    must never happen is marking a card `used` (unavailable for retry) for
 *    a purchase Filip cannot actually confirm happened.
 *  - `maskCardNumbers`: DUR-4044's canary-card requirement ("card number
 *    never in logs/responses/transcripts") applies just as much to step 6's
 *    new gated-tool responses (`fill_payment_details`, `confirm_final_step`,
 *    `wait_for_outcome`) as it did to the plain tools -- any snapshot/text
 *    handed back to the agent after a card fill is scrubbed of Luhn-valid
 *    digit runs first. DUR-4049 (residual from the DUR-4047 re-review):
 *    the PAN regex never matches a CVC (3-4 digits) or plain-text expiry/
 *    cardholder name, so an optional `extraLiterals` list of the exact
 *    values just typed into the page is blanked first, on a word boundary
 *    so a short numeric literal (a CVC) doesn't eat digits out of an
 *    unrelated larger number.
 */
import { isLuhnValid } from "@paperclipai/adapter-utils/payment-detection";
import { registrableDomain } from "./browser-domain.js";

/** Same card-number-shaped token pattern as findLuhnValidRuns in payment-detection.ts (that module only exposes the digits-only match, not the original substring this needs to redact in place). */
const CARD_NUMBER_TOKEN_RE = /\d(?:[\s-]?\d){11,18}/g;

const ORDER_REFERENCE_RE = /\b(order|ordre|bestilling|confirmation|bekreftelse|kvittering|receipt|reference|ref)[\s:#-]*[a-z0-9_-]{4,}/i;
const FAILURE_WORDING_RE = /\b(declined|decline|failed|failure|error|avslått|feilet|mislyktes|nektet)\b/i;

export type PurchaseOutcome = "confirmed" | "failed" | "unverified";

/**
 * Known payment-provider hosts a redirect back through is expected to land
 * on rather than the merchant's own domain (Stripe Checkout, Adyen, Nets
 * Easy, Vipps, Klarna) -- a confirmation page on one of these still counts
 * as "the provider's response" even though it is not the cleared merchant
 * domain itself.
 */
const KNOWN_PROVIDER_DOMAINS = [
  "stripe.com",
  "checkout.stripe.com",
  "adyen.com",
  "adyenpayments.com",
  "nets.eu",
  "nexigroup.com",
  "vipps.no",
  "klarna.com",
  "checkout.com",
  "braintreegateway.com",
  "paypal.com",
];

function isClearedOrKnownProviderDomain(domain: string | null, clearedDomain: string): boolean {
  if (!domain) return false;
  if (domain === clearedDomain) return true;
  return KNOWN_PROVIDER_DOMAINS.some((provider) => domain === provider || domain.endsWith(`.${provider}`));
}

/**
 * Classifies the page the browser is on after `confirm_final_step` armed
 * the network hold. Never returns "confirmed" from page text alone without
 * also being on the cleared merchant's domain (or a known provider domain)
 * -- an attacker page anywhere else claiming success is not proof of
 * anything. Returns "failed" only on an explicit failure-wording match, so a
 * merely-still-loading page reads as "unverified" (safe direction), not a
 * false failure that would prematurely free a card that may already be
 * charged.
 */
export function classifyPurchaseOutcome(input: { url: string; tree: string; clearedDomain: string }): PurchaseOutcome {
  const domain = registrableDomain(input.url);
  const onExpectedDomain = isClearedOrKnownProviderDomain(domain, input.clearedDomain);

  if (onExpectedDomain && ORDER_REFERENCE_RE.test(input.tree)) {
    return "confirmed";
  }
  if (onExpectedDomain && FAILURE_WORDING_RE.test(input.tree)) {
    return "failed";
  }
  return "unverified";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Blanks every exact, whole-token occurrence of `literal` in `text` with
 * asterisks. Word-boundary anchored so a short literal (a 3-digit CVC)
 * matches only as a standalone token, not as a substring run inside a
 * longer unrelated number or word -- `\b` sits between a `\w` and non-`\w`
 * character, and digits/letters are both `\w`, so `\b123\b` will not match
 * the "123" inside "41234" but will match a lone "123".
 */
function maskLiteral(text: string, literal: string): string {
  if (literal.length < 2) return text;
  const re = new RegExp(`\\b${escapeRegExp(literal)}\\b`, "gi");
  return text.replace(re, (match) => "*".repeat(match.length));
}

/**
 * Replaces every Luhn-valid 13-19 digit run in `text` (spaces/dashes and
 * all) with asterisks, same length hidden. `extraLiterals` (DUR-4049) are
 * the exact CVC/expiry/cardholder-name values just typed into the page --
 * those never look like a card-number-shaped run, so the PAN regex alone
 * never catches them; they're blanked first, then the PAN regex runs on
 * what's left.
 */
export function maskCardNumbers(text: string, extraLiterals: readonly string[] = []): string {
  let masked = text;
  for (const literal of extraLiterals) {
    if (literal) masked = maskLiteral(masked, literal);
  }
  return masked.replace(CARD_NUMBER_TOKEN_RE, (match) => {
    const digitsOnly = match.replace(/[\s-]/g, "");
    if (digitsOnly.length < 13 || digitsOnly.length > 19 || !isLuhnValid(digitsOnly)) return match;
    return "*".repeat(match.length);
  });
}
