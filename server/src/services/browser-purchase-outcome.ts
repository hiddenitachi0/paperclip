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
 *    digit runs first.
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

/** Replaces every Luhn-valid 13-19 digit run in `text` (spaces/dashes and all) with asterisks, same length hidden. */
export function maskCardNumbers(text: string): string {
  return text.replace(CARD_NUMBER_TOKEN_RE, (match) => {
    const digitsOnly = match.replace(/[\s-]/g, "");
    if (digitsOnly.length < 13 || digitsOnly.length > 19 || !isLuhnValid(digitsOnly)) return match;
    return "*".repeat(match.length);
  });
}
