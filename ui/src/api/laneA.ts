import { api } from "./client";

/**
 * Quick agents (Lane A): talk to an agent that answers directly in chat,
 * remembers the conversation, and can do a few safe things (hand work to a
 * colleague, look up the weather, read a task summary).
 */

export interface LaneAAction {
  tool: string;
  /** Plain-language one-liner, e.g. "Handed to Bob as task DUR-12." */
  summary: string;
  ok: boolean;
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
  messages: LaneATranscriptMessage[];
}

export const laneAApi = {
  sendMessage: (
    agentId: string,
    body: { companyId: string; message: string; conversationId?: string; context?: string },
  ) => api.post<LaneASendMessageResult>(`/lane-a/${agentId}/messages`, body),
  getConversation: (agentId: string, conversationId: string, companyId: string) =>
    api.get<LaneAConversationTranscript>(
      `/lane-a/${agentId}/conversations/${conversationId}?companyId=${encodeURIComponent(companyId)}`,
    ),
};
