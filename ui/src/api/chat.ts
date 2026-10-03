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
  result: {
    conversationId: string;
    response: string;
    turnCount: number;
    stopReason: string | null;
    /** What the quick agent did; a started task carries `task`. */
    actions?: Array<{ tool: string; summary: string; ok: boolean; task?: { issueId: string; identifier: string | null; title: string } }>;
  } | null;
  taskRef: { issueId: string; identifier: string; status: string } | null;
}

/** One task's status and the agent's latest answer (GET /companies/:id/issue-answers). */
export interface ChatTaskAnswer {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  answer: { commentId: string; authorAgentId: string | null; body: string; createdAt: string } | null;
  /** The task's result page (issue document "result"), when it has one. */
  resultDocument: { key: string; title: string | null } | null;
}

export const chatApi = {
  answers: (companyId: string, issueIds: string[]) =>
    api.get<{ issues: ChatTaskAnswer[] }>(
      `/companies/${companyId}/issue-answers?ids=${encodeURIComponent(issueIds.join(","))}`,
    ),
  classify: (companyId: string, message: string) =>
    api.post<ChatClassification>("/chat/classify", { companyId, message }),
  sendMessage: (
    agentId: string,
    body: { companyId: string; message: string; laneHint?: "a" | "b"; context?: string; conversationId?: string },
  ) => api.post<ChatSendMessageResult>(`/chat/${agentId}/messages`, body),
};
