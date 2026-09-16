import type { TelegramBotCheckResult, TelegramBotSummary } from "@paperclipai/shared";
import { api } from "./client";

/**
 * DUR-3978 slice 2: connecting a Telegram bot from company settings.
 *
 * There is no `token` anywhere in the response types: the server never sends
 * one back to the browser. A token only ever travels one way — in the body of
 * `create` and `rotateToken` — and what comes back is a masked hint.
 */
export const telegramBotsApi = {
  list: (companyId: string) =>
    api.get<TelegramBotSummary[]>(`/companies/${companyId}/telegram-bots`),
  create: (companyId: string, data: { agentId: string; name: string; token: string }) =>
    api.post<TelegramBotSummary>(`/companies/${companyId}/telegram-bots`, data),
  rotateToken: (companyId: string, botId: string, token: string) =>
    api.post<TelegramBotSummary>(
      `/companies/${companyId}/telegram-bots/${encodeURIComponent(botId)}/token`,
      { token },
    ),
  test: (companyId: string, botId: string) =>
    api.post<TelegramBotCheckResult>(
      `/companies/${companyId}/telegram-bots/${encodeURIComponent(botId)}/test`,
      {},
    ),
  setAllowedUsers: (companyId: string, botId: string, telegramUserIds: string[]) =>
    api.put<TelegramBotSummary>(
      `/companies/${companyId}/telegram-bots/${encodeURIComponent(botId)}/allowed-users`,
      { telegramUserIds },
    ),
  remove: (companyId: string, botId: string) =>
    api.delete<{ ok: true }>(
      `/companies/${companyId}/telegram-bots/${encodeURIComponent(botId)}`,
    ),
};
