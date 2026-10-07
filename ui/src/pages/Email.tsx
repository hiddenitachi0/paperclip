import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, ArrowLeft, Check, Mail, Reply, Search, Send, Sparkles, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import type { CompanySecret, MailMessageFolder, MailUrgencyFeedback } from "@paperclipai/shared";
import { MAIL_MESSAGE_FOLDERS } from "@paperclipai/shared";
import type { MailAccountSummary, MailMessageSummary } from "../types/mail";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { mailApi } from "../api/mail";
import { emailSettingsApi } from "../api/emailSettings";
import { secretsApi } from "../api/secrets";
import { authApi } from "../api/auth";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";

/**
 * DUR-4195: the email client UI. Reads/sends through the per-person mailbox
 * API from DUR-4194 -- a mailbox belongs to one human, never to the company,
 * so this page only ever shows accounts the signed-in person owns or is the
 * assigned PA agent for (server/src/services/mail-accounts.ts). Drafts can
 * come from a PA agent ("aiDrafted"), but only a human (board actor) can
 * press Send -- the server refuses an agent credential on the send route,
 * this UI just reflects that split.
 *
 * Ships behind a company-scoped switch, off by default (DUR-4277).
 */

const FOLDER_LABELS: Record<MailMessageFolder, string> = {
  inbox: "Inbox",
  drafts: "Drafts",
  sent: "Sent",
  archive: "Archive",
  trash: "Trash",
};

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function initialsOf(address: string): string {
  const name = address.split("@")[0] ?? address;
  return name.slice(0, 2).toUpperCase();
}

interface ComposeState {
  mode: "new" | "reply" | "edit";
  draftId: string | null;
  inReplyToMessageId: string | null;
  to: string;
  cc: string;
  subject: string;
  bodyText: string;
}

function emptyCompose(): ComposeState {
  return { mode: "new", draftId: null, inReplyToMessageId: null, to: "", cc: "", subject: "", bodyText: "" };
}

function parseAddressList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

type MailProviderId = "gmail" | "outlook" | "domeneshop" | "other";

interface MailProviderPreset {
  label: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  /** true = encrypted from the first byte (port 465); false = upgrades the connection (port 587). */
  smtpSecure: boolean;
  /** Short plain-language steps for getting the app password, shown once a provider is chosen. */
  steps: string[];
  helpUrl?: string;
  helpLabel?: string;
}

export const MAIL_PROVIDER_PRESETS: Record<MailProviderId, MailProviderPreset> = {
  gmail: {
    label: "Gmail",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecure: true,
    steps: [
      "Turn on 2-Step Verification for your Google account (Gmail won't give out app passwords without it).",
      "Open the app passwords page and create one. Name it anything, for example \"Paperclip\".",
      "Copy the 16-letter password Google shows you and paste it below. The spaces are removed for you.",
    ],
    helpUrl: "https://myaccount.google.com/apppasswords",
    helpLabel: "Open Google app passwords",
  },
  outlook: {
    label: "Outlook / Microsoft 365",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecure: false,
    steps: [
      "Sign in to your Microsoft account and open its security settings.",
      "Turn on two-step verification, then create an app password.",
      "Paste that app password below. If your work account blocks app passwords, ask your IT person to allow them.",
    ],
    helpUrl: "https://account.microsoft.com/security",
    helpLabel: "Open Microsoft security settings",
  },
  domeneshop: {
    label: "Domeneshop",
    imapHost: "imap.domeneshop.no",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.domeneshop.no",
    smtpPort: 587,
    smtpSecure: false,
    steps: [
      "Domeneshop uses the normal password for your email address, not a separate app password.",
      "Use your full email address as the username, and paste the email password below.",
    ],
  },
  other: {
    label: "Other",
    imapHost: "",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "",
    smtpPort: 587,
    smtpSecure: false,
    steps: ["Ask your email provider for the incoming (IMAP) and outgoing (SMTP) server names, then fill them in below."],
  },
};

function portNote(port: number, secure: boolean) {
  return `Port ${port}, ${secure ? "SSL" : "STARTTLS"}`;
}

function AddMailboxForm({ companyId, ownerUserId }: { companyId: string; ownerUserId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [provider, setProvider] = useState<MailProviderId>("other");
  const preset = MAIL_PROVIDER_PRESETS[provider];
  const [displayName, setDisplayName] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapUsername, setImapUsername] = useState("");
  const [imapCredentialSecretId, setImapCredentialSecretId] = useState<string>("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpCredentialSecretId, setSmtpCredentialSecretId] = useState<string>("");
  const [separateSendPassword, setSeparateSendPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  const secretsQuery = useQuery({
    queryKey: ["secrets", companyId],
    queryFn: () => secretsApi.list(companyId),
  });
  const secrets = secretsQuery.data ?? [];
  // Radix's Select mirrors its value onto a hidden native <select> for form semantics; if the
  // value doesn't match a mounted <SelectItem> yet (e.g. a just-saved secret the list hasn't
  // refetched), that sync fires onValueChange("") and silently clobbers the id. Only hand Radix
  // a value once a matching item exists; the real id lives in imap/smtpCredentialSecretId and is
  // what actually gets submitted.
  const imapSelectValue = secrets.some((secret) => secret.id === imapCredentialSecretId) ? imapCredentialSecretId : "";
  const smtpSelectValue = secrets.some((secret) => secret.id === smtpCredentialSecretId) ? smtpCredentialSecretId : "";

  function chooseProvider(next: MailProviderId) {
    const chosen = MAIL_PROVIDER_PRESETS[next];
    setProvider(next);
    setImapHost(chosen.imapHost);
    setSmtpHost(chosen.smtpHost);
  }

  const savePassword = useMutation({
    mutationFn: () => {
      const label = emailAddress.trim() || preset.label;
      // App passwords are often pasted with spaces in them; the mail servers want none.
      return secretsApi.create(companyId, {
        name: `Email password (${label}) ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
        value: newPassword.replace(/\s+/g, ""),
      });
    },
    onSuccess: (secret) => {
      // Put the new secret in the cache before selecting it: invalidateQueries alone
      // can resolve a render after the Select has already dropped an id with no matching item.
      queryClient.setQueryData<CompanySecret[]>(["secrets", companyId], (old) =>
        old ? [...old, secret] : [secret],
      );
      setImapCredentialSecretId(secret.id);
      setNewPassword("");
      pushToast({ title: "Password saved", tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["secrets", companyId] });
    },
    onError: (error) =>
      pushToast({ title: "Could not save that password", body: errorMessage(error, "Try again in a moment."), tone: "error" }),
  });

  const createAccount = useMutation({
    mutationFn: () =>
      mailApi.createAccount(companyId, {
        ownerUserId,
        paAgentId: null,
        displayName: displayName.trim(),
        emailAddress: emailAddress.trim(),
        imapHost: imapHost.trim(),
        imapPort: preset.imapPort,
        imapSecure: preset.imapSecure,
        imapUsername: imapUsername.trim() || emailAddress.trim(),
        imapMailbox: "INBOX",
        imapCredentialSecretId: imapCredentialSecretId || null,
        smtpHost: smtpHost.trim(),
        smtpPort: preset.smtpPort,
        smtpSecure: preset.smtpSecure,
        smtpUsername: smtpUsername.trim() || emailAddress.trim(),
        // One password for reading and sending unless the person asks for a separate one.
        smtpCredentialSecretId: (separateSendPassword ? smtpCredentialSecretId : imapCredentialSecretId) || null,
        enabled: true,
        checkEveryMinutes: 5,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.email.accounts(companyId) });
      pushToast({ title: "Mailbox added", tone: "success" });
    },
    onError: (error) =>
      pushToast({ title: "Could not add that mailbox", body: errorMessage(error, "Check the details and try again."), tone: "error" }),
  });

  const secretOptions = (
    <SelectContent>
      {secrets.map((secret) => (
        <SelectItem key={secret.id} value={secret.id}>
          {secret.name}
        </SelectItem>
      ))}
    </SelectContent>
  );

  return (
    <div className="mx-auto max-w-xl space-y-6 py-8">
      <div>
        <h1 className="text-lg font-semibold">Connect your mailbox</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick your email provider and we'll fill in the server details. This mailbox is yours alone -- nobody else at
          the company, including an owner or admin, can read your messages without a logged, visible reason.
        </p>
      </div>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          createAccount.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="mailbox-provider">Who provides your email?</Label>
          <Select value={provider} onValueChange={(value) => chooseProvider(value as MailProviderId)}>
            <SelectTrigger id="mailbox-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(MAIL_PROVIDER_PRESETS) as MailProviderId[]).map((id) => (
                <SelectItem key={id} value={id}>
                  {MAIL_PROVIDER_PRESETS[id].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-sm" data-testid="mail-provider-help">
          <p className="font-medium">{provider === "other" ? "Server details" : `Getting your ${preset.label} password`}</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            {preset.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {preset.helpUrl ? (
            <a
              className="inline-block text-sm underline underline-offset-2"
              href={preset.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {preset.helpLabel}
            </a>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mailbox-name">Name for this mailbox</Label>
          <Input id="mailbox-name" placeholder="My inbox" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mailbox-email">Email address</Label>
          <Input
            id="mailbox-email"
            type="email"
            placeholder="you@example.com"
            value={emailAddress}
            onChange={(e) => setEmailAddress(e.target.value)}
            required
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="imap-host">Incoming mail server (IMAP)</Label>
            <Input id="imap-host" placeholder="imap.example.com" value={imapHost} onChange={(e) => setImapHost(e.target.value)} required />
            <p className="text-xs text-muted-foreground">{portNote(preset.imapPort, preset.imapSecure)}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="imap-user">Username</Label>
            <Input id="imap-user" placeholder="Defaults to your email address" value={imapUsername} onChange={(e) => setImapUsername(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="smtp-host">Outgoing mail server (SMTP)</Label>
            <Input id="smtp-host" placeholder="smtp.example.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} required />
            <p className="text-xs text-muted-foreground">{portNote(preset.smtpPort, preset.smtpSecure)}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-user">Sending username</Label>
            <Input id="smtp-user" placeholder="Defaults to your email address" value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Password</Label>
          <Select value={imapSelectValue} onValueChange={setImapCredentialSecretId}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a saved password" />
            </SelectTrigger>
            {secretOptions}
          </Select>
          <p className="text-xs text-muted-foreground">This one password is used for reading and for sending.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mailbox-new-password">Or save a new password now</Label>
          <div className="flex gap-2">
            <Input
              id="mailbox-new-password"
              type="password"
              autoComplete="off"
              placeholder="Paste your app password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={savePassword.isPending || !newPassword.replace(/\s+/g, "")}
              onClick={() => savePassword.mutate()}
            >
              {savePassword.isPending ? "Saving…" : "Save password"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            It's stored safely and never shown again. You can also manage saved passwords in{" "}
            <Link to="/company/settings/secrets">settings</Link>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            id="mailbox-separate-password"
            type="checkbox"
            checked={separateSendPassword}
            onChange={(e) => setSeparateSendPassword(e.target.checked)}
          />
          <Label htmlFor="mailbox-separate-password">Use a different password for sending</Label>
        </div>
        {separateSendPassword ? (
          <div className="space-y-1.5">
            <Label>Password for sending</Label>
            <Select value={smtpSelectValue} onValueChange={setSmtpCredentialSecretId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a saved password" />
              </SelectTrigger>
              {secretOptions}
            </Select>
          </div>
        ) : null}
        <Button type="submit" disabled={createAccount.isPending || !displayName.trim() || !emailAddress.trim() || !imapHost.trim() || !smtpHost.trim()}>
          {createAccount.isPending ? "Connecting…" : "Connect mailbox"}
        </Button>
      </form>
    </div>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
  person: "A person",
  customer: "Customer",
  supplier: "Supplier",
  "bank-payment": "Bank or payment",
  authority: "Authority",
  newsletter: "Newsletter",
  receipt: "Receipt",
  notification: "Notification",
  other: "Other",
};

function UrgencyPanel({
  urgency,
  onFeedback,
  pending,
}: {
  urgency: NonNullable<MailMessageSummary["urgency"]>;
  onFeedback: (feedback: MailUrgencyFeedback | null) => void;
  pending: boolean;
}) {
  const feedback = urgency.operatorFeedback ?? null;
  const toggle = (next: MailUrgencyFeedback) => onFeedback(feedback === next ? null : next);
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-4 text-sm" data-testid="mail-urgency-panel">
      <div className="flex flex-wrap items-center gap-2">
        {urgency.urgent ? (
          <Badge variant="outline" className="gap-1 border-red-500/50 text-red-600 dark:text-red-400">
            <AlertTriangle className="h-3 w-3" /> Urgent
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1">
            <Check className="h-3 w-3" /> Not urgent
          </Badge>
        )}
        <Badge variant="secondary">{CATEGORY_LABELS[urgency.category] ?? "Other"}</Badge>
      </div>
      {urgency.summary ? <p>{urgency.summary}</p> : null}
      {urgency.reason ? (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">Why: </span>
          {urgency.reason}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="text-xs text-muted-foreground">Was this call right?</span>
        <Button
          size="sm"
          variant={feedback === "correct" ? "default" : "outline"}
          aria-pressed={feedback === "correct"}
          disabled={pending}
          onClick={() => toggle("correct")}
        >
          <ThumbsUp className="mr-1.5 h-3.5 w-3.5" /> Right
        </Button>
        <Button
          size="sm"
          variant={feedback === "incorrect" ? "default" : "outline"}
          aria-pressed={feedback === "incorrect"}
          disabled={pending}
          onClick={() => toggle("incorrect")}
        >
          <ThumbsDown className="mr-1.5 h-3.5 w-3.5" /> Wrong
        </Button>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  selected,
  onSelect,
}: {
  message: MailMessageSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const counterparty = message.direction === "inbound" ? message.fromAddress : message.toAddresses.join(", ") || "(no recipient)";
  const preview = (message.subject || "(no subject)") + " — " + message.bodyText.slice(0, 80).replace(/\s+/g, " ");
  const when = message.receivedAt ?? message.sentAt ?? message.createdAt;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/50 ${
          selected ? "bg-muted" : ""
        }`}
        data-testid="mail-message-row"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
          {initialsOf(counterparty)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`truncate text-sm ${!message.isRead && message.direction === "inbound" ? "font-semibold" : "font-medium"}`}>
              {counterparty}
            </span>
            {message.urgency?.urgent ? (
              <Badge variant="outline" className="shrink-0 gap-1 border-red-500/50 text-[10px] text-red-600 dark:text-red-400">
                <AlertTriangle className="h-3 w-3" /> Urgent
              </Badge>
            ) : null}
            {message.aiDrafted ? (
              <Badge variant="outline" className="shrink-0 gap-1 text-[10px]">
                <Sparkles className="h-3 w-3" /> AI draft
              </Badge>
            ) : null}
          </div>
          <p className="truncate text-sm text-muted-foreground">{preview}</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{when ? timeAgo(when) : ""}</span>
      </button>
    </li>
  );
}

export function Email() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const role = useCompanyRole(selectedCompanyId);

  const [folder, setFolder] = useState<MailMessageFolder>("inbox");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [compose, setCompose] = useState<ComposeState | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Email" }]);
  }, [setBreadcrumbs]);

  const sessionQuery = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const currentUserId = sessionQuery.data?.user?.id ?? null;

  const settingsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.email.settings(selectedCompanyId) : ["email", "__none__"],
    queryFn: () => emailSettingsApi.getSettings(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const enabled = settingsQuery.data?.enabled === true;

  const toggleEnabled = useMutation({
    mutationFn: (next: boolean) => emailSettingsApi.setEnabled(selectedCompanyId!, next),
    onSuccess: (settings) => {
      if (selectedCompanyId) queryClient.setQueryData(queryKeys.email.settings(selectedCompanyId), settings);
      pushToast({ title: settings.enabled ? "Email turned on" : "Email turned off", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not change that setting", body: errorMessage(error, ""), tone: "error" }),
  });

  const accountsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.email.accounts(selectedCompanyId) : ["email", "__none__"],
    queryFn: () => mailApi.listAccounts(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && enabled,
  });
  const accounts = accountsQuery.data ?? [];

  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0]!.id);
  }, [accounts, accountId]);

  const activeAccount: MailAccountSummary | null = accounts.find((a) => a.id === accountId) ?? null;

  const messagesQuery = useQuery({
    queryKey: selectedCompanyId && accountId ? queryKeys.email.messages(selectedCompanyId, accountId, folder) : ["email", "__none__"],
    queryFn: () => mailApi.listMessages(selectedCompanyId!, accountId!, folder),
    enabled: Boolean(selectedCompanyId) && Boolean(accountId) && !searchQuery,
  });
  const searchResultsQuery = useQuery({
    queryKey: selectedCompanyId && accountId ? queryKeys.email.search(selectedCompanyId, accountId, searchQuery) : ["email", "__none__"],
    queryFn: () => mailApi.searchMessages(selectedCompanyId!, accountId!, searchQuery),
    enabled: Boolean(selectedCompanyId) && Boolean(accountId) && Boolean(searchQuery),
  });
  const listQuery = searchQuery ? searchResultsQuery : messagesQuery;
  const messages = listQuery.data ?? [];

  const selectedMessage = messages.find((m) => m.id === selectedMessageId) ?? null;

  // Reply drafts the assistant wrote for this mailbox, so a message can offer "Review draft reply".
  const draftsQuery = useQuery({
    queryKey: selectedCompanyId && accountId ? queryKeys.email.messages(selectedCompanyId, accountId, "drafts") : ["email", "__none__"],
    queryFn: () => mailApi.listMessages(selectedCompanyId!, accountId!, "drafts"),
    enabled: Boolean(selectedCompanyId) && Boolean(accountId) && Boolean(selectedMessage?.urgency),
  });
  const linkedAiDraft =
    selectedMessage && !selectedMessage.isDraft
      ? (draftsQuery.data ?? []).find((d) => d.aiDrafted && d.inReplyToMessageId === selectedMessage.id) ?? null
      : null;

  const invalidateMessages = () => {
    if (selectedCompanyId && accountId) {
      queryClient.invalidateQueries({ queryKey: ["email", "messages", selectedCompanyId, accountId] });
      queryClient.invalidateQueries({ queryKey: ["email", "search", selectedCompanyId, accountId] });
    }
  };

  const feedbackMutation = useMutation({
    mutationFn: ({ messageId, feedback }: { messageId: string; feedback: MailUrgencyFeedback | null }) =>
      mailApi.setUrgencyFeedback(selectedCompanyId!, accountId!, messageId, feedback),
    onSuccess: invalidateMessages,
    onError: (error) => pushToast({ title: "Could not save your answer", body: errorMessage(error, ""), tone: "error" }),
  });

  const archiveMutation = useMutation({
    mutationFn: (messageId: string) => mailApi.archiveMessage(selectedCompanyId!, accountId!, messageId),
    onSuccess: () => {
      invalidateMessages();
      setSelectedMessageId(null);
      pushToast({ title: "Moved to archive", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not archive that message", body: errorMessage(error, ""), tone: "error" }),
  });

  const moveMutation = useMutation({
    mutationFn: ({ messageId, to }: { messageId: string; to: MailMessageFolder }) =>
      mailApi.moveMessage(selectedCompanyId!, accountId!, messageId, { folder: to }),
    onSuccess: () => {
      invalidateMessages();
      setSelectedMessageId(null);
      pushToast({ title: "Message moved", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not move that message", body: errorMessage(error, ""), tone: "error" }),
  });

  const saveDraft = useMutation({
    mutationFn: (state: ComposeState) => {
      const input = {
        toAddresses: parseAddressList(state.to),
        ccAddresses: parseAddressList(state.cc),
        subject: state.subject,
        bodyText: state.bodyText,
        bodyHtml: null,
        aiDrafted: false,
      };
      if (state.draftId) {
        return mailApi.updateDraft(selectedCompanyId!, accountId!, state.draftId, input);
      }
      return mailApi.createDraft(selectedCompanyId!, accountId!, {
        ...input,
        inReplyToMessageId: state.inReplyToMessageId,
      });
    },
    onSuccess: () => {
      invalidateMessages();
      setCompose(null);
      pushToast({ title: "Draft saved", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not save that draft", body: errorMessage(error, ""), tone: "error" }),
  });

  const sendDraft = useMutation({
    mutationFn: async (state: ComposeState) => {
      const input = {
        toAddresses: parseAddressList(state.to),
        ccAddresses: parseAddressList(state.cc),
        subject: state.subject,
        bodyText: state.bodyText,
        bodyHtml: null,
        aiDrafted: false,
      };
      const draft = state.draftId
        ? await mailApi.updateDraft(selectedCompanyId!, accountId!, state.draftId, input)
        : await mailApi.createDraft(selectedCompanyId!, accountId!, { ...input, inReplyToMessageId: state.inReplyToMessageId });
      return mailApi.sendDraft(selectedCompanyId!, accountId!, draft.id);
    },
    onSuccess: () => {
      invalidateMessages();
      setCompose(null);
      pushToast({ title: "Message sent", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not send that message", body: errorMessage(error, "Check the recipients and try again."), tone: "error" }),
  });

  if (settingsQuery.isLoading) {
    return <PageSkeleton variant="inbox" />;
  }

  if (!enabled) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="text-lg font-semibold">Email</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A private inbox for each person -- read, search, and reply to your own email from inside Paperclip. An
            assistant can draft replies for you, but only you can press Send.
          </p>
        </div>
        <EmptyState
          icon={Mail}
          message={
            role.canManageConnections
              ? "This isn't turned on yet. Turn it on to connect your mailbox."
              : "This isn't turned on yet. Ask a company owner or admin to turn it on."
          }
          action={role.canManageConnections ? "Turn on email" : undefined}
          onAction={role.canManageConnections ? () => toggleEnabled.mutate(true) : undefined}
        />
      </div>
    );
  }

  if (accountsQuery.isLoading || sessionQuery.isLoading) {
    return <PageSkeleton variant="inbox" />;
  }

  if (accounts.length === 0) {
    return currentUserId ? (
      <div>
        {role.canManageConnections ? (
          <div className="mx-auto flex max-w-xl items-center justify-end gap-2 pt-4">
            <span className="text-sm text-muted-foreground">Email is on</span>
            <ToggleSwitch aria-label="Turn off email" checked={enabled} onCheckedChange={(next) => toggleEnabled.mutate(next)} />
          </div>
        ) : null}
        <AddMailboxForm companyId={selectedCompanyId!} ownerUserId={currentUserId} />
      </div>
    ) : (
      <PageSkeleton variant="inbox" />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="shrink-0 text-lg font-semibold">Email</h1>
          {accounts.length > 1 ? (
            <Select value={accountId ?? undefined} onValueChange={(value) => { setAccountId(value); setSelectedMessageId(null); }}>
              <SelectTrigger className="h-8 w-[220px]">
                <SelectValue placeholder="Choose a mailbox" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.displayName} ({account.emailAddress})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="truncate text-sm text-muted-foreground">{activeAccount?.emailAddress}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              setSearchQuery(searchInput.trim());
            }}
          >
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search this mailbox"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-8 w-56"
              aria-label="Search mail"
            />
          </form>
          <Button size="sm" onClick={() => setCompose({ ...emptyCompose(), mode: "new" })}>
            Compose
          </Button>
          {role.canManageConnections ? (
            <ToggleSwitch aria-label="Turn off email" checked={enabled} onCheckedChange={(next) => toggleEnabled.mutate(next)} />
          ) : null}
        </div>
      </div>

      {!searchQuery ? (
        <Tabs value={folder} onValueChange={(value) => { setFolder(value as MailMessageFolder); setSelectedMessageId(null); }} className="shrink-0 border-b border-border px-4">
          <TabsList variant="line" className="p-0">
            {MAIL_MESSAGE_FOLDERS.map((f) => (
              <TabsTrigger key={f} value={f} className="px-3">
                {FOLDER_LABELS[f]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : (
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2 text-sm text-muted-foreground">
          <span>
            Search results for "{searchQuery}" ({messages.length})
          </span>
          <Button variant="ghost" size="sm" onClick={() => { setSearchQuery(""); setSearchInput(""); }}>
            Clear search
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="w-[380px] shrink-0 overflow-y-auto border-r border-border">
          {listQuery.isLoading ? (
            <PageSkeleton variant="list" />
          ) : listQuery.error ? (
            <div className="p-4 text-sm text-destructive">{errorMessage(listQuery.error, "Could not load messages.")}</div>
          ) : messages.length === 0 ? (
            <EmptyState icon={Mail} message={searchQuery ? "No messages match that search." : "Nothing here yet."} />
          ) : (
            <ul>
              {messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  selected={message.id === selectedMessageId}
                  onSelect={() => {
                    setCompose(null);
                    setSelectedMessageId(message.id);
                  }}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {compose ? (
            <div className="mx-auto max-w-2xl space-y-4 p-6">
              <Button variant="ghost" size="sm" onClick={() => setCompose(null)}>
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                Back
              </Button>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="compose-to">To</Label>
                  <Input id="compose-to" value={compose.to} onChange={(e) => setCompose({ ...compose, to: e.target.value })} placeholder="name@example.com, another@example.com" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="compose-cc">Cc</Label>
                  <Input id="compose-cc" value={compose.cc} onChange={(e) => setCompose({ ...compose, cc: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="compose-subject">Subject</Label>
                  <Input id="compose-subject" value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="compose-body">Message</Label>
                  <Textarea id="compose-body" rows={12} value={compose.bodyText} onChange={(e) => setCompose({ ...compose, bodyText: e.target.value })} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={() => sendDraft.mutate(compose)} disabled={sendDraft.isPending || parseAddressList(compose.to).length === 0}>
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  {sendDraft.isPending ? "Sending…" : "Send"}
                </Button>
                <Button variant="outline" onClick={() => saveDraft.mutate(compose)} disabled={saveDraft.isPending}>
                  Save draft
                </Button>
              </div>
            </div>
          ) : selectedMessage ? (
            <div className="mx-auto max-w-2xl space-y-4 p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold">{selectedMessage.subject || "(no subject)"}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    From {selectedMessage.fromAddress} to {selectedMessage.toAddresses.join(", ")}
                    {selectedMessage.ccAddresses.length > 0 ? `, cc ${selectedMessage.ccAddresses.join(", ")}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {(selectedMessage.receivedAt ?? selectedMessage.sentAt) ? timeAgo((selectedMessage.receivedAt ?? selectedMessage.sentAt)!) : ""}
                  </p>
                </div>
                {selectedMessage.aiDrafted ? (
                  <Badge variant="outline" className="shrink-0 gap-1">
                    <Sparkles className="h-3 w-3" /> AI draft
                  </Badge>
                ) : null}
              </div>

              {selectedMessage.urgency ? (
                <UrgencyPanel
                  urgency={selectedMessage.urgency}
                  pending={feedbackMutation.isPending}
                  onFeedback={(feedback) => feedbackMutation.mutate({ messageId: selectedMessage.id, feedback })}
                />
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                {linkedAiDraft ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      setCompose({
                        mode: "edit",
                        draftId: linkedAiDraft.id,
                        inReplyToMessageId: linkedAiDraft.inReplyToMessageId,
                        to: linkedAiDraft.toAddresses.join(", "),
                        cc: linkedAiDraft.ccAddresses.join(", "),
                        subject: linkedAiDraft.subject,
                        bodyText: linkedAiDraft.bodyText,
                      })
                    }
                  >
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                    Review draft reply
                  </Button>
                ) : null}
                {selectedMessage.isDraft ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      setCompose({
                        mode: "edit",
                        draftId: selectedMessage.id,
                        inReplyToMessageId: selectedMessage.inReplyToMessageId,
                        to: selectedMessage.toAddresses.join(", "),
                        cc: selectedMessage.ccAddresses.join(", "),
                        subject: selectedMessage.subject,
                        bodyText: selectedMessage.bodyText,
                      })
                    }
                  >
                    Edit draft
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() =>
                      setCompose({
                        mode: "reply",
                        draftId: null,
                        inReplyToMessageId: selectedMessage.id,
                        to: selectedMessage.fromAddress,
                        cc: "",
                        subject: selectedMessage.subject.startsWith("Re:") ? selectedMessage.subject : `Re: ${selectedMessage.subject}`,
                        bodyText: "",
                      })
                    }
                  >
                    <Reply className="mr-1.5 h-3.5 w-3.5" />
                    Reply
                  </Button>
                )}
                {folder !== "archive" && folder !== "trash" ? (
                  <Button variant="outline" size="sm" onClick={() => archiveMutation.mutate(selectedMessage.id)} disabled={archiveMutation.isPending}>
                    <Archive className="mr-1.5 h-3.5 w-3.5" />
                    Archive
                  </Button>
                ) : null}
                {folder !== "trash" ? (
                  <Button variant="outline" size="sm" onClick={() => moveMutation.mutate({ messageId: selectedMessage.id, to: "trash" })} disabled={moveMutation.isPending}>
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Delete
                  </Button>
                ) : null}
              </div>

              <div className="whitespace-pre-wrap rounded-lg border border-border p-4 text-sm">{selectedMessage.bodyText || "(empty message)"}</div>
            </div>
          ) : (
            <EmptyState icon={Mail} message="Pick a message to read it here." />
          )}
        </div>
      </div>
    </div>
  );
}
