import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { laneAApi, type LaneAAction, type LaneAActionImage } from "../api/laneA";
import { Link } from "@/lib/router";
import { ApiError } from "../api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "../lib/utils";
import { ChatMicButton, ChatSpeakButton } from "./ChatSpeechButtons";

/**
 * Chat panel for a quick agent (Lane A). The conversation id is remembered
 * per agent in this browser so a page reload resumes the same conversation
 * (the server keeps the transcript and replays it to the agent). When the
 * server says the conversation expired or hit its cap, the panel starts a
 * fresh one on the next message.
 */

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  actions: LaneAAction[];
  pending?: boolean;
}

const MESSAGE_MAX_LENGTH = 8000;
/** The server's limit for what to continue ("last 45 minutes", "our meeting today"). */
const CONTINUE_SPEC_MAX_LENGTH = 200;

function storageKey(agentId: string) {
  return `paperclip.quickAgent.conversation.${agentId}`;
}

function readStoredConversationId(agentId: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(agentId));
  } catch {
    return null;
  }
}

function writeStoredConversationId(agentId: string, conversationId: string | null) {
  try {
    if (conversationId) window.sessionStorage.setItem(storageKey(agentId), conversationId);
    else window.sessionStorage.removeItem(storageKey(agentId));
  } catch {
    // Storage may be unavailable (private mode); the chat still works for this page view.
  }
}

function describeSendError(err: unknown): { text: string; resetConversation: boolean } {
  if (err instanceof ApiError) {
    // The server's error handler puts HttpError details.code on the body as `code`.
    const body = err.body as { code?: unknown } | null | undefined;
    const code = typeof body?.code === "string" ? body.code : undefined;
    if (code === "LANE_A_CONVERSATION_EXPIRED") {
      return { text: "That conversation went quiet for too long, so a new one starts with your next message.", resetConversation: true };
    }
    if (code === "LANE_A_TURN_CAP_REACHED") {
      return { text: "That conversation reached its length limit, so a new one starts with your next message.", resetConversation: true };
    }
    if (code === "LANE_A_DAILY_CAP_REACHED") {
      return { text: "You have reached today's limit for quick-agent messages. Try again tomorrow.", resetConversation: false };
    }
    if (err.status === 404) {
      return { text: "That conversation could not be found, so a new one starts with your next message.", resetConversation: true };
    }
    return { text: err.message, resetConversation: false };
  }
  return { text: err instanceof Error ? err.message : "Something went wrong sending that message.", resetConversation: false };
}

/** Where a picture shows on the Files page: the "No task" group, or its task's group. */
export function filesHrefForImage(image: LaneAActionImage): string {
  return `/files?groupIssueId=${encodeURIComponent(image.issueId ?? "no-task")}`;
}

/** Pictures a tool made while answering: a thumbnail (opens full size) and a link to it in Files. */
export function ChatActionImages({ actions }: { actions: LaneAAction[] }) {
  const images = actions.map((action) => action.image).filter((image): image is LaneAActionImage => Boolean(image));
  if (images.length === 0) return null;
  return (
    <div className="mt-2 space-y-2">
      {images.map((image) => (
        <figure key={image.fileId} className="space-y-1">
          <a href={image.contentPath} target="_blank" rel="noreferrer" title="Open the full-size picture">
            <img
              src={image.contentPath}
              alt="Picture made for this reply"
              loading="lazy"
              className="max-h-64 max-w-full rounded-md border object-contain"
            />
          </a>
          <figcaption className="text-xs text-muted-foreground">
            <Link to={filesHrefForImage(image)} className="underline underline-offset-2">
              {image.issueId ? "See it in Files (with its task)" : "See it in Files"}
            </Link>
            {image.seed !== null ? <span> · Seed {image.seed}</span> : null}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export function QuickAgentChatPanel({
  agentId,
  agentName,
  companyId,
}: {
  agentId: string;
  agentName: string;
  companyId: string;
}) {
  const [conversationId, setConversationId] = useState<string | null>(() => readStoredConversationId(agentId));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // "Continuing from: …" after a continue, or when a continued conversation is resumed.
  const [continuedFrom, setContinuedFrom] = useState<string | null>(null);
  const [continueOpen, setContinueOpen] = useState(false);
  const [continueSpec, setContinueSpec] = useState("");
  const [continuing, setContinuing] = useState(false);
  const [loadingTranscript, setLoadingTranscript] = useState(Boolean(conversationId));
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const resetConversation = useCallback(() => {
    setConversationId(null);
    writeStoredConversationId(agentId, null);
    setContinuedFrom(null);
  }, [agentId]);

  // Resume the stored conversation (if any) on first render.
  useEffect(() => {
    let cancelled = false;
    const stored = readStoredConversationId(agentId);
    if (!stored) {
      setLoadingTranscript(false);
      return;
    }
    laneAApi
      .getConversation(agentId, stored, companyId)
      .then((transcript) => {
        if (cancelled) return;
        if (transcript.expired || transcript.turnCapReached) {
          resetConversation();
          setMessages([]);
          setNotice("Your earlier conversation has ended; a new one starts with your next message.");
          return;
        }
        setMessages(
          transcript.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, actions: m.actions })),
        );
        if (typeof transcript.continuedFrom === "string") {
          setContinuedFrom(transcript.continuedFrom || "your earlier conversation");
        }
      })
      .catch(() => {
        if (cancelled) return;
        resetConversation();
        setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingTranscript(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, companyId, resetConversation]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, sending]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setNotice(null);
    setInput("");
    const localId = `local-${Date.now()}`;
    setMessages((prev) => [...prev, { id: localId, role: "user", content: text, actions: [] }]);
    try {
      const result = await laneAApi.sendMessage(agentId, {
        companyId,
        message: text,
        ...(conversationId ? { conversationId } : {}),
      });
      if (result.conversationId !== conversationId) {
        setConversationId(result.conversationId);
        writeStoredConversationId(agentId, result.conversationId);
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `${result.conversationId}-${result.turnCount}`,
          role: "assistant",
          content: result.response || "(no reply)",
          actions: result.actions ?? [],
        },
      ]);
    } catch (err) {
      const described = describeSendError(err);
      setNotice(described.text);
      if (described.resetConversation) resetConversation();
      // Give the person their text back so nothing is lost.
      setMessages((prev) => prev.filter((m) => m.id !== localId));
      setInput(text);
    } finally {
      setSending(false);
    }
  };

  const continueEarlier = async () => {
    if (continuing || sending) return;
    setContinuing(true);
    setNotice(null);
    try {
      const spec = continueSpec.trim();
      const result = await laneAApi.continueConversation(agentId, { companyId, ...(spec ? { spec } : {}) });
      setConversationId(result.conversationId);
      writeStoredConversationId(agentId, result.conversationId);
      setMessages([]);
      setContinuedFrom(result.recap || "your earlier conversation");
      setContinueOpen(false);
      setContinueSpec("");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not continue the earlier conversation.");
    } finally {
      setContinuing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Talk to {agentName}</CardTitle>
            <CardDescription>
              Quick agent: answers right here, remembers this conversation, and can hand work to a colleague, look
              up the weather, or read a task summary. Everything it does is shown under its reply.
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setContinueOpen((open) => !open)}
              disabled={sending || continuing}
            >
              Continue earlier conversation…
            </Button>
            {messages.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  resetConversation();
                  setMessages([]);
                  setNotice(null);
                  setContinuedFrom(null);
                }}
                disabled={sending}
              >
                New conversation
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {continueOpen && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm text-muted-foreground">
              What should {agentName} pick up? Leave it empty for your last conversation, or say a time ("last 45
              minutes", "this morning", "yesterday") or a topic ("our meeting today").
            </p>
            <div className="flex items-center gap-2">
              <Input
                aria-label="What to continue"
                value={continueSpec}
                onChange={(event) => setContinueSpec(event.target.value.slice(0, CONTINUE_SPEC_MAX_LENGTH))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void continueEarlier();
                  }
                }}
                placeholder="e.g. last 45 minutes"
                className="text-sm"
                disabled={continuing}
              />
              <Button size="sm" onClick={() => void continueEarlier()} disabled={continuing}>
                {continuing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Continue"}
              </Button>
            </div>
          </div>
        )}
        {continuedFrom && <p className="text-sm text-muted-foreground">Continuing from: {continuedFrom}</p>}
        <div className="max-h-96 overflow-y-auto rounded-md border bg-muted/30 p-3 space-y-3">
          {loadingTranscript ? (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading your earlier conversation…
            </p>
          ) : messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Say hello, ask a question, or ask {agentName} to pass something on to a colleague.
            </p>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words",
                    message.role === "user" ? "bg-primary text-primary-foreground" : "bg-background border",
                  )}
                >
                  {message.content}
                  <ChatActionImages actions={message.actions} />
                  {message.role === "assistant" && (
                    <div>
                      <ChatSpeakButton companyId={companyId} text={message.content} onError={setNotice} />
                    </div>
                  )}
                  {message.actions.length > 0 && (
                    <ul className="mt-2 space-y-1 border-t pt-2 text-xs text-muted-foreground">
                      {message.actions.map((action, index) => (
                        <li key={`${message.id}-action-${index}`} className={cn(!action.ok && "text-destructive")}>
                          {action.ok ? "Did: " : "Could not: "}
                          {action.summary}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))
          )}
          {sending && (
            <p className="text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {agentName} is thinking…
            </p>
          )}
          <div ref={bottomRef} />
        </div>
        {notice && <p className="text-sm text-destructive">{notice}</p>}
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value.slice(0, MESSAGE_MAX_LENGTH))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={`Message ${agentName}… (Enter to send, Shift+Enter for a new line)`}
            className="text-sm"
            disabled={sending || loadingTranscript}
          />
          <ChatMicButton
            companyId={companyId}
            disabled={sending || loadingTranscript}
            onError={setNotice}
            onTranscript={(text) => {
              // The words land in the box to check before sending.
              setNotice(null);
              setInput((current) => (current.trim() ? `${current.trim()} ${text}` : text).slice(0, MESSAGE_MAX_LENGTH));
            }}
          />
          <Button onClick={() => void send()} disabled={!input.trim() || sending || loadingTranscript}>
            Send
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
