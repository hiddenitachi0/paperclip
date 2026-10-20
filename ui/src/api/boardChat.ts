import type {
  BoardChatAction,
  BoardChatAvailabilityResponse,
  BoardChatSettings,
  UpdateBoardChatSettingsInput,
} from "@paperclipai/shared";
import { ApiError, api } from "./client";

/**
 * Board chat on signed-in servers: who can use it, the company switch, and
 * the changes it prepared that wait for the person's Approve.
 */
export const boardChatApi = {
  /** Null when this server is too old to answer (treated as "not here"). */
  getAvailability: async (companyId: string): Promise<BoardChatAvailabilityResponse | null> => {
    try {
      return await api.get<BoardChatAvailabilityResponse>(`/companies/${companyId}/board-chat/availability`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
  getSettings: (companyId: string) => api.get<BoardChatSettings>(`/companies/${companyId}/board-chat/settings`),
  updateSettings: (companyId: string, patch: UpdateBoardChatSettingsInput) =>
    api.patch<BoardChatSettings>(`/companies/${companyId}/board-chat/settings`, patch),
  listActions: (companyId: string, issueId?: string | null) =>
    api.get<{ actions: BoardChatAction[] }>(
      `/companies/${companyId}/board-chat/actions${issueId ? `?issueId=${encodeURIComponent(issueId)}` : ""}`,
    ),
  confirm: (actionId: string) => api.post<{ action: BoardChatAction }>(`/board/chat/actions/${actionId}/confirm`, {}),
  cancel: (actionId: string) => api.post<{ action: BoardChatAction }>(`/board/chat/actions/${actionId}/cancel`, {}),
};
