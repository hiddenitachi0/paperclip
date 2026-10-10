import type {
  TelegramChatSettings,
  TelegramLinkCode,
  TelegramLinkStatus,
  UpdateTelegramChatSettingsInput,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * Hermes parity slice 1: two-way Telegram chat for linked people.
 *
 * The company setting (which bot answers people, which quick agent answers
 * first, which full agent takes bigger questions, the daily limit) and the
 * signed-in person's own Telegram link. The link calls are always about the
 * person who is signed in; there is no way to link someone else.
 */
export const telegramChatApi = {
  getSettings: (companyId: string) =>
    api.get<TelegramChatSettings>(`/companies/${companyId}/telegram-chat/settings`),
  updateSettings: (companyId: string, data: UpdateTelegramChatSettingsInput) =>
    api.put<TelegramChatSettings>(`/companies/${companyId}/telegram-chat/settings`, data),
  linkStatus: () => api.get<TelegramLinkStatus>("/me/telegram-link"),
  createLinkCode: () => api.post<TelegramLinkCode>("/me/telegram-link/code", {}),
  unlink: () => api.delete<TelegramLinkStatus>("/me/telegram-link"),
};
