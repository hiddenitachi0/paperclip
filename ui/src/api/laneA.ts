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

export const laneAApi = {
  sendMessage: (
    agentId: string,
    body: { companyId: string; message: string; conversationId?: string; context?: string },
  ) => api.post<LaneASendMessageResult>(`/lane-a/${agentId}/messages`, body),
  continueConversation: (agentId: string, body: { companyId: string; spec?: string }) =>
    api.post<LaneAContinueResult>(`/lane-a/${agentId}/continue`, body),
  getConversation: (agentId: string, conversationId: string, companyId: string) =>
    api.get<LaneAConversationTranscript>(
      `/lane-a/${agentId}/conversations/${conversationId}?companyId=${encodeURIComponent(companyId)}`,
    ),
};
