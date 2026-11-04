import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { Link } from "@/lib/router";
import { ApiError } from "../api/client";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { tradingApi, type TradingVersionSummary } from "../api/trading";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import {
  buildChatMessages,
  forgetChatThread,
  readSavedChatThread,
  saveChatThread,
  traderDraftsWaiting,
  traderNoteFromApproval,
  waitingForTrader,
} from "../lib/tradingChat";
import { buildVersionRows } from "../lib/tradingVersionHistory";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownBody } from "./MarkdownBody";

export const CHAT_INTRO =
  "Ask why it bought or sold, or ask for a change to the rules. The Trader can only suggest changes. Nothing changes until you approve it, and it never places trades.";
export const CHAT_PLACEHOLDER = "For example: Why did it buy yesterday? Or: Stay out of the market when it is wild.";
export const CHAT_READ_ONLY = "Only owners and admins can talk to the Trader. You can still read the conversation.";

function errorText(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

function DraftCard({ version, changes }: { version: TradingVersionSummary; changes: string[] }) {
  const approvalQuery = useQuery({
    queryKey: queryKeys.approvals.detail(version.approvalId ?? "none"),
    queryFn: () => approvalsApi.get(version.approvalId!),
    enabled: Boolean(version.approvalId),
  });
  const note = traderNoteFromApproval(approvalQuery.data);
  return (
    <li className="space-y-2 rounded-md border border-border p-3" data-testid="chat-draft">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">Version {version.version}</h4>
        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
          Waiting for your approval
        </span>
        <span className="text-xs text-muted-foreground">Suggested {timeAgo(version.createdAt)}</span>
      </div>
      <div>
        <p className="text-xs font-medium">What it would change</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
          {changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      </div>
      {note ? (
        <div data-testid="chat-draft-why">
          <p className="text-xs font-medium">Why the Trader suggests it</p>
          {note.summary ? <p className="mt-1 text-sm">{note.summary}</p> : null}
          {note.reasons ? <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{note.reasons}</p> : null}
        </div>
      ) : approvalQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading the reason…</p>
      ) : null}
      {version.approvalId ? (
        <Link to={`/approvals/${version.approvalId}`} className="text-sm font-medium underline">
          Open the approval card
        </Link>
      ) : null}
    </li>
  );
}

/**
 * The "talk it over with the Trader" box on a strategy page. Sending a
 * message only asks the Trader; the Trader can save a suggested change as a
 * draft, and a draft does nothing until a person approves its card.
 */
export function TradingStrategyChat({
  companyId,
  strategyId,
  canManage,
  versions,
}: {
  companyId: string;
  strategyId: string;
  canManage: boolean;
  versions: TradingVersionSummary[];
}) {
  const queryClient = useQueryClient();
  const [threadId, setThreadId] = useState<string | null>(() => readSavedChatThread(companyId, strategyId));
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const endRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    setThreadId(readSavedChatThread(companyId, strategyId));
    setText("");
    setSendError(null);
  }, [companyId, strategyId]);

  const taskQuery = useQuery({
    queryKey: queryKeys.issues.detail(threadId ?? "none"),
    queryFn: () => issuesApi.get(threadId!),
    enabled: Boolean(threadId),
    retry: false,
  });
  const commentsQuery = useQuery({
    queryKey: queryKeys.issues.commentsList(threadId ?? "none"),
    queryFn: () => issuesApi.listComments(threadId!, { order: "asc", limit: 200 }),
    enabled: Boolean(threadId) && Boolean(taskQuery.data),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && !waitingForTrader(buildChatMessages(taskQuery.data!, data)) ? 30_000 : 5_000;
    },
  });

  // The remembered conversation was deleted or is no longer there: start clean instead of showing an error forever.
  useEffect(() => {
    if (threadId && taskQuery.error instanceof ApiError && taskQuery.error.status === 404) {
      forgetChatThread(companyId, strategyId);
      setThreadId(null);
    }
  }, [companyId, strategyId, threadId, taskQuery.error]);

  const messages = useMemo(
    () => (taskQuery.data ? buildChatMessages(taskQuery.data, commentsQuery.data ?? []) : []),
    [taskQuery.data, commentsQuery.data],
  );
  const waiting = waitingForTrader(messages);

  // A new answer may come with a new draft; refresh the version list whenever the conversation grows.
  const messageCount = messages.length;
  useEffect(() => {
    if (messageCount > 1) void queryClient.invalidateQueries({ queryKey: queryKeys.trading.versions(companyId, strategyId) });
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [messageCount, queryClient, companyId, strategyId]);

  const send = useMutation({
    mutationFn: async (message: string) => {
      if (!threadId) {
        const created = await tradingApi.askTrader(companyId, { question: message, strategyId });
        return created.issueId;
      }
      const closed = taskQuery.data?.status === "done" || taskQuery.data?.status === "cancelled";
      await issuesApi.addComment(threadId, message, closed || undefined);
      return threadId;
    },
    onSuccess: (issueId) => {
      setText("");
      setSendError(null);
      if (issueId !== threadId) {
        saveChatThread(companyId, strategyId, issueId);
        setThreadId(issueId);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.commentsList(issueId) });
    },
    onError: (error) => setSendError(errorText(error)),
  });

  const draftRows = useMemo(() => {
    const waitingDrafts = traderDraftsWaiting(versions);
    const rows = buildVersionRows(versions, []);
    return waitingDrafts.map((v) => ({ version: v, changes: rows.find((r) => r.version.id === v.id)?.changes ?? [] }));
  }, [versions]);

  const trimmed = text.trim();
  const canSend = canManage && trimmed.length >= 3 && !send.isPending;

  function submit() {
    if (canSend) send.mutate(trimmed);
  }

  function startOver() {
    forgetChatThread(companyId, strategyId);
    setThreadId(null);
    setText("");
    setSendError(null);
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-4" data-testid="strategy-chat">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <MessageSquare className="h-4 w-4" />
          Talk it over with the Trader
        </h2>
        {threadId && canManage ? (
          <Button variant="ghost" size="sm" onClick={startOver} data-testid="chat-start-over">
            Start a new conversation
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{CHAT_INTRO}</p>

      {messages.length > 0 ? (
        <ul className="max-h-96 space-y-3 overflow-y-auto" data-testid="chat-messages" aria-live="polite">
          {messages.map((m, i) => (
            <li
              key={m.id}
              ref={i === messages.length - 1 ? endRef : undefined}
              data-from={m.from}
              className={`rounded-md p-3 text-sm ${m.from === "you" ? "ml-8 bg-muted/60" : "mr-8 border border-border"}`}
            >
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {m.from === "you" ? "You" : "The Trader"} · {timeAgo(m.at)}
              </p>
              {m.from === "trader" ? <MarkdownBody>{m.text}</MarkdownBody> : <p className="whitespace-pre-wrap">{m.text}</p>}
            </li>
          ))}
        </ul>
      ) : threadId && taskQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading the conversation…</p>
      ) : null}

      {waiting ? (
        <p className="text-sm text-muted-foreground" data-testid="chat-waiting">
          The Trader is working on your message. This can take a few minutes. You can leave this page and come back.
        </p>
      ) : null}

      {draftRows.length > 0 ? (
        <div className="space-y-2" data-testid="chat-drafts">
          <h3 className="text-sm font-semibold">Changes the Trader suggested</h3>
          <p className="text-xs text-muted-foreground">
            These are only suggestions. The strategy keeps its current rules until you approve one. The past-data check still applies before it can start.
          </p>
          <ul className="space-y-2">
            {draftRows.map((d) => (
              <DraftCard key={d.version.id} version={d.version} changes={d.changes} />
            ))}
          </ul>
        </div>
      ) : null}

      {canManage ? (
        <div className="space-y-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            maxLength={2000}
            rows={3}
            placeholder={messages.length > 0 ? "Write your reply…" : CHAT_PLACEHOLDER}
            aria-label="Your message to the Trader"
            data-testid="chat-input"
          />
          {sendError ? (
            <p className="text-sm text-destructive" role="alert" data-testid="chat-error">
              {sendError}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Press Ctrl+Enter to send.</span>
            <Button size="sm" onClick={submit} disabled={!canSend} data-testid="chat-send">
              {send.isPending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="chat-read-only">
          {CHAT_READ_ONLY}
        </p>
      )}
    </div>
  );
}
