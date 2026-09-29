/**
 * DUR-4040 (Maja browser step 5): the shared shape of a payment card's
 * metadata row (`payment_cards`, packages/db/src/schema/payment_cards.ts) and
 * its status lifecycle. Never the card's PAN/CVC -- those live only in the
 * encrypted `payment_card_single_use` secret (`secret-kinds.ts`) that
 * `secretId` points at; this is metadata only, safe to return from an API
 * response.
 *
 * Lifecycle: available -> reserved (bound to a live clearance, step 6) ->
 * used | used_unverified (purchase completed but the confirmation could not
 * be read back). available/reserved -> expired (the daily tick, once
 * `expiresOn` has passed) or disabled (a board user, any time).
 */
export const PAYMENT_CARD_STATUSES = [
  "available",
  "reserved",
  "used",
  "used_unverified",
  "expired",
  "disabled",
] as const;

export type PaymentCardStatus = (typeof PAYMENT_CARD_STATUSES)[number];

/** Statuses a card can still be used from -- everything else is a terminal or held state. */
export const ACTIVE_PAYMENT_CARD_STATUSES: readonly PaymentCardStatus[] = ["available"];

export interface PaymentCardSummary {
  id: string;
  companyId: string;
  secretId: string;
  label: string;
  brand: string | null;
  last4: string;
  currency: string;
  loadedAmountCents: number;
  remainingAmountCents: number;
  singleUse: boolean;
  status: PaymentCardStatus;
  /** ISO date (YYYY-MM-DD), or null when this card has no tracked expiry. */
  expiresOn: string | null;
  allowedAgentIds: string[];
  reservedForClearanceId: string | null;
  reservedAt: string | null;
  usedAt: string | null;
  usedByPurchaseId: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
}
