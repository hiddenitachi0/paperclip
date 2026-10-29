import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CRYPTO_CHAINS,
  CRYPTO_CHAIN_INFO,
  CRYPTO_FAUCET_HINTS_AS_OF,
  CRYPTO_FAUCET_HINTS_CHANGE_NOTE,
  CRYPTO_RISK_EXPLANATIONS,
  DEFAULT_CRYPTO_AGENT_LIMITS,
  DEFAULT_CRYPTO_WALLET_LIMITS,
  CRYPTO_TESTNET_ONLY_LABEL,
  CRYPTO_TESTNET_SEND_WARNING,
  HYPERLIQUID_HARD_MAX_LEVERAGE,
  cryptoNetworkLabel,
  cryptoPaymentLink,
  describeCryptoTxStatus,
  formatChainAmount,
  type CryptoAgentLimits,
  type CryptoChain,
  type CryptoNetwork,
  type CryptoWalletLimits,
  type CryptoWalletSummary,
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

/**
 * The owner/admin "Crypto wallets" block on an agent's settings: make or
 * import a wallet, see its address and balance, set limits and the allowed
 * addresses, freeze it, and send funds back out. The key is never shown --
 * there is nothing on this screen (or behind it) that can display it.
 */

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

const selectClass = "h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none";

function networkBadge(wallet: Pick<CryptoWalletSummary, "network">) {
  return wallet.network === "mainnet" ? (
    <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs font-medium text-destructive">Real money</span>
  ) : (
    <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">Test coins</span>
  );
}

function statusText(wallet: CryptoWalletSummary): string {
  if (wallet.status === "frozen") return `Frozen${wallet.frozenReason ? `: ${wallet.frozenReason}` : ""}`;
  if (wallet.status === "archived") return "Archived";
  return "Active";
}

function LimitsEditor({
  chain,
  value,
  busy,
  onSave,
}: {
  chain: CryptoChain;
  value: CryptoWalletLimits;
  busy: boolean;
  onSave: (limits: CryptoWalletLimits) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [everyPayment, setEveryPayment] = useState(value.approvalAbove === null);
  const asset = CRYPTO_CHAIN_INFO[chain].asset;
  const field = (key: "perTransaction" | "daily" | "total", label: string) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} inputMode="decimal" />
    </div>
  );
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {CRYPTO_RISK_EXPLANATIONS.limits} {CRYPTO_RISK_EXPLANATIONS.fees} Amounts in {asset}
        {chain === "hyperliquid" ? " (for trades: the dollar size of each order)" : ""}.
      </p>
      <div className="grid grid-cols-3 gap-2">
        {field("perTransaction", "Per payment")}
        {field("daily", "Per day")}
        {field("total", "In total")}
      </div>
      <div className="grid grid-cols-2 items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Ask a person to approve from</Label>
          <Input
            value={everyPayment ? "" : (draft.approvalAbove ?? "")}
            disabled={everyPayment}
            placeholder={everyPayment ? "every payment" : ""}
            onChange={(e) => setDraft({ ...draft, approvalAbove: e.target.value })}
            inputMode="decimal"
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-xs">
          <input type="checkbox" checked={everyPayment} onChange={(e) => setEveryPayment(e.target.checked)} />
          Approve every payment
        </label>
      </div>
      <Button size="sm" disabled={busy} onClick={() => onSave({ ...draft, approvalAbove: everyPayment ? null : (draft.approvalAbove ?? "") })}>
        Save limits
      </Button>
    </div>
  );
}

function WalletCard({ wallet, companyId }: { wallet: CryptoWalletSummary; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const info = CRYPTO_CHAIN_INFO[wallet.chain];
  const role = useCompanyRole(companyId);
  const isOwner = role.localBoard || role.isInstanceAdmin || role.role === "owner";
  const ownerOnlyUnfreeze = wallet.status === "frozen" && wallet.network === "mainnet" && !isOwner;
  const [showDetails, setShowDetails] = useState(false);
  const [newAddress, setNewAddress] = useState("");
  const [newAddressLabel, setNewAddressLabel] = useState("");
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendPurpose, setSendPurpose] = useState("");

  const invalidateWallets = () => queryClient.invalidateQueries({ queryKey: ["crypto-wallets", companyId] });

  const balanceQuery = useQuery({
    queryKey: queryKeys.cryptoWallets.balance(companyId, wallet.id),
    queryFn: () => cryptoWalletsApi.balance(companyId, wallet.id),
    enabled: false,
    retry: false,
  });
  const destinationsQuery = useQuery({
    queryKey: queryKeys.cryptoWallets.destinations(companyId, wallet.id),
    queryFn: () => cryptoWalletsApi.destinations(companyId, wallet.id),
    enabled: showDetails,
  });
  const transactionsQuery = useQuery({
    queryKey: queryKeys.cryptoWallets.transactions(companyId, wallet.id),
    queryFn: () => cryptoWalletsApi.transactions(companyId, wallet.id),
    enabled: showDetails,
    refetchInterval: showDetails ? 30_000 : false,
  });

  const onError = (title: string) => (error: unknown) => pushToast({ title, body: errorMessage(error), tone: "error" });

  const update = useMutation({
    mutationFn: (input: Parameters<typeof cryptoWalletsApi.update>[2]) => cryptoWalletsApi.update(companyId, wallet.id, input),
    onSuccess: () => {
      invalidateWallets();
      pushToast({ title: "Wallet saved", tone: "success" });
    },
    onError: onError("Could not save the wallet"),
  });
  const freeze = useMutation({
    mutationFn: (frozen: boolean) => cryptoWalletsApi.setFrozen(companyId, wallet.id, frozen),
    onSuccess: invalidateWallets,
    onError: onError("Could not change the wallet"),
  });
  const archive = useMutation({
    mutationFn: () => cryptoWalletsApi.archive(companyId, wallet.id),
    onSuccess: invalidateWallets,
    onError: onError("Could not archive the wallet"),
  });
  const addDestination = useMutation({
    mutationFn: () => cryptoWalletsApi.addDestination(companyId, wallet.id, { address: newAddress.trim(), label: newAddressLabel.trim() }),
    onSuccess: () => {
      setNewAddress("");
      setNewAddressLabel("");
      queryClient.invalidateQueries({ queryKey: queryKeys.cryptoWallets.destinations(companyId, wallet.id) });
    },
    onError: onError("Could not add the address"),
  });
  const removeDestination = useMutation({
    mutationFn: (id: string) => cryptoWalletsApi.removeDestination(companyId, wallet.id, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.cryptoWallets.destinations(companyId, wallet.id) }),
    onError: onError("Could not remove the address"),
  });
  const send = useMutation({
    mutationFn: () => cryptoWalletsApi.send(companyId, wallet.id, { to: sendTo, amount: sendAmount.trim(), purpose: sendPurpose.trim() }),
    onSuccess: (tx) => {
      setSendOpen(false);
      setSendAmount("");
      setSendPurpose("");
      queryClient.invalidateQueries({ queryKey: queryKeys.cryptoWallets.transactions(companyId, wallet.id) });
      pushToast({
        title: tx.status === "blocked" || tx.status === "failed" ? "Not sent" : "Payment sent",
        body: tx.blockReason ?? tx.error ?? describeCryptoTxStatus(tx.status),
        tone: tx.status === "blocked" || tx.status === "failed" ? "error" : "success",
      });
    },
    onError: onError("Could not send"),
  });

  const archived = wallet.status === "archived";
  const paymentLink = cryptoPaymentLink(wallet.chain, wallet.network, wallet.address);
  const destinations = destinationsQuery.data ?? [];

  return (
    <li className="space-y-3 px-4 py-3" data-testid="crypto-wallet-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            <span>{wallet.label}</span>
            <span className="text-sm text-muted-foreground">{info.label}</span>
            {networkBadge(wallet)}
          </div>
          <p className="break-all font-mono text-xs">{wallet.address}</p>
          {wallet.network === "testnet" ? (
            <p className="text-xs font-medium text-destructive" data-testid="crypto-testnet-warning">
              {CRYPTO_TESTNET_SEND_WARNING}
            </p>
          ) : null}
          <p className={`text-xs ${wallet.status === "active" ? "text-muted-foreground" : "text-destructive"}`}>
            {statusText(wallet)} · {cryptoNetworkLabel(wallet.chain, wallet.network)} · key {wallet.keyOrigin === "imported" ? "imported" : "made by Paperclip"}
          </p>
        </div>
        {!archived ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => balanceQuery.refetch()} disabled={balanceQuery.isFetching}>
              Check balance
            </Button>
            <Button
              size="sm"
              variant={wallet.status === "frozen" ? "outline" : "destructive"}
              disabled={freeze.isPending || ownerOnlyUnfreeze}
              title={ownerOnlyUnfreeze ? "Only the owner can unfreeze a real-money wallet." : undefined}
              onClick={() => freeze.mutate(wallet.status !== "frozen")}
            >
              {wallet.status === "frozen" ? "Unfreeze" : "Freeze"}
            </Button>
          </div>
        ) : null}
      </div>

      {balanceQuery.data ? (
        <div className="text-sm">
          Balance: <span className="font-medium">{balanceQuery.data.balanceDisplay}</span>
          {balanceQuery.data.withdrawable ? <span className="text-muted-foreground"> (can withdraw {formatChainAmount(wallet.chain, balanceQuery.data.withdrawable)})</span> : null}
          {balanceQuery.data.reconciliation.note ? <p className="text-xs text-destructive">{balanceQuery.data.reconciliation.note}</p> : null}
        </div>
      ) : balanceQuery.error ? (
        <p className="text-xs text-destructive">{errorMessage(balanceQuery.error)}</p>
      ) : null}

      <button type="button" className="text-sm underline-offset-4 hover:underline" onClick={() => setShowDetails((v) => !v)}>
        {showDetails ? "Hide details" : "Funding, limits, allowed addresses and payments"}
      </button>

      {showDetails ? (
        <div className="space-y-5 text-sm">
          {wallet.network === "mainnet" ? (
            <p className="rounded border border-destructive/40 px-3 py-2 text-xs">
              Real money: only the company's owner can change this wallet's limits, leverage and allowed addresses, or send funds from it.
            </p>
          ) : null}
          <div className="space-y-1">
            <p className="font-medium">How to add funds</p>
            <p className="text-muted-foreground">
              Send {info.asset} to the address above
              {wallet.chain === "hyperliquid" ? " on Hyperliquid (deposit USDC to this address through Hyperliquid's own site)" : ""}.{" "}
              {wallet.network === "testnet" ? info.testnetFaucetHint : "This is the main network: only send what you are ready to let this agent use."}
            </p>
            {wallet.network === "testnet" ? (
              <>
                {info.testnetFaucetNotes.map((note) => (
                  <p key={note} className="text-muted-foreground">
                    {note}
                  </p>
                ))}
                <p className="text-xs text-muted-foreground" data-testid="crypto-faucet-stamp">
                  As of {CRYPTO_FAUCET_HINTS_AS_OF}. {CRYPTO_FAUCET_HINTS_CHANGE_NOTE}
                </p>
              </>
            ) : null}
            {paymentLink ? (
              <p className="text-xs text-muted-foreground">
                Payment link{wallet.network === "testnet" ? ` (${CRYPTO_TESTNET_ONLY_LABEL})` : ""}:{" "}
                <a href={paymentLink} className="break-all font-mono underline" data-testid="crypto-payment-link">
                  {paymentLink}
                </a>
              </p>
            ) : null}
            <p className="text-muted-foreground">{info.whatAgentsCanDo}</p>
          </div>

          {!archived ? (
            <div className="space-y-1">
              <p className="font-medium">Limits</p>
              <LimitsEditor chain={wallet.chain} value={wallet.limits} busy={update.isPending} onSave={(limits) => update.mutate({ limits })} />
            </div>
          ) : null}

          {wallet.chain === "hyperliquid" && !archived ? (
            <div className="space-y-1">
              <p className="font-medium">Leverage cap</p>
              <p className="text-xs text-muted-foreground">{CRYPTO_RISK_EXPLANATIONS.hyperliquid}</p>
              <select
                className={selectClass}
                value={wallet.maxLeverage}
                onChange={(e) => update.mutate({ maxLeverage: Number(e.target.value) })}
                disabled={update.isPending}
              >
                {Array.from({ length: HYPERLIQUID_HARD_MAX_LEVERAGE }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}x{n === 1 ? " (no leverage)" : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="font-medium">Allowed addresses</p>
            <p className="text-xs text-muted-foreground">{CRYPTO_RISK_EXPLANATIONS.allowList}</p>
            {destinations.length === 0 ? (
              <p className="text-xs text-muted-foreground">None yet, so nothing can be sent from this wallet.</p>
            ) : (
              <ul className="space-y-1">
                {destinations.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="font-medium">{d.label}</span> <span className="break-all font-mono text-xs">{d.address}</span>
                    </span>
                    <Button size="sm" variant="ghost" disabled={removeDestination.isPending} onClick={() => removeDestination.mutate(d.id)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {!archived ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_12rem_auto]">
                <Input placeholder="Address" value={newAddress} onChange={(e) => setNewAddress(e.target.value)} />
                <Input placeholder="Who is it? e.g. My own wallet" value={newAddressLabel} onChange={(e) => setNewAddressLabel(e.target.value)} />
                <Button size="sm" disabled={!newAddress.trim() || !newAddressLabel.trim() || addDestination.isPending} onClick={() => addDestination.mutate()}>
                  Add
                </Button>
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="font-medium">Payments and trades</p>
              <Button size="sm" variant="outline" disabled={destinations.length === 0} onClick={() => setSendOpen(true)}>
                Send funds
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{CRYPTO_RISK_EXPLANATIONS.recovery}</p>
            {(transactionsQuery.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing yet.</p>
            ) : (
              <ul className="divide-y divide-border rounded border border-border">
                {(transactionsQuery.data ?? []).slice(0, 20).map((tx) => (
                  <li key={tx.id} className="space-y-0.5 px-3 py-2 text-xs">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="font-medium">
                        {tx.kind === "order"
                          ? `Trade: ${String(tx.orderDetail?.side ?? "")} ${String(tx.orderDetail?.size ?? "")} ${String(tx.orderDetail?.coin ?? "")}`
                          : `${formatChainAmount(wallet.chain, tx.amount)} to ${tx.destination ?? ""}${
                              tx.feeUpperBound && tx.feeUpperBound !== "0" ? ` (network fee at most ${formatChainAmount(wallet.chain, tx.feeUpperBound)})` : ""
                            }`}
                      </span>
                      <span className={tx.status === "blocked" || tx.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                        {describeCryptoTxStatus(tx.status)}
                      </span>
                    </div>
                    <p className="text-muted-foreground">
                      {new Date(tx.createdAt).toLocaleString()} · {tx.initiatedBy === "owner" ? "sent by a person" : "asked by the agent"} · "{tx.purpose}"
                    </p>
                    {tx.blockReason ? <p className="text-destructive">{tx.blockReason}</p> : null}
                    {tx.error ? <p className="text-destructive">{tx.error}</p> : null}
                    {tx.txHash ? <p className="break-all font-mono text-muted-foreground">{tx.txHash}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {wallet.status === "frozen" ? (
            <div className="space-y-1">
              <Button size="sm" variant="ghost" disabled={archive.isPending} onClick={() => archive.mutate()}>
                Archive this wallet
              </Button>
              <p className="text-xs text-muted-foreground">
                Archiving takes the wallet away from the agent for good. Move the coins out first
                {wallet.network === "mainnet" ? ": a real-money wallet can only be archived once it is empty." : "."}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send funds from "{wallet.label}"</DialogTitle>
            <DialogDescription>
              {wallet.network === "mainnet" ? "This is real money and cannot be undone." : "Test network: test coins have no value."} Only allowed addresses can
              receive.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>To</Label>
              <select className={selectClass} value={sendTo} onChange={(e) => setSendTo(e.target.value)}>
                <option value="">Choose an allowed address</option>
                {destinations.map((d) => (
                  <option key={d.id} value={d.address}>
                    {d.label} ({d.address.slice(0, 10)}…)
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Amount in {info.asset}</Label>
              <Input value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} inputMode="decimal" />
            </div>
            <div className="space-y-1">
              <Label>What is it for?</Label>
              <Input value={sendPurpose} onChange={(e) => setSendPurpose(e.target.value)} placeholder="e.g. Moving the coins back to my own wallet" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!sendTo || !sendAmount.trim() || sendPurpose.trim().length < 3 || send.isPending} onClick={() => send.mutate()}>
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

function AddWalletDialog({
  open,
  onOpenChange,
  companyId,
  agentId,
  mainnetEnabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  agentId: string;
  mainnetEnabled: boolean;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [chain, setChain] = useState<CryptoChain>("ethereum");
  const [network, setNetwork] = useState<CryptoNetwork>("testnet");
  const [mode, setMode] = useState<"generate" | "import">("generate");
  const [label, setLabel] = useState("");
  const [privateKey, setPrivateKey] = useState("");

  const reset = () => {
    setLabel("");
    setPrivateKey("");
    setMode("generate");
    setNetwork("testnet");
  };

  const create = useMutation({
    mutationFn: () =>
      cryptoWalletsApi.create(companyId, {
        agentId,
        chain,
        network,
        label: label.trim(),
        mode,
        ...(mode === "import" ? { privateKey } : {}),
      }),
    onSuccess: () => {
      reset();
      onOpenChange(false);
      queryClient.invalidateQueries({ queryKey: ["crypto-wallets", companyId] });
      pushToast({ title: "Wallet ready", body: "Add allowed addresses and funds before the agent can use it.", tone: "success" });
    },
    onError: (error) => {
      // The key field is cleared on failure too, so it never lingers on screen.
      setPrivateKey("");
      pushToast({ title: "Could not add the wallet", body: errorMessage(error), tone: "error" });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setPrivateKey("");
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a crypto wallet</DialogTitle>
          <DialogDescription>{CRYPTO_RISK_EXPLANATIONS.keys}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Coin</Label>
            <select className={selectClass} value={chain} onChange={(e) => setChain(e.target.value as CryptoChain)}>
              {CRYPTO_CHAINS.map((c) => (
                <option key={c} value={c}>
                  {CRYPTO_CHAIN_INFO[c].label} ({CRYPTO_CHAIN_INFO[c].asset})
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{CRYPTO_CHAIN_INFO[chain].whatAgentsCanDo}</p>
          </div>
          <div className="space-y-1">
            <Label>Network</Label>
            <select className={selectClass} value={network} onChange={(e) => setNetwork(e.target.value as CryptoNetwork)}>
              <option value="testnet">{cryptoNetworkLabel(chain, "testnet")}</option>
              <option value="mainnet" disabled={!mainnetEnabled}>
                {cryptoNetworkLabel(chain, "mainnet")}
                {mainnetEnabled ? "" : " (turned off for this company)"}
              </option>
            </select>
            <p className="text-xs text-muted-foreground">{network === "testnet" ? CRYPTO_RISK_EXPLANATIONS.testnet : CRYPTO_RISK_EXPLANATIONS.mainnet}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="wallet-label">Name</Label>
            <Input id="wallet-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Purchases wallet" />
          </div>
          <div className="space-y-1">
            <Label>Key</Label>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" checked={mode === "generate"} onChange={() => setMode("generate")} />
                Make a new key (recommended)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={mode === "import"} onChange={() => setMode("import")} />
                Import a key I have
              </label>
            </div>
          </div>
          {mode === "import" ? (
            <div className="space-y-1">
              <Label htmlFor="wallet-private-key">Private key</Label>
              <Input
                id="wallet-private-key"
                type="password"
                autoComplete="off"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="Paste the private key, not the recovery words"
              />
              <p className="text-xs text-muted-foreground">{CRYPTO_RISK_EXPLANATIONS.import} After saving, the key cannot be shown again.</p>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            New wallets start with small limits ({DEFAULT_CRYPTO_WALLET_LIMITS[chain].perTransaction} {CRYPTO_CHAIN_INFO[chain].asset} per payment) and an empty
            allowed-address list, so nothing can be sent until you add an address.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!label.trim() || (mode === "import" && !privateKey.trim()) || create.isPending} onClick={() => create.mutate()}>
            {mode === "import" ? "Import wallet" : "Make wallet"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentLimitsEditor({ companyId, agentId }: { companyId: string; agentId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const limitsQuery = useQuery({
    queryKey: queryKeys.cryptoWallets.agentLimits(companyId, agentId),
    queryFn: () => cryptoWalletsApi.agentLimits(companyId, agentId),
  });
  const [draft, setDraft] = useState<CryptoAgentLimits | null>(null);
  const value = draft ?? limitsQuery.data ?? DEFAULT_CRYPTO_AGENT_LIMITS;
  const save = useMutation({
    mutationFn: (input: CryptoAgentLimits) => cryptoWalletsApi.setAgentLimits(companyId, agentId, input),
    onSuccess: () => {
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.cryptoWallets.agentLimits(companyId, agentId) });
      pushToast({ title: "Agent limits saved", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not save the limits", body: errorMessage(error), tone: "error" }),
  });
  const num = (key: keyof CryptoAgentLimits, label: string) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        inputMode="decimal"
        value={value[key] === null ? "" : String(value[key])}
        placeholder={key === "approvalAboveUsd" ? "every payment" : ""}
        onChange={(e) => setDraft({ ...value, [key]: e.target.value === "" && key === "approvalAboveUsd" ? null : Number(e.target.value) })}
      />
    </div>
  );
  return (
    <div className="space-y-2 rounded border border-border p-3">
      <p className="text-sm font-medium">This agent's limits across all its wallets (US dollars)</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {num("perTransactionUsd", "Per payment")}
        {num("dailyUsd", "Per day")}
        {num("totalUsd", "In total")}
        {num("approvalAboveUsd", "Approve from")}
      </div>
      <Button size="sm" disabled={!draft || save.isPending} onClick={() => draft && save.mutate(draft)}>
        Save agent limits
      </Button>
    </div>
  );
}

export function AgentCryptoWalletsSection({ companyId, agentId }: { companyId: string; agentId: string }) {
  const [addOpen, setAddOpen] = useState(false);
  const walletsQuery = useQuery({
    queryKey: queryKeys.cryptoWallets.list(companyId, agentId),
    queryFn: () => cryptoWalletsApi.list(companyId, agentId),
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.cryptoWallets.settings(companyId),
    queryFn: () => cryptoWalletsApi.settings(companyId),
  });
  const wallets = walletsQuery.data ?? [];
  const settings = settingsQuery.data;

  return (
    <div className="space-y-4" data-testid="agent-crypto-wallets">
      <p className="text-sm text-muted-foreground">{CRYPTO_RISK_EXPLANATIONS.overview}</p>
      <p className="text-sm text-muted-foreground">{CRYPTO_RISK_EXPLANATIONS.keys}</p>
      {settings ? (
        <p className="text-sm">
          {settings.allWalletsFrozen
            ? "All crypto wallets in this company are frozen right now."
            : settings.realMoneyLocked
              ? "Real money is switched off on this server (administrator setting)"
              : settings.mainnetEnabled
              ? "Real money is on for this company."
              : "Real money is off for this company: wallets use test networks."}{" "}
          {settings.realMoneyLocked ? null : <span className="text-muted-foreground">Change this on the Trading page.</span>}
        </p>
      ) : null}

      <AgentLimitsEditor companyId={companyId} agentId={agentId} />

      {walletsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading wallets…</p>
      ) : walletsQuery.error ? (
        <p className="text-sm text-destructive">{errorMessage(walletsQuery.error)}</p>
      ) : wallets.length === 0 ? (
        <p className="text-sm text-muted-foreground">This agent has no crypto wallet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {wallets.map((wallet) => (
            <WalletCard key={wallet.id} wallet={wallet} companyId={companyId} />
          ))}
        </ul>
      )}

      <Button size="sm" onClick={() => setAddOpen(true)}>
        Add a wallet
      </Button>

      <AddWalletDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        companyId={companyId}
        agentId={agentId}
        mainnetEnabled={(settings?.mainnetEnabled ?? false) && !settings?.realMoneyLocked}
      />
    </div>
  );
}
