import { useQuery } from "@tanstack/react-query";
import {
  CRYPTO_CHAIN_INFO,
  CRYPTO_FAUCET_HINTS_AS_OF,
  CRYPTO_FAUCET_HINTS_CHANGE_NOTE,
  CRYPTO_TESTNET_SEND_WARNING,
  cryptoNetworkLabel,
  cryptoPaymentLink,
  formatChainAmount,
  type CryptoWalletSummary,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { cryptoWalletsApi } from "../api/cryptoWallets";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

type AgentRef = { id: string; name: string; urlKey?: string | null };

function TestWalletRow({ wallet, companyId, agent }: { wallet: CryptoWalletSummary; companyId: string; agent: AgentRef | undefined }) {
  const info = CRYPTO_CHAIN_INFO[wallet.chain];
  const balanceQuery = useQuery({
    queryKey: queryKeys.cryptoWallets.balance(companyId, wallet.id),
    queryFn: () => cryptoWalletsApi.balance(companyId, wallet.id),
    enabled: false,
  });
  const paymentLink = cryptoPaymentLink(wallet.chain, wallet.network, wallet.address, wallet.evmChainId);
  const balanceText = balanceQuery.data ? balanceQuery.data.balanceDisplay : formatChainAmount(wallet.chain, wallet.lastBalance);

  return (
    <li className="space-y-3 px-4 py-3" data-testid="test-wallet-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{wallet.label}</span>
        <span className="text-sm text-muted-foreground">{info.label}</span>
        <span
          className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold uppercase text-muted-foreground"
          data-testid="test-wallet-badge"
        >
          TEST NETWORK: no value
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {agent ? (
          <>
            Belongs to{" "}
            <Link to={`${agentUrl(agent)}/configuration`} className="underline underline-offset-2">
              {agent.name}
            </Link>
          </>
        ) : (
          "Not linked to an agent"
        )}
        {" · "}
        {cryptoNetworkLabel(wallet.chain, wallet.network, wallet)}
      </p>

      <div className="space-y-1">
        <p className="text-xs font-medium">Address</p>
        <p className="break-all font-mono text-xs" data-testid="test-wallet-address">
          {wallet.address}
        </p>
        <p className="text-xs font-medium text-destructive">{CRYPTO_TESTNET_SEND_WARNING}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>
          Balance: <span className="font-medium">{balanceText === "-" ? "not checked yet" : balanceText}</span>
        </span>
        <Button size="sm" variant="outline" onClick={() => balanceQuery.refetch()} disabled={balanceQuery.isFetching}>
          {balanceQuery.isFetching ? "Checking…" : "Check balance"}
        </Button>
      </div>
      {balanceQuery.data?.reconciliation.note ? <p className="text-xs text-destructive">{balanceQuery.data.reconciliation.note}</p> : null}
      {balanceQuery.error ? <p className="text-xs text-destructive">{errorMessage(balanceQuery.error)}</p> : null}

      <div className="space-y-1 text-sm">
        <p className="font-medium">How to add test coins</p>
        <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>Copy the address above.</li>
          <li>{info.testnetFaucetHint}</li>
          {info.testnetFaucetNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
          <li>Come back here and press "Check balance".</li>
        </ol>
        {paymentLink ? (
          <p className="text-xs text-muted-foreground">
            Payment link:{" "}
            <a href={paymentLink} className="break-all font-mono underline" data-testid="test-wallet-payment-link">
              {paymentLink}
            </a>
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          As of {CRYPTO_FAUCET_HINTS_AS_OF}. {CRYPTO_FAUCET_HINTS_CHANGE_NOTE}
        </p>
      </div>
    </li>
  );
}

/**
 * Trading page: the company's test-network wallets across all agents, with
 * balance, address and funding steps. Owner/admin only (the wallet routes
 * are owner/admin-only on the server too), so render it behind canManage.
 * Only public data is shown: addresses and balances, never a key.
 */
export function TestWalletsPanel({ companyId }: { companyId: string }) {
  const walletsQuery = useQuery({
    queryKey: queryKeys.cryptoWallets.list(companyId),
    queryFn: () => cryptoWalletsApi.list(companyId),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const agents: AgentRef[] = agentsQuery.data ?? [];
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const holder = agents.find((a) => /wallet\s*holder/i.test(a.name));
  const wallets = (walletsQuery.data ?? []).filter((w) => w.network === "testnet" && w.status !== "archived");

  return (
    <section className="space-y-3 rounded-lg border border-border p-4" data-testid="test-wallets-panel">
      <div>
        <h2 className="text-base font-semibold">Test wallets</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Test networks check that sending and approvals work. Whether a strategy is good is measured on real prices in paper trading.
        </p>
      </div>

      {walletsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading test wallets…</p>
      ) : walletsQuery.error ? (
        <p className="text-sm text-destructive">{errorMessage(walletsQuery.error)}</p>
      ) : wallets.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="test-wallets-empty">
          No test wallets yet.{" "}
          {holder ? (
            <>
              To create one, open{" "}
              <Link to={`${agentUrl(holder)}/configuration`} className="underline underline-offset-2">
                {holder.name}
              </Link>{" "}
              and add a wallet under "Crypto wallets".
            </>
          ) : (
            <>
              To create one, open an agent's{" "}
              <Link to="/agents/all" className="underline underline-offset-2">
                settings
              </Link>{" "}
              and add a wallet under "Crypto wallets". There is no agent called "Wallet holder" yet.
            </>
          )}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {wallets.map((wallet) => (
              <TestWalletRow
                key={wallet.id}
                wallet={wallet}
                companyId={companyId}
                agent={wallet.agentId ? agentById.get(wallet.agentId) : undefined}
              />
            ))}
          </ul>
          {holder ? (
            <p className="text-sm text-muted-foreground">
              Need another one?{" "}
              <Link to={`${agentUrl(holder)}/configuration`} className="underline underline-offset-2">
                Open {holder.name}
              </Link>{" "}
              and add a wallet under "Crypto wallets".
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
