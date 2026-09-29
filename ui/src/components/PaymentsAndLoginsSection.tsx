import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanySecret } from "@paperclipai/shared";
import { CreditCard, KeyRound, Plus } from "lucide-react";
import { secretsApi } from "../api/secrets";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AddPaymentCardDialog } from "./AddPaymentCardDialog";
import { AddSiteLoginDialog } from "./AddSiteLoginDialog";

function metadataString(secret: CompanySecret, key: string): string | null {
  const value = secret.providerMetadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Connections → payment cards and website logins an agent may use with the
 * browser worker (DUR-4020). Nothing here ever shows a card number, CVC or
 * password — only what was saved as non-secret metadata at creation time
 * (card brand + last 4 digits, or the site domain).
 */
export function PaymentsAndLoginsSection({ companyId, readOnly }: { companyId: string; readOnly: boolean }) {
  const [addCardOpen, setAddCardOpen] = useState(false);
  const [addLoginOpen, setAddLoginOpen] = useState(false);

  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
  });
  const secrets = useMemo(() => secretsQuery.data ?? [], [secretsQuery.data]);
  const cards = useMemo(() => secrets.filter((secret) => secret.kind === "payment_card_single_use"), [secrets]);
  const logins = useMemo(() => secrets.filter((secret) => secret.kind === "site_login"), [secrets]);

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
          {secretsQuery.isPending ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : cards.length === 0 ? (
            <p className="text-xs text-muted-foreground">No payment cards saved yet.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {cards.map((card) => {
                const brand = metadataString(card, "brand");
                const last4 = metadataString(card, "last4");
                return (
                  <li key={card.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex items-center gap-2 truncate text-sm font-medium">
                        <span className="truncate">{card.name}</span>
                        {card.status !== "active" && (
                          <Badge variant="outline" className="text-[10px]">
                            {card.status}
                          </Badge>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {brand ?? "Card"}
                        {last4 ? ` ending ${last4}` : ""}
                      </p>
                    </div>
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
    </div>
  );
}
