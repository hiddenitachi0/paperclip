import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, paymentCards } from "@paperclipai/db";
import { readLaneABrowserAccess, type PaymentCardStatus, type PaymentCardSummary } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { secretService } from "./secrets.js";

/**
 * DUR-4040 (Maja browser step 5): metadata lifecycle + the one path that ever
 * reads a card's secret value. Everything here operates on `payment_cards`
 * rows only -- the PAN/CVC lives exclusively in the `payment_card_single_use`
 * secret `secretId` points at (DUR-4019), resolved only by `resolveForFill`.
 *
 * Purchasing itself (arming a clearance, reserving a card for it, consuming
 * it) is step 6 and is not built here -- `resolveForFill` takes an already
 * -reserved card as a given (this service does not create that reservation)
 * and only re-checks the kill switches + the reservation itself before
 * resolving the secret. `create` is deliberately not part of this surface:
 * the ticket that adds it decides how a card's metadata row and its secret
 * get created together.
 */
export interface PaymentCardServiceDeps {
  now?: () => Date;
  /** Overridable so tests don't need a real env var. Defaults to reading PAPERCLIP_BROWSER_DISABLED. */
  isInstanceBrowserDisabled?: () => boolean;
}

function defaultIsInstanceBrowserDisabled(): boolean {
  return process.env.PAPERCLIP_BROWSER_DISABLED === "true" || process.env.PAPERCLIP_BROWSER_DISABLED === "1";
}

function toSummary(row: typeof paymentCards.$inferSelect): PaymentCardSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    secretId: row.secretId,
    label: row.label,
    brand: row.brand,
    last4: row.last4,
    currency: row.currency,
    loadedAmountCents: row.loadedAmountCents,
    remainingAmountCents: row.remainingAmountCents,
    singleUse: row.singleUse,
    status: row.status as PaymentCardStatus,
    expiresOn: row.expiresOn,
    allowedAgentIds: row.allowedAgentIds ?? [],
    reservedForClearanceId: row.reservedForClearanceId,
    reservedAt: row.reservedAt ? row.reservedAt.toISOString() : null,
    usedAt: row.usedAt ? row.usedAt.toISOString() : null,
    usedByPurchaseId: row.usedByPurchaseId,
    disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
    disabledReason: row.disabledReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function paymentCardService(db: Db, rawDb: Db = db, deps: PaymentCardServiceDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const isInstanceBrowserDisabled = deps.isInstanceBrowserDisabled ?? defaultIsInstanceBrowserDisabled;
  const secrets = secretService(db, rawDb);

  async function getRow(companyId: string, cardId: string) {
    const [row] = await db
      .select()
      .from(paymentCards)
      .where(and(eq(paymentCards.companyId, companyId), eq(paymentCards.id, cardId)));
    return row ?? null;
  }

  async function list(companyId: string): Promise<PaymentCardSummary[]> {
    const rows = await db
      .select()
      .from(paymentCards)
      .where(eq(paymentCards.companyId, companyId))
      .orderBy(asc(paymentCards.createdAt));
    return rows.map(toSummary);
  }

  async function getById(companyId: string, cardId: string): Promise<PaymentCardSummary> {
    const row = await getRow(companyId, cardId);
    if (!row) throw notFound("Payment card not found");
    return toSummary(row);
  }

  /**
   * Board-only, any status -> disabled, any time (per the schema's own
   * lifecycle docstring). Idempotent: disabling an already-disabled card just
   * returns it unchanged rather than erroring, since two board clicks racing
   * on the same card is a UI double-submit, not a conflict worth surfacing.
   */
  async function disable(companyId: string, cardId: string, input: { reason?: string | null } = {}): Promise<PaymentCardSummary> {
    const row = await getRow(companyId, cardId);
    if (!row) throw notFound("Payment card not found");
    if (row.status === "disabled") return toSummary(row);

    const [updated] = await db
      .update(paymentCards)
      .set({
        status: "disabled",
        disabledAt: now(),
        disabledReason: input.reason ?? null,
        updatedAt: now(),
      })
      .where(and(eq(paymentCards.companyId, companyId), eq(paymentCards.id, cardId)))
      .returning();
    return toSummary(updated!);
  }

  /**
   * Board-only manual override: the operator knows the card is spent (e.g.
   * the balance ran out off-platform) even though no purchase here recorded
   * it. Only valid from available/reserved -- a card already used, expired or
   * disabled is a dead end this cannot reopen or re-close.
   */
  async function markAsUsedUp(companyId: string, cardId: string, input: { reason?: string | null } = {}): Promise<PaymentCardSummary> {
    const row = await getRow(companyId, cardId);
    if (!row) throw notFound("Payment card not found");
    if (row.status === "used" || row.status === "used_unverified") return toSummary(row);
    if (row.status !== "available" && row.status !== "reserved") {
      throw conflict(`Cannot mark a ${row.status} card as used up`);
    }

    const [updated] = await db
      .update(paymentCards)
      .set({
        status: "used",
        usedAt: now(),
        remainingAmountCents: 0,
        disabledReason: input.reason ?? row.disabledReason,
        updatedAt: now(),
      })
      .where(and(eq(paymentCards.companyId, companyId), eq(paymentCards.id, cardId)))
      .returning();
    return toSummary(updated!);
  }

  /**
   * Daily sweep: available/reserved cards whose expiresOn has passed become
   * expired. Company-agnostic (bypass scope, like watchers/morningReport's
   * own ticks in index.ts) since this runs once for the whole instance, not
   * per company. A card with no expiresOn is never swept -- that is "no
   * tracked expiry", not an error.
   */
  async function runDailyExpiryTick(tickNow: Date = now()): Promise<{ expired: number }> {
    const today = tickNow.toISOString().slice(0, 10);
    const updated = await db
      .update(paymentCards)
      .set({ status: "expired", updatedAt: tickNow })
      .where(
        and(
          lt(paymentCards.expiresOn, today),
          inArray(paymentCards.status, ["available", "reserved"]),
        ),
      )
      .returning({ id: paymentCards.id });
    return { expired: updated.length };
  }

  /**
   * DUR-4046 (step 6): atomically claims an available card for a purchase
   * clearance. The `status = 'available'` guard in the WHERE clause is
   * itself the race guard -- two concurrent `request_purchase` calls for the
   * same card race on this single-row UPDATE, and at most one can match --
   * no advisory lock is needed for THIS check (unlike the cross-row
   * daily/weekly/merchant cap counters, which browser-service.ts computes
   * under `pg_advisory_xact_lock` before ever calling this). Requires the
   * card to already list `agentId` in `allowedAgentIds`; a card with no
   * agents listed (the schema's safe default) can never be reserved by
   * anyone.
   */
  async function reserveAvailableCard(
    companyId: string,
    cardId: string,
    input: { clearanceId: string; agentId: string },
  ): Promise<PaymentCardSummary> {
    const existing = await getRow(companyId, cardId);
    if (!existing) throw notFound("Payment card not found");
    if (!existing.allowedAgentIds.includes(input.agentId)) {
      throw forbidden("This agent is not allowed to use this payment card");
    }
    const [row] = await db
      .update(paymentCards)
      .set({
        status: "reserved",
        reservedForClearanceId: input.clearanceId,
        reservedAt: now(),
        updatedAt: now(),
      })
      .where(
        and(
          eq(paymentCards.companyId, companyId),
          eq(paymentCards.id, cardId),
          eq(paymentCards.status, "available"),
        ),
      )
      .returning();
    if (!row) throw conflict(`Card is ${existing.status}, not available`);
    return toSummary(row);
  }

  /**
   * DUR-4046 (step 6): the reservation's terminal step once a purchase's
   * outcome is known -- `used` when the server itself verified the charge
   * (see `classifyPurchaseOutcome`), `used_unverified` when a confirm/arm
   * happened but the outcome could not be independently confirmed (the
   * design's "fake confirmation pages" mitigation: an unverified charge must
   * never look identical to a verified one). Guarded on the exact
   * `clearanceId` the card was reserved for, so a stale/duplicate call
   * cannot consume a card a fresh `request_purchase` has since re-reserved.
   */
  async function consumeReservation(
    companyId: string,
    cardId: string,
    input: { clearanceId: string; outcome: "used" | "used_unverified"; spentAmountCents: number; purchaseId: string },
  ): Promise<PaymentCardSummary> {
    const existing = await getRow(companyId, cardId);
    if (!existing) throw notFound("Payment card not found");
    const [row] = await db
      .update(paymentCards)
      .set({
        status: input.outcome,
        usedAt: now(),
        usedByPurchaseId: input.purchaseId,
        remainingAmountCents: Math.max(0, existing.remainingAmountCents - Math.max(0, input.spentAmountCents)),
        updatedAt: now(),
      })
      .where(
        and(
          eq(paymentCards.companyId, companyId),
          eq(paymentCards.id, cardId),
          eq(paymentCards.status, "reserved"),
          eq(paymentCards.reservedForClearanceId, input.clearanceId),
        ),
      )
      .returning();
    if (!row) throw conflict(`Card is not reserved for clearance ${input.clearanceId}`);
    return toSummary(row);
  }

  /**
   * DUR-4046 (step 6): "Failure before a charge -> available again" (design
   * section 4). Only ever called on a path the caller knows never armed the
   * network hold (or explicitly detected a declined/failed outcome before
   * any charge could have landed) -- confirmFinalStep's own gate refusals
   * (page changed, price changed, wrong element, no live clearance) never
   * reach the click, so those callers release directly; a card that already
   * moved past `reserved` (used/used_unverified/disabled/expired) is left
   * untouched, matching `markAsUsedUp`'s own idempotent pattern.
   */
  async function releaseReservation(
    companyId: string,
    cardId: string,
    input: { clearanceId: string },
  ): Promise<PaymentCardSummary> {
    const existing = await getRow(companyId, cardId);
    if (!existing) throw notFound("Payment card not found");
    if (existing.status !== "reserved" || existing.reservedForClearanceId !== input.clearanceId) {
      return toSummary(existing);
    }
    const [row] = await db
      .update(paymentCards)
      .set({ status: "available", reservedForClearanceId: null, reservedAt: null, updatedAt: now() })
      .where(
        and(
          eq(paymentCards.companyId, companyId),
          eq(paymentCards.id, cardId),
          eq(paymentCards.status, "reserved"),
          eq(paymentCards.reservedForClearanceId, input.clearanceId),
        ),
      )
      .returning();
    return toSummary(row ?? existing);
  }

  /**
   * The ONLY reader of a payment card's secret material. Re-checks every off
   * -switch plus the reservation itself; does not create or extend a
   * reservation (that is step 6's job). Throws (never silently returns null)
   * so a caller cannot forget to handle "not allowed".
   */
  async function resolveForFill(
    companyId: string,
    clearanceId: string,
    context: { agentId: string; issueId?: string | null; heartbeatRunId?: string | null },
  ): Promise<string> {
    if (isInstanceBrowserDisabled()) {
      throw forbidden("Browser purchasing is disabled for this instance");
    }

    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    if (!company) throw notFound("Company not found");
    if (!company.paymentsEnabled) throw forbidden("Payments are not enabled for this company");

    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, context.agentId)));
    if (!agent) throw notFound("Agent not found");
    if (readLaneABrowserAccess(agent.adapterConfig) !== "book_and_buy") {
      throw forbidden("This agent's browser access does not allow using a payment card");
    }

    const [card] = await db
      .select()
      .from(paymentCards)
      .where(and(eq(paymentCards.companyId, companyId), eq(paymentCards.reservedForClearanceId, clearanceId)));
    if (!card) throw notFound("No payment card is reserved for this clearance");
    if (card.status !== "reserved") {
      throw conflict(`Card is ${card.status}, not reserved`);
    }
    if (!card.allowedAgentIds.includes(context.agentId)) {
      throw forbidden("This agent is not allowed to use this payment card");
    }

    return secrets.resolveSecretValueForBrowserFill(companyId, card.secretId, {
      actorId: context.agentId,
      issueId: context.issueId ?? null,
      heartbeatRunId: context.heartbeatRunId ?? null,
    });
  }

  return {
    list,
    getById,
    disable,
    markAsUsedUp,
    runDailyExpiryTick,
    resolveForFill,
    reserveAvailableCard,
    consumeReservation,
    releaseReservation,
  };
}

export type PaymentCardService = ReturnType<typeof paymentCardService>;
