import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret, PaymentCardStatus, PaymentCardSummary } from "@paperclipai/shared";
import { CreditCard, KeyRound, Plus } from "lucide-react";
import { ApiError } from "../api/client";
import { paymentCardsApi } from "../api/payment-cards";
import { secretsApi } from "../api/secrets";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AddPaymentCardDialog } from "./AddPaymentCardDialog";
import { AddSiteLoginDialog } from "./AddSiteLoginDialog";

function metadataString(secret: CompanySecret, key: string): string | null {
  const value = secret.providerMetadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

const CARD_STATUS_LABELS: Record<PaymentCardStatus, string> = {
  available: "Available",
  reserved: "In use",
  used: "Used up",
  used_unverified: "Used (unconfirmed)",
  expired: "Expired",
  disabled: "Disabled",
};

function formatMoney(amountCents: number, currency: string): string {
  const amount = amountCents / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatExpiry(expiresOn: string | null): string {
  if (!expiresOn) return "No expiry set";
  const date = new Date(`${expiresOn}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "No expiry set";
  return `Expires ${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;
}

type CardConfirmAction = "disable" | "markUsedUp";

/**
 * Connections → payment cards and website logins an agent may use with the
 * browser worker (DUR-4020/DUR-4040). Card list reads the payment_cards
 * metadata table (DUR-4040) — never the secret itself — so nothing here can
 * ever show a card number, CVC or password: only label, brand, last 4
 * digits, currency, loaded/remaining amount, status and expiry.
 */
export function PaymentsAndLoginsSection({ companyId, readOnly }: { companyId: string; readOnly: boolean }) {
  const [addCardOpen, setAddCardOpen] = useState(false);
  const [addLoginOpen, setAddLoginOpen] = useState(false);
  const [confirmCard, setConfirmCard] = useState<{ card: PaymentCardSummary; action: CardConfirmAction } | null>(null);
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const cardsQuery = useQuery({
    queryKey: queryKeys.paymentCards.list(companyId),
    queryFn: () => paymentCardsApi.list(companyId),
  });
  const cards = useMemo(() => cardsQuery.data ?? [], [cardsQuery.data]);

  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
  });
  const secrets = useMemo(() => secretsQuery.data ?? [], [secretsQuery.data]);
  const logins = useMemo(() => secrets.filter((secret) => secret.kind === "site_login"), [secrets]);

  const cardActionMutation = useMutation({
    mutationFn: ({ card, action }: { card: PaymentCardSummary; action: CardConfirmAction }) =>
      action === "disable" ? paymentCardsApi.disable(companyId, card.id) : paymentCardsApi.markUsedUp(companyId, card.id),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.paymentCards.list(companyId) });
      pushToast({
        title: variables.action === "disable" ? "Card disabled" : "Card marked as used up",
        tone: "success",
      });
      setConfirmCard(null);
    },
    onError: (err) => {
      pushToast({
        title: err instanceof ApiError ? err.message : "Could not update the card",
        tone: "error",
      });
    },
  });

  return (
    <div className="space-y-4" data-testid="connections-payments-and-logins">
      <Card data-testid="connections-payment-cards">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <CreditCard className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <div className="space-y-1">
                <CardTitle className="text-sm">Payment cards (single-use)</CardTitle>
                <CardDescription>
                  A single-use card can only be spent once, then it's marked used up — good for handing an agent
                  one booking or purchase at a time without leaving a card open for more.
                </CardDescription>
              </div>
            </div>
            {!readOnly && (
              <Button size="sm" variant="outline" onClick={() => setAddCardOpen(true)}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add card
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {cardsQuery.isPending ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : cards.length === 0 ? (
            <p className="text-xs text-muted-foreground">No payment cards saved yet.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {cards.map((card) => {
                const canDisable = card.status !== "disabled";
                const canMarkUsedUp = card.status === "available" || card.status === "reserved";
                return (
                  <li key={card.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex items-center gap-2 truncate text-sm font-medium">
                        <span className="truncate">{card.label}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {CARD_STATUS_LABELS[card.status]}
                        </Badge>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {card.brand ?? "Card"} ending {card.last4} · {formatMoney(card.remainingAmountCents, card.currency)}{" "}
                        left of {formatMoney(card.loadedAmountCents, card.currency)} · {formatExpiry(card.expiresOn)}
                      </p>
                    </div>
                    {!readOnly && (canDisable || canMarkUsedUp) && (
                      <div className="flex shrink-0 items-center gap-2">
                        {canMarkUsedUp && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setConfirmCard({ card, action: "markUsedUp" })}
                          >
                            Mark as used up
                          </Button>
                        )}
                        {canDisable && (
                          <Button size="sm" variant="outline" onClick={() => setConfirmCard({ card, action: "disable" })}>
                            Disable
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card data-testid="connections-site-logins">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <KeyRound className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <div className="space-y-1">
                <CardTitle className="text-sm">Website logins</CardTitle>
                <CardDescription>
                  Lets an agent sign in to an account you already have on a site, without ever seeing the password
                  itself. If the site asks for a code or BankID, that always comes to you, not the agent.
                </CardDescription>
              </div>
            </div>
            {!readOnly && (
              <Button size="sm" variant="outline" onClick={() => setAddLoginOpen(true)}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add website login
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {secretsQuery.isPending ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : logins.length === 0 ? (
            <p className="text-xs text-muted-foreground">No website logins saved yet.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {logins.map((login) => {
                const site = metadataString(login, "site");
                return (
                  <li key={login.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex items-center gap-2 truncate text-sm font-medium">
                        <span className="truncate">{login.name}</span>
                        {login.status !== "active" && (
                          <Badge variant="outline" className="text-[10px]">
                            {login.status}
                          </Badge>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">{site ?? "Website login"}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {!readOnly && (
        <>
          <AddPaymentCardDialog open={addCardOpen} onOpenChange={setAddCardOpen} companyId={companyId} />
          <AddSiteLoginDialog open={addLoginOpen} onOpenChange={setAddLoginOpen} companyId={companyId} />
        </>
      )}

      <AlertDialog open={confirmCard !== null} onOpenChange={(next) => !next && setConfirmCard(null)}>
        <AlertDialogContent data-testid="payment-card-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmCard?.action === "disable" ? "Disable this card?" : "Mark this card as used up?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmCard?.action === "disable"
                ? `"${confirmCard.card.label}" will stop working for any agent right away. This can't be undone from here.`
                : `"${confirmCard?.card.label}" will be marked as fully spent, even if some balance is left. Use this if the card ran out off-platform. This can't be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cardActionMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={cardActionMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (confirmCard) cardActionMutation.mutate(confirmCard);
              }}
            >
              {cardActionMutation.isPending
                ? "Working…"
                : confirmCard?.action === "disable"
                  ? "Disable card"
                  : "Mark as used up"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
