import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  laneAApi,
  type LaneAConversationLogAction,
  type LaneAConversationLogFilters,
  type LaneAConversationLogRow,
} from "../api/laneA";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, issueUrl, relativeTime } from "../lib/utils";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * "Conversations" tab on a quick agent's page: what the quick agent told
 * people. Owners and admins see every conversation; everyone else sees only
 * their own (the server decides, and says which via `canSeeAll`). An
 * Employee (light) member's chat shows as a private row: who and when, never
 * what was said.
 *
 * The list is newest activity first, 25 at a time with "Show more". Opening a
 * row shows the full transcript with what the agent did in plain words and
 * pictures as thumbnails. Read-only: deleting and keeping-for-how-long
 * settings are a later step.
 */

const PAGE_SIZE = 25;

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function channelLabel(channel: LaneAConversationLogRow["channel"]): string | null {
  return channel === "telegram" ? "Telegram" : null;
}

function personLabel(row: LaneAConversationLogRow): string {
  if (!row.person) return "Unknown";
  return row.person.kind === "agent" ? `${row.person.name} (agent)` : row.person.name;
}

function ToolChips({ tools }: { tools: LaneAConversationLogRow["toolUse"] }) {
  if (tools.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="What it did">
      {tools.map((tool) => (
        <li key={tool.label} className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground">
          {tool.label}
          {tool.count > 1 ? ` ×${tool.count}` : ""}
        </li>
      ))}
    </ul>
  );
}

function ConversationRow({ row, onOpen }: { row: LaneAConversationLogRow; onOpen: () => void }) {
  const channel = channelLabel(row.channel);
  return (
    <li data-testid="conversation-row">
      <button
        type="button"
        onClick={onOpen}
        disabled={row.private}
        className="w-full space-y-1.5 rounded-md border border-border px-3 py-2.5 text-left transition-colors hover:bg-accent/40 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium">{row.mine ? `${personLabel(row)} (you)` : personLabel(row)}</span>
          {channel && <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-700 dark:text-sky-300">{channel}</span>}
          {row.private && (
            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-800 dark:text-amber-300">Private</span>
          )}
          <span className="ml-auto text-xs text-muted-foreground" title={formatDateTime(row.lastMessageAt)}>
            Last active {relativeTime(row.lastMessageAt)}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          Started {formatDateTime(row.startedAt)} · {row.messageCount} {row.messageCount === 1 ? "message" : "messages"}
          {row.handoffCount > 0 ? ` · ${row.handoffCount} ${row.handoffCount === 1 ? "hand-off" : "hand-offs"}` : ""}
        </div>
        {row.private ? (
          <p className="text-xs text-muted-foreground">
            This is a private chat. An owner or admin can only read it through emergency access, which asks for a reason and is logged.
          </p>
        ) : (
          row.firstQuestion && <p className="text-sm text-foreground/90 line-clamp-2">“{row.firstQuestion}”</p>
        )}
        <ToolChips tools={row.toolUse} />
      </button>
    </li>
  );
}

function ActionLine({ action }: { action: LaneAConversationLogAction }) {
  return (
    <li className="space-y-1 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={action.ok ? "font-medium text-foreground" : "font-medium text-destructive"}>
          {action.label}
          {!action.ok && " (did not work)"}
        </span>
        {action.summary && action.summary !== action.label && <span className="text-muted-foreground">{action.summary}</span>}
        {action.task && (
          <Link to={issueUrl({ id: action.task.issueId, identifier: action.task.identifier })} className="text-primary underline-offset-2 hover:underline">
            {action.task.identifier ?? "Open task"}
          </Link>
        )}
      </div>
      {action.image && (
        <a href={action.image.contentPath} target="_blank" rel="noreferrer" title="Open the full-size picture">
          <img
            src={action.image.contentPath}
            alt="Picture the agent made"
            loading="lazy"
            className="h-24 w-24 rounded border border-border object-cover"
          />
        </a>
      )}
    </li>
  );
}

function Transcript({
  companyId,
  agentId,
  agentName,
  conversationId,
  onBack,
}: {
  companyId: string;
  agentId: string;
  agentName: string;
  conversationId: string;
  onBack: () => void;
}) {
  const query = useQuery({
    queryKey: queryKeys.laneAConversationLog.detail(companyId, agentId, conversationId),
    queryFn: () => laneAApi.getConversationLog(companyId, agentId, conversationId),
    retry: false,
  });
  const data = query.data;
  const person = data ? personLabel(data.conversation) : "";

  return (
    <div className="space-y-4" data-testid="conversation-transcript">
      <Button variant="ghost" size="sm" onClick={onBack}>
        ← All conversations
      </Button>
      {query.isLoading && <p className="text-sm text-muted-foreground">Loading the conversation…</p>}
      {query.error && <p className="text-sm text-destructive">{errorText(query.error, "Could not open this conversation.")}</p>}
      {data && (
        <>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">
              {person}
              {channelLabel(data.conversation.channel) ? ` · ${channelLabel(data.conversation.channel)}` : ""}
            </h3>
            <p className="text-xs text-muted-foreground">
              Started {formatDateTime(data.conversation.startedAt)} · last active {formatDateTime(data.conversation.lastMessageAt)} ·{" "}
              {data.conversation.messageCount} messages
            </p>
            {data.continuedFrom && <p className="text-xs text-muted-foreground">Carried on from: {data.continuedFrom}</p>}
          </div>
          <ol className="space-y-3">
            {data.messages.map((message) => (
              <li
                key={message.id}
                className={
                  message.role === "user"
                    ? "rounded-md border border-border bg-muted/40 px-3 py-2"
                    : "rounded-md border border-border px-3 py-2"
                }
              >
                <div className="mb-1 flex items-baseline gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{message.role === "user" ? person : agentName}</span>
                  <span>{formatDateTime(message.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
                {message.actions.length > 0 && (
                  <ul className="mt-2 space-y-1.5 border-t border-border pt-2" aria-label="What it did">
                    {message.actions.map((action, index) => (
                      <ActionLine key={`${message.id}-${index}`} action={action} />
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

export function QuickAgentConversations({
  companyId,
  agentId,
  agentName,
}: {
  companyId: string;
  agentId: string;
  agentName: string;
}) {
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [hasHandoffs, setHasHandoffs] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const filters: LaneAConversationLogFilters = {
    ...(userId ? { userId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(hasHandoffs ? { hasHandoffs: true } : {}),
    ...(search ? { q: search } : {}),
  };

  const list = useInfiniteQuery({
    queryKey: queryKeys.laneAConversationLog.list(companyId, agentId, filters as Record<string, unknown>),
    queryFn: ({ pageParam }) =>
      laneAApi.listConversationLog(companyId, agentId, { ...filters, limit: PAGE_SIZE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: false,
    enabled: openId === null,
  });

  if (openId) {
    return (
      <Transcript
        companyId={companyId}
        agentId={agentId}
        agentName={agentName}
        conversationId={openId}
        onBack={() => setOpenId(null)}
      />
    );
  }

  const firstPage = list.data?.pages[0];
  const rows = list.data?.pages.flatMap((page) => page.conversations) ?? [];
  const canSeeAll = firstPage?.canSeeAll ?? false;
  const people = firstPage?.people ?? [];
  const filtering = Object.keys(filters).length > 0;

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = searchDraft.trim();
    setSearch(trimmed.length >= 2 ? trimmed : "");
  };

  const clearFilters = () => {
    setUserId("");
    setFrom("");
    setTo("");
    setHasHandoffs(false);
    setSearchDraft("");
    setSearch("");
  };

  return (
    <div className="max-w-3xl space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Conversations</h2>
        <p className="text-sm text-muted-foreground">
          {canSeeAll
            ? `Every chat people have had with ${agentName}, newest first. Pick one to read it in full.`
            : `Your chats with ${agentName}, newest first. Pick one to read it in full.`}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
        {canSeeAll && people.length > 0 && (
          <label className="space-y-1 text-xs text-muted-foreground">
            <span className="block">Person</span>
            <select
              aria-label="Person"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            >
              <option value="">Everyone</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">From</span>
          <Input aria-label="From" type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="h-8 w-[9.5rem]" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">To</span>
          <Input aria-label="To" type="date" value={to} onChange={(event) => setTo(event.target.value)} className="h-8 w-[9.5rem]" />
        </label>
        <label className="flex h-8 items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="Has hand-offs"
            checked={hasHandoffs}
            onChange={(event) => setHasHandoffs(event.target.checked)}
          />
          Has hand-offs
        </label>
        <form onSubmit={submitSearch} className="flex min-w-[12rem] flex-1 items-end gap-2" role="search">
          <label className="flex-1 space-y-1 text-xs text-muted-foreground">
            <span className="block">Search messages</span>
            <Input
              aria-label="Search messages"
              value={searchDraft}
              maxLength={200}
              placeholder="Words from the chat"
              onChange={(event) => setSearchDraft(event.target.value)}
              className="h-8"
            />
          </label>
          <Button type="submit" size="sm" variant="outline">
            Search
          </Button>
        </form>
        {filtering && (
          <Button type="button" size="sm" variant="ghost" onClick={clearFilters}>
            Clear
          </Button>
        )}
      </div>

      {list.isLoading && <p className="text-sm text-muted-foreground">Loading conversations…</p>}
      {list.error && <p className="text-sm text-destructive">{errorText(list.error, "Could not load the conversations.")}</p>}
      {list.data && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {filtering ? "No conversations match these filters." : `No one has chatted with ${agentName} yet.`}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((row) => (
            <ConversationRow key={row.id} row={row} onOpen={() => setOpenId(row.id)} />
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button variant="outline" size="sm" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          {list.isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      )}
    </div>
  );
}
