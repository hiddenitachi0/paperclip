import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CRYPTO_CHAINS,
  CRYPTO_CHAIN_INFO,
  CRYPTO_MAINNET_CONFIRM_PHRASE,
  CRYPTO_RISK_EXPLANATIONS,
  DEFAULT_CRYPTO_RPC_ENDPOINTS,
  type CryptoChain,
  type CryptoNetwork,
} from "@paperclipai/shared";
import { cryptoWalletsApi } from "../api/cryptoWallets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/**
 * Company-wide crypto wallet settings: the real-money switch (owner only,
 * off by default), the freeze-everything switch, and the network addresses
 * Paperclip talks to. Owner/admin only; the server enforces the same.
 */
export function CryptoCompanySettingsCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const role = useCompanyRole(companyId);
  const isOwner = role.localBoard || role.isInstanceAdmin || role.role === "owner";
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [showEndpoints, setShowEndpoints] = useState(false);
  const [endpointDrafts, setEndpointDrafts] = useState<Record<string, string>>({});

  const settingsQuery = useQuery({
    queryKey: queryKeys.cryptoWallets.settings(companyId),
    queryFn: () => cryptoWalletsApi.settings(companyId),
  });
  const settings = settingsQuery.data;

  const update = useMutation({
    mutationFn: (input: Parameters<typeof cryptoWalletsApi.updateSettings>[1]) => cryptoWalletsApi.updateSettings(companyId, input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["crypto-settings", companyId] });
      queryClient.invalidateQueries({ queryKey: ["crypto-agent-limits", companyId] });
      setConfirmOpen(false);
      setPhrase("");
      pushToast({
        title: "Crypto settings saved",
        body:
          result.agentLimitsReset !== undefined
            ? "Real money is on. Every agent's dollar limits are back to the safe defaults; raise them on each agent if you want to."
            : undefined,
        tone: "success",
      });
    },
    onError: (error) => pushToast({ title: "Could not save the crypto settings", body: errorMessage(error), tone: "error" }),
  });

  if (settingsQuery.isLoading || !settings) {
    return <div className="text-sm text-muted-foreground">Loading crypto settings…</div>;
  }

  const endpointKey = (chain: CryptoChain, network: CryptoNetwork) => `${chain}.${network}`;

  return (
    <section className="space-y-4 rounded-lg border border-border p-4" data-testid="crypto-company-settings">
      <div>
        <h2 className="text-base font-semibold">Crypto wallets: company settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">{CRYPTO_RISK_EXPLANATIONS.overview}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          These switches cover every agent's wallets. To add a wallet, open an agent's settings and use Crypto wallets.
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Real money</p>
            <p className="text-sm text-muted-foreground">
              {settings.mainnetEnabled
                ? "On. Wallets made for the main network hold and move real money."
                : "Off. Every wallet uses a test network with free test coins that have no value."}
            </p>
          </div>
          {settings.mainnetEnabled ? (
            <Button variant="outline" size="sm" disabled={update.isPending} onClick={() => update.mutate({ mainnetEnabled: false })}>
              Turn real money off
            </Button>
          ) : (
            <Button size="sm" disabled={!isOwner || update.isPending} onClick={() => setConfirmOpen(true)}>
              Turn real money on
            </Button>
          )}
        </div>
        {!settings.mainnetEnabled && !isOwner ? (
          <p className="text-xs text-muted-foreground">Only the company's owner can turn real money on.</p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Freeze all wallets</p>
          <p className="text-sm text-muted-foreground">
            {settings.allWalletsFrozen
              ? `Every wallet is frozen${settings.frozenReason ? `: ${settings.frozenReason}` : "."} No agent can send or trade.`
              : CRYPTO_RISK_EXPLANATIONS.killSwitch}
          </p>
        </div>
        <Button
          variant={settings.allWalletsFrozen ? "outline" : "destructive"}
          size="sm"
          disabled={update.isPending || (settings.allWalletsFrozen && settings.mainnetEnabled && !isOwner)}
          title={settings.allWalletsFrozen && settings.mainnetEnabled && !isOwner ? "Only the owner can unfreeze while real money is on." : undefined}
          onClick={() =>
            update.mutate(settings.allWalletsFrozen ? { allWalletsFrozen: false } : { allWalletsFrozen: true, frozenReason: "Frozen from the company settings." })
          }
        >
          {settings.allWalletsFrozen ? "Unfreeze all wallets" : "Freeze all wallets"}
        </Button>
      </div>

      <div className="space-y-2">
        <button type="button" className="text-sm font-medium underline-offset-4 hover:underline" onClick={() => setShowEndpoints((v) => !v)}>
          {showEndpoints ? "Hide network addresses" : "Network addresses (advanced)"}
        </button>
        {showEndpoints ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Paperclip asks these services for balances and sends payments through them. Leave a box empty to use the public default. If
              your provider's address contains a key, anyone who can open these settings can see it. Only the owner can change these, because
              they decide which network a wallet really pays on.
            </p>
            {CRYPTO_CHAINS.flatMap((chain) =>
              (["testnet", "mainnet"] as const).map((network) => {
                const key = endpointKey(chain, network);
                const current = settings.rpcEndpoints?.[chain]?.[network] ?? "";
                return (
                  <div key={key} className="space-y-1">
                    <Label htmlFor={`rpc-${key}`} className="text-xs">
                      {CRYPTO_CHAIN_INFO[chain].label}, {network === "mainnet" ? "main network" : "test network"}
                    </Label>
                    <Input
                      id={`rpc-${key}`}
                      placeholder={DEFAULT_CRYPTO_RPC_ENDPOINTS[chain][network]}
                      value={endpointDrafts[key] ?? current}
                      onChange={(event) => setEndpointDrafts((drafts) => ({ ...drafts, [key]: event.target.value }))}
                    />
                  </div>
                );
              }),
            )}
            <Button
              size="sm"
              disabled={!isOwner || update.isPending || Object.keys(endpointDrafts).length === 0}
              onClick={() => {
                const rpcEndpoints: Record<string, Record<string, string | null>> = {};
                for (const [key, value] of Object.entries(endpointDrafts)) {
                  const [chain, network] = key.split(".") as [CryptoChain, CryptoNetwork];
                  (rpcEndpoints[chain] ??= {})[network] = value.trim() === "" ? null : value.trim();
                }
                update.mutate({ rpcEndpoints }, { onSuccess: () => setEndpointDrafts({}) });
              }}
            >
              Save network addresses
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn on real money?</DialogTitle>
            <DialogDescription>{CRYPTO_RISK_EXPLANATIONS.mainnet}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Payments on the main network cannot be undone. Coins sent to a wrong address are gone.</li>
              <li>Agents can still only send to addresses you allow, within the limits you set.</li>
              <li>Payments above each wallet's approval amount still wait for a person to approve them.</li>
              <li>Existing test wallets stay on the test network. Make a new wallet for real money.</li>
              <li>Every agent's dollar limits go back to the safe defaults, so you decide them again with real money in mind.</li>
              <li>From then on only you, the owner, can unfreeze wallets or change real-money limits and addresses.</li>
            </ul>
            <div className="space-y-1">
              <Label htmlFor="mainnet-confirm">Type {CRYPTO_MAINNET_CONFIRM_PHRASE} to confirm</Label>
              <Input id="mainnet-confirm" value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="off" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={phrase.trim() !== CRYPTO_MAINNET_CONFIRM_PHRASE || update.isPending}
              onClick={() => update.mutate({ mainnetEnabled: true, confirmPhrase: phrase.trim() })}
            >
              Turn real money on
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
