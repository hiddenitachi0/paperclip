import { api } from "./client";

/**
 * Chat router client (DUR-220 / DUR-335): the endpoint Simple Mode uses to
 * classify and send a message, without needing to know whether it lands on
 * the fast lane or the agent lane.
 */

export interface ChatClassification {
  lane: "a" | "b";
  targetAgentId: string;
  reasoning: string;
}

export interface ChatSendMessageResult {
  lane: "a" | "b";
  result: { conversationId: string; response: string; turnCount: number; stopReason: string | null } | null;
  taskRef: { issueId: string; identifier: string; status: string } | null;
}

export const chatApi = {
  classify: (companyId: string, message: string) =>
    api.post<ChatClassification>("/chat/classify", { companyId, message }),
  sendMessage: (
    agentId: string,
    body: { companyId: string; message: string; laneHint?: "a" | "b"; context?: string; conversationId?: string },
  ) => api.post<ChatSendMessageResult>(`/chat/${agentId}/messages`, body),
};
