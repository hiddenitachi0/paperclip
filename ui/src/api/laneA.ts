import type { LaneASetupCheckResult, LaneASetupCheckTarget } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Quick agents (Lane A): talk to an agent that answers directly in chat,
 * remembers the conversation, and can do a few safe things (hand work to a
 * colleague, look up the weather, read a task summary).
 */

/** A picture a tool made this turn; the server checked it is a picture in this company. */
export interface LaneAActionImage {
  fileId: string;
  /** Same-origin address of the picture. */
  contentPath: string;
  contentType: string;
  seed: number | null;
  /** The task it is attached to, or null for a company file with no task. */
  issueId: string | null;
}

export interface LaneAAction {
  tool: string;
  /** Plain-language one-liner, e.g. "Handed to Bob as task DUR-12." */
  summary: string;
  ok: boolean;
  image?: LaneAActionImage;
  /** Set when the action started a task (a hand-over, or a research task); the chat follows it. */
  task?: { issueId: string; identifier: string | null; title: string };
}

export interface LaneASendMessageResult {
  conversationId: string;
  response: string;
  turnCount: number;
  stopReason: string | null;
  actions: LaneAAction[];
}

export interface LaneATranscriptMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  actions: LaneAAction[];
  createdAt: string;
}

export interface LaneAConversationTranscript {
  conversationId: string;
  turnCount: number;
  expired: boolean;
  turnCapReached: boolean;
  /** A continued conversation's one-line recap of what it carries on from; null otherwise. */
  continuedFrom?: string | null;
  messages: LaneATranscriptMessage[];
}

/** A new conversation that carries on from an earlier one ("Continue earlier conversation…"). */
export interface LaneAContinueResult {
  conversationId: string;
  mode: "last" | "time" | "topic";
  recap: string;
  matchedMessages: number;
  consideredMessages: number;
  fromConversations: number;
}

/** Conversations review: who a quick agent talked to and what it did (owners/admins: all; others: their own). */
export interface LaneAConversationLogPerson {
  kind: "user" | "agent";
  id: string;
  name: string;
}

export interface LaneAConversationLogRow {
  id: string;
  person: LaneAConversationLogPerson | null;
  /** "telegram" when Paperclip recorded it; null when not recorded. */
  channel: "telegram" | null;
  startedAt: string;
  lastMessageAt: string;
  messageCount: number;
  firstQuestion: string | null;
  toolUse: Array<{ label: string; count: number }>;
  handoffCount: number;
  /** An Employee (light) member's private chat: listed, but nothing from inside it. */
  private: boolean;
  mine: boolean;
}

export interface LaneAConversationLogPage {
  conversations: LaneAConversationLogRow[];
  nextCursor: string | null;
  people: LaneAConversationLogPerson[];
  canSeeAll: boolean;
}

export interface LaneAConversationLogAction {
  tool: string;
  label: string;
  summary: string;
  ok: boolean;
  image: { contentPath: string; contentType: string } | null;
  task: { issueId: string; identifier: string | null; title: string } | null;
}

export interface LaneAConversationLogTranscript {
  conversation: LaneAConversationLogRow;
  continuedFrom: string | null;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
    actions: LaneAConversationLogAction[];
  }>;
}

export interface LaneAConversationLogFilters {
  userId?: string;
  /** YYYY-MM-DD */
  from?: string;
  /** YYYY-MM-DD */
  to?: string;
  hasHandoffs?: boolean;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

function conversationLogQuery(filters: LaneAConversationLogFilters): string {
  const params = new URLSearchParams();
  if (filters.userId) params.set("userId", filters.userId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.hasHandoffs) params.set("hasHandoffs", "true");
  if (filters.q?.trim()) params.set("q", filters.q.trim());
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.cursor) params.set("cursor", filters.cursor);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const laneAApi = {
  sendMessage: (
    agentId: string,
    body: { companyId: string; message: string; conversationId?: string; context?: string },
  ) => api.post<LaneASendMessageResult>(`/lane-a/${agentId}/messages`, body),
  continueConversation: (agentId: string, body: { companyId: string; spec?: string }) =>
    api.post<LaneAContinueResult>(`/lane-a/${agentId}/continue`, body),
  /** "Check this setup": one tiny real call for the main model or a saved backup (owner/admin only, costs a fraction of a cent). */
  checkSetup: (agentId: string, body: { companyId: string; target: LaneASetupCheckTarget }) =>
    api.post<LaneASetupCheckResult>(`/agents/${agentId}/lane-a/check`, body),
  getConversation: (agentId: string, conversationId: string, companyId: string) =>
    api.get<LaneAConversationTranscript>(
      `/lane-a/${agentId}/conversations/${conversationId}?companyId=${encodeURIComponent(companyId)}`,
    ),
  listConversationLog: (companyId: string, agentId: string, filters: LaneAConversationLogFilters = {}) =>
    api.get<LaneAConversationLogPage>(
      `/companies/${companyId}/lane-a/agents/${agentId}/conversations${conversationLogQuery(filters)}`,
    ),
  getConversationLog: (companyId: string, agentId: string, conversationId: string) =>
    api.get<LaneAConversationLogTranscript>(
      `/companies/${companyId}/lane-a/agents/${agentId}/conversations/${conversationId}`,
    ),
};
