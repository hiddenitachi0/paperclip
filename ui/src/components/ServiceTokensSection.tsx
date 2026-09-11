import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { serviceTokensApi, type CreatedServiceToken } from "../api/serviceTokens";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * DUR-3977: where the operator hands another system a key to Paperclip.
 *
 * The one thing this card must get right in the UI is that the key is shown
 * once. The server stores only a hash, so "show it again" is not a feature
 * that can be added later — the copy says so plainly, in Norwegian, before
 * the operator navigates away and loses it.
 */
export function ServiceTokensSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [name, setName] = useState("");
  const [justCreated, setJustCreated] = useState<CreatedServiceToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tokensQuery = useQuery({
    queryKey: queryKeys.companies.serviceTokens(companyId),
    queryFn: () => serviceTokensApi.list(companyId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.companies.serviceTokens(companyId) });
  };

  const createMutation = useMutation({
    mutationFn: () => serviceTokensApi.create(companyId, { name: name.trim() }),
    onSuccess: (created) => {
      setJustCreated(created);
      setName("");
      setError(null);
      invalidate();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Kunne ikke lage nøkkelen");
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (tokenId: string) => serviceTokensApi.revoke(companyId, tokenId),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Nøkkelen er sperret", tone: "success" });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Kunne ikke sperre nøkkelen");
    },
  });

  const tokens = tokensQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nøkler for andre systemer</CardTitle>
        <CardDescription>
          En nøkkel lar et annet system — for eksempel dashbordet — be en hurtigansatt om å skrive om tekst,
          uten at noen må logge inn. Nøkkelen gjelder bare dette selskapet, og den kan ikke brukes til å
          godkjenne noe eller endre noe. Du kan sperre den når som helst.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {justCreated && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 space-y-2">
            <p className="text-sm font-medium">Kopier nøkkelen nå</p>
            <p className="text-xs text-muted-foreground">
              Dette er eneste gang du får se den. Vi lagrer den ikke i lesbar form, så hvis du mister den må du
              lage en ny og sperre denne.
            </p>
            <code className="block break-all rounded bg-background px-2 py-1.5 font-mono text-xs">
              {justCreated.token}
            </code>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(justCreated.token);
                  pushToast({ title: "Nøkkelen er kopiert", tone: "success" });
                }}
              >
                Kopier
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setJustCreated(null)}>
                Jeg har lagret den
              </Button>
            </div>
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <label className="text-sm font-medium" htmlFor="service-token-name">
              Hva skal nøkkelen brukes til?
            </label>
            <Input
              id="service-token-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Dashbordet"
              maxLength={120}
            />
          </div>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!name.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? "Lager…" : "Lag nøkkel"}
          </Button>
        </div>

        {tokensQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Henter…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ingen nøkler er laget ennå.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {tokens.map((token) => (
              <li key={token.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{token.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {token.lastUsedAt
                      ? `Sist brukt ${new Date(token.lastUsedAt).toLocaleString("nb-NO")}`
                      : "Aldri brukt"}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => revokeMutation.mutate(token.id)}
                  disabled={revokeMutation.isPending}
                >
                  Sperr
                </Button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
