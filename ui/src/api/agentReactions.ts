import { api } from "./client";

// Recent emoji reactions to a quick agent's Telegram messages, newest first,
// plus whether the agent is learning from them. Board-only route.

export type ReactionMeaning = "positive" | "negative" | "neutral";

export interface AgentReaction {
  id: string;
  emoji: string;
  meaning: ReactionMeaning | null;
  /** false once the person took the reaction back. */
  active: boolean;
  reactedAt: string;
  removedAt: string | null;
  message: { id: string; conversationId: string | null; excerpt: string | null };
  picture: { fileId: string | null; look: string | null; promptExcerpt: string | null } | null;
}

export interface AgentReactionList {
  agentId: string;
  reactionLearningEnabled: boolean;
  limit: number;
  offset: number;
  hasMore: boolean;
  items: AgentReaction[];
}

export const agentReactionsApi = {
  list: (agentId: string, limit: number) =>
    api.get<AgentReactionList>(`/agents/${encodeURIComponent(agentId)}/reactions?limit=${limit}`),
};
