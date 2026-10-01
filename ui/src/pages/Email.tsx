import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowLeft, Mail, Reply, Search, Send, Sparkles, Trash2 } from "lucide-react";
import type { MailMessageFolder } from "@paperclipai/shared";
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

function AddMailboxForm({ companyId, ownerUserId }: { companyId: string; ownerUserId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [displayName, setDisplayName] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapUsername, setImapUsername] = useState("");
  const [imapCredentialSecretId, setImapCredentialSecretId] = useState<string>("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpCredentialSecretId, setSmtpCredentialSecretId] = useState<string>("");

  const secretsQuery = useQuery({
    queryKey: ["secrets", companyId],
    queryFn: () => secretsApi.list(companyId),
  });
  const secrets = secretsQuery.data ?? [];

  const createAccount = useMutation({
    mutationFn: () =>
      mailApi.createAccount(companyId, {
        ownerUserId,
        paAgentId: null,
        displayName: displayName.trim(),
        emailAddress: emailAddress.trim(),
        imapHost: imapHost.trim(),
        imapPort: 993,
        imapSecure: true,
        imapUsername: imapUsername.trim() || emailAddress.trim(),
        imapMailbox: "INBOX",
        imapCredentialSecretId: imapCredentialSecretId || null,
        smtpHost: smtpHost.trim(),
        smtpPort: 587,
        smtpSecure: true,
        smtpUsername: smtpUsername.trim() || emailAddress.trim(),
        smtpCredentialSecretId: smtpCredentialSecretId || null,
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

  return (
    <div className="mx-auto max-w-xl space-y-6 py-8">
      <div>
        <h1 className="text-lg font-semibold">Connect your mailbox</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add your email account's server details below. This mailbox is yours alone -- nobody else at the company,
          including an owner or admin, can read your messages without a logged, visible reason.
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
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="imap-user">IMAP username</Label>
            <Input id="imap-user" placeholder="Defaults to your email address" value={imapUsername} onChange={(e) => setImapUsername(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>IMAP password</Label>
          <Select value={imapCredentialSecretId} onValueChange={setImapCredentialSecretId}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a saved password" />
            </SelectTrigger>
            <SelectContent>
              {secrets.map((secret) => (
                <SelectItem key={secret.id} value={secret.id}>
                  {secret.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            No saved password yet? <Link to="/company/settings/secrets">Add one here</Link> first, then come back.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="smtp-host">Outgoing mail server (SMTP)</Label>
            <Input id="smtp-host" placeholder="smtp.example.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smtp-user">SMTP username</Label>
            <Input id="smtp-user" placeholder="Defaults to your email address" value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>SMTP password</Label>
          <Select value={smtpCredentialSecretId} onValueChange={setSmtpCredentialSecretId}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a saved password (often the same one)" />
            </SelectTrigger>
            <SelectContent>
              {secrets.map((secret) => (
                <SelectItem key={secret.id} value={secret.id}>
                  {secret.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" disabled={createAccount.isPending || !displayName.trim() || !emailAddress.trim() || !imapHost.trim() || !smtpHost.trim()}>
          {createAccount.isPending ? "Connecting…" : "Connect mailbox"}
        </Button>
      </form>
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

  const invalidateMessages = () => {
    if (selectedCompanyId && accountId) {
      queryClient.invalidateQueries({ queryKey: ["email", "messages", selectedCompanyId, accountId] });
      queryClient.invalidateQueries({ queryKey: ["email", "search", selectedCompanyId, accountId] });
    }
  };

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

              <div className="flex flex-wrap items-center gap-2">
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
