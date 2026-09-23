import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LANE_A_TRANSFORM_SCOPES,
  serviceTokensApi,
  type CreatedServiceToken,
} from "../api/serviceTokens";
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
 * that can be added later — the copy says so plainly before the operator
 * navigates away and loses it.
 *
 * DUR-3997: lives on the Connections page. `readOnly` hides the create form
 * and the Revoke button for operators and viewers; the server routes keep
 * their own checks regardless.
 */
/**
 * Scopes exist so a key's reach is a stored fact rather than an assumption.
 * The operator should be able to read what they just handed out without
 * knowing what a scope string is, so each one gets a plain sentence.
 */
function describeScope(scope: string): string {
  if (scope === "lane_a:transform") return "ask quick agents to rewrite text";
  return scope;
}

export function ServiceTokensSection({ companyId, readOnly = false }: { companyId: string; readOnly?: boolean }) {
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
    mutationFn: () =>
      // The scope is sent explicitly rather than left to the server default, so
      // that adding a second scope to the platform later cannot silently widen
      // the key this button mints.
      serviceTokensApi.create(companyId, {
        name: name.trim(),
        scopes: LANE_A_TRANSFORM_SCOPES,
      }),
    onSuccess: (created) => {
      setJustCreated(created);
      setName("");
      setError(null);
      invalidate();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not create the key");
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (tokenId: string) => serviceTokensApi.revoke(companyId, tokenId),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Key revoked", tone: "success" });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not revoke the key");
    },
  });

  const tokens = tokensQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Keys for other systems</CardTitle>
        <CardDescription>
          A key lets another system — for example the dashboard — ask a quick agent to rewrite text, without
          anyone signing in. The key only works for this company, and it can only do what is listed under each
          key below: it reaches no overviews, tasks, attachments or anything else in Paperclip, and cannot
          approve or change anything. You can revoke it at any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {justCreated && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 space-y-2">
            <p className="text-sm font-medium">Copy the key now</p>
            <p className="text-xs text-muted-foreground">
              This is the only time you will see it. It is not stored in readable form, so if you lose it you
              must create a new one and revoke this one.
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
                  pushToast({ title: "Key copied", tone: "success" });
                }}
              >
                Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setJustCreated(null)}>
                I have saved it
              </Button>
            </div>
          </div>
        )}

        {readOnly ? (
          <p className="text-xs text-muted-foreground">Only the company owner or an admin can create or revoke keys.</p>
        ) : (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <label className="text-sm font-medium" htmlFor="service-token-name">
                What will the key be used for?
              </label>
              <Input
                id="service-token-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="The dashboard"
                maxLength={120}
              />
            </div>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!name.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? "Creating…" : "Create key"}
            </Button>
          </div>
        )}

        {tokensQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">No keys created yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {tokens.map((token) => (
              <li key={token.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{token.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {token.lastUsedAt
                      ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}`
                      : "Never used"}
                    {" · "}
                    {token.scopes.length > 0
                      ? `Can only: ${token.scopes.map(describeScope).join(", ")}`
                      : "Can do nothing (no permissions)"}
                  </p>
                </div>
                {!readOnly && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => revokeMutation.mutate(token.id)}
                    disabled={revokeMutation.isPending}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
