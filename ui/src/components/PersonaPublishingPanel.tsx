import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { personaAccountsApi, type PersonaAccount, type PersonaPost } from "../api/persona-accounts";
import { personasApi, type Persona } from "../api/personas";
import { secretsApi } from "../api/secrets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// DUR-134 (review follow-up): the operator's side of persona publishing --
// the accounts she posts to, the per-account safety settings the 23 August
// decision made mandatory (disclosure, autonomy, daily cap, warm-up), the
// one-click pause switches (persona-wide and per account), and the feed of
// what actually went out. The server already enforced all of this; this
// panel is what makes it reachable without curl.

const DEFAULT_WARMUP_POSTS = 5;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message || fallback;
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}

function platformLabel(platform: string): string {
  if (platform === "fanvue") return "Fanvue";
  return platform;
}

function postStatusLabel(post: PersonaPost): { label: string; tone: "default" | "secondary" | "destructive" | "outline" } {
  switch (post.status) {
    case "published":
      return { label: "Posted", tone: "default" };
    case "pending_approval":
      return { label: "Waiting for your OK", tone: "secondary" };
    case "approved":
      return { label: "Approved, posting soon", tone: "secondary" };
    case "queued":
      return { label: "Queued", tone: "outline" };
    case "publishing":
      return { label: "Posting now", tone: "secondary" };
    case "failed":
      return { label: "Could not post", tone: "destructive" };
    case "rejected":
      return { label: "You said no", tone: "outline" };
    case "cancelled":
      return { label: "Cancelled", tone: "outline" };
    default:
      return { label: post.status, tone: "outline" };
  }
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

export function PersonaPublishingPanel({ persona }: { persona: Persona }) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [connectOpen, setConnectOpen] = useState(false);
  const [credentialFor, setCredentialFor] = useState<PersonaAccount | null>(null);

  const accountsQuery = useQuery({
    queryKey: queryKeys.personas.accounts(persona.id),
    queryFn: () => personaAccountsApi.listForPersona(persona.id),
  });
  const postsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.personas.companyPosts(selectedCompanyId) : ["persona-posts", "__none__"],
    queryFn: () => personaAccountsApi.listCompanyPosts(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.personas.accounts(persona.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.personas.detail(persona.id) });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.personas.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.personas.companyPosts(selectedCompanyId) });
    }
  };

  const pausePersona = useMutation({
    mutationFn: (publishingPaused: boolean) => personasApi.update(persona.id, { publishingPaused }),
    onSuccess: (_, publishingPaused) => {
      invalidate();
      pushToast({
        title: publishingPaused ? "Publishing paused" : "Publishing resumed",
        body: publishingPaused
          ? `${persona.displayName} will not post anywhere until you switch this back on.`
          : `${persona.displayName} can post again, within her limits.`,
        tone: "success",
      });
    },
    onError: (error) => pushToast({ title: "Could not change the pause switch", body: errorMessage(error, ""), tone: "error" }),
  });

  const pauseAccount = useMutation({
    mutationFn: ({ accountId, publishingPaused }: { accountId: string; publishingPaused: boolean }) =>
      personaAccountsApi.update(accountId, { publishingPaused }),
    onSuccess: invalidate,
    onError: (error) => pushToast({ title: "Could not change the pause switch", body: errorMessage(error, ""), tone: "error" }),
  });

  const accounts = accountsQuery.data ?? [];
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const posts = (postsQuery.data ?? [])
    .filter((post) => post.personaId === persona.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 20);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Publishing</h2>
            <p className="text-sm text-muted-foreground">
              Where she posts, how much, and whether she needs your OK first.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{persona.publishingPaused ? "Paused" : "Allowed"}</span>
            <ToggleSwitch
              checked={!persona.publishingPaused}
              onCheckedChange={(allowed) => pausePersona.mutate(!allowed)}
              disabled={pausePersona.isPending}
              aria-label={persona.publishingPaused ? "Resume publishing" : "Pause all publishing for this persona"}
            />
          </div>
        </div>
        {persona.publishingPaused ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
            Everything is on hold. Nothing goes out on any of her accounts until you switch this back on.
          </p>
        ) : null}

        {accountsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No accounts connected yet. She cannot post anywhere until you connect one.
          </p>
        ) : (
          <div className="space-y-2">
            {accounts.map((account) => {
              const warmingUp = account.publishedPostCount < account.warmupPostsRequired;
              const remaining = Math.max(0, account.warmupPostsRequired - account.publishedPostCount);
              return (
                <div key={account.id} className="rounded-lg border px-3.5 py-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{account.accountLabel}</span>
                        <Badge variant="outline">{platformLabel(account.platform)}</Badge>
                        {account.publishingPaused ? <Badge variant="secondary">Paused</Badge> : null}
                      </div>
                      <p className="text-muted-foreground">
                        Up to {account.dailyPostCap} post{account.dailyPostCap === 1 ? "" : "s"} a day.{" "}
                        {account.autonomyMode === "autonomous"
                          ? warmingUp
                            ? `Her first ${account.warmupPostsRequired} posts here need your OK (${remaining} to go), then she posts on her own.`
                            : "Posts on her own."
                          : "Every post needs your OK first."}{" "}
                        {account.aiDisclosureEnabled
                          ? "Each post says it was made with AI."
                          : "Posts do not say they were made with AI."}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {account.publishedPostCount} posted so far
                        {account.connectionStatus !== "connected" ? " · credential not confirmed yet" : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{account.publishingPaused ? "Paused" : "Allowed"}</span>
                        <ToggleSwitch
                          checked={!account.publishingPaused}
                          onCheckedChange={(allowed) =>
                            pauseAccount.mutate({ accountId: account.id, publishingPaused: !allowed })
                          }
                          disabled={pauseAccount.isPending}
                          aria-label={
                            account.publishingPaused
                              ? `Resume publishing to ${account.accountLabel}`
                              : `Pause publishing to ${account.accountLabel}`
                          }
                        />
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={() => setCredentialFor(account)}>
                        Set login key
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <Button type="button" variant="outline" size="sm" onClick={() => setConnectOpen(true)}>
          <Plus className="mr-1 h-4 w-4" />
          Connect an account
        </Button>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">What went out</h2>
        {postsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : posts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="space-y-2">
            {posts.map((post) => {
              const status = postStatusLabel(post);
              const account = accountById.get(post.personaAccountId);
              return (
                <li key={post.id} className="rounded-lg border px-3.5 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={status.tone}>{status.label}</Badge>
                    {account ? <span className="text-xs text-muted-foreground">{account.accountLabel}</span> : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {formatWhen(post.publishedAt ?? post.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap">{post.caption}</p>
                  {post.disclosureText ? (
                    <p className="mt-1 text-xs text-muted-foreground">AI disclosure shown: “{post.disclosureText}”</p>
                  ) : null}
                  {post.failureReason ? (
                    <p className="mt-1 text-xs text-destructive">{post.failureReason}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConnectAccountDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        persona={persona}
        onCreated={invalidate}
      />
      <SetCredentialDialog
        account={credentialFor}
        onOpenChange={(open) => !open && setCredentialFor(null)}
        onDone={invalidate}
      />
    </div>
  );
}

function ConnectAccountDialog({
  open,
  onOpenChange,
  persona,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  persona: Persona;
  onCreated: () => void;
}) {
  const { pushToast } = useToastActions();
  const [accountLabel, setAccountLabel] = useState(`${persona.displayName} — Fanvue`);
  const [externalAccountId, setExternalAccountId] = useState("");
  const [autonomyMode, setAutonomyMode] = useState<"autonomous" | "requires_approval">("requires_approval");
  const [aiDisclosureEnabled, setAiDisclosureEnabled] = useState(true);
  const [dailyPostCap, setDailyPostCap] = useState("");

  const cap = Number.parseInt(dailyPostCap, 10);
  const canSubmit = accountLabel.trim().length > 0 && externalAccountId.trim().length > 0 && Number.isInteger(cap) && cap > 0;

  const create = useMutation({
    mutationFn: () =>
      personaAccountsApi.create(persona.id, {
        platform: "fanvue",
        accountLabel: accountLabel.trim(),
        externalAccountId: externalAccountId.trim(),
        aiDisclosureEnabled,
        autonomyMode,
        dailyPostCap: cap,
      }),
    onSuccess: () => {
      onCreated();
      onOpenChange(false);
      setExternalAccountId("");
      setDailyPostCap("");
      pushToast({
        title: "Account connected",
        body: "Next, set its login key so she can actually post there.",
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({ title: "Could not connect the account", body: errorMessage(error, ""), tone: "error" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect a Fanvue account</DialogTitle>
          <DialogDescription>
            These settings are per account and there are no defaults: you decide the daily limit and whether she
            needs your OK. Her first {DEFAULT_WARMUP_POSTS} posts on any new account always need your OK.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="persona-account-label">Name for this account</Label>
            <Input
              id="persona-account-label"
              value={accountLabel}
              onChange={(event) => setAccountLabel(event.target.value)}
              placeholder="Maja — Fanvue"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="persona-account-external-id">Fanvue creator id</Label>
            <Input
              id="persona-account-external-id"
              value={externalAccountId}
              onChange={(event) => setExternalAccountId(event.target.value)}
              placeholder="The id Fanvue shows for the creator account"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="persona-account-cap">Posts per day (required)</Label>
            <Input
              id="persona-account-cap"
              type="number"
              min={1}
              inputMode="numeric"
              value={dailyPostCap}
              onChange={(event) => setDailyPostCap(event.target.value)}
              placeholder="e.g. 3"
            />
            <p className="text-xs text-muted-foreground">A hard limit. She can never post more than this in one day here.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Who decides each post</Label>
            <Select value={autonomyMode} onValueChange={(value) => setAutonomyMode(value as typeof autonomyMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="requires_approval">Every post needs my OK</SelectItem>
                <SelectItem value="autonomous">She posts on her own (after the first {DEFAULT_WARMUP_POSTS})</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <div>
              <p className="text-sm font-medium">Say each post was made with AI</p>
              <p className="text-xs text-muted-foreground">
                Fanvue requires this for AI-made content. Switching it off risks action from Fanvue.
              </p>
            </div>
            <ToggleSwitch checked={aiDisclosureEnabled} onCheckedChange={setAiDisclosureEnabled} aria-label="AI disclosure" />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => create.mutate()} disabled={!canSubmit || create.isPending}>
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SetCredentialDialog({
  account,
  onOpenChange,
  onDone,
}: {
  account: PersonaAccount | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToastActions();
  const [secretId, setSecretId] = useState("");
  const open = account !== null;

  const secretsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "__none__"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && open,
  });

  const connect = useMutation({
    mutationFn: () => personaAccountsApi.connectCredential(account!.id, secretId),
    onSuccess: () => {
      onDone();
      onOpenChange(false);
      setSecretId("");
      pushToast({ title: "Login key set", body: "She can post to this account now, within its limits.", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not set the login key", body: errorMessage(error, ""), tone: "error" }),
  });

  const secrets = secretsQuery.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Login key for {account?.accountLabel ?? "this account"}</DialogTitle>
          <DialogDescription>
            Pick the saved secret that holds the Fanvue access token. Only the publisher ever reads it; she never
            sees it. Save the token under Secrets first if it is not in the list.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Saved secret</Label>
          <Select value={secretId} onValueChange={setSecretId}>
            <SelectTrigger>
              <SelectValue placeholder={secretsQuery.isLoading ? "Loading…" : "Choose a secret"} />
            </SelectTrigger>
            <SelectContent>
              {secrets.map((secret) => (
                <SelectItem key={secret.id} value={secret.id}>
                  {secret.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!secretsQuery.isLoading && secrets.length === 0 ? (
            <p className="text-xs text-muted-foreground">No saved secrets in this company yet.</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => connect.mutate()} disabled={!secretId || connect.isPending}>
            Use this key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
