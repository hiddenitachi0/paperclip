import type {
  ComposeMailDraftInput,
  MailUrgencyFeedback,
  MailUrgencySummary,
  CreateMailAccountInput,
  MailMessageFolder,
  MoveMailMessageInput,
  UpdateMailAccountInput,
  UpdateMailDraftInput,
} from "@paperclipai/shared";
import type { MailAccountSummary, MailMessageSummary } from "../types/mail";
import { api } from "./client";

/**
 * DUR-4195: thin client for the mail-accounts API (DUR-4194). Per-person
 * mailbox -- AI drafts only, a human presses Send (sendDraft is board-actor
 * only on the server; see server/src/routes/mail-accounts.ts).
 */
export const mailApi = {
  listAccounts: (companyId: string) =>
    api.get<{ accounts: MailAccountSummary[] }>(`/companies/${companyId}/mail-accounts`).then((res) => res.accounts),
  getAccount: (companyId: string, accountId: string) =>
    api.get<MailAccountSummary>(`/companies/${companyId}/mail-accounts/${accountId}`),
  createAccount: (companyId: string, input: CreateMailAccountInput) =>
    api.post<MailAccountSummary>(`/companies/${companyId}/mail-accounts`, input),
  updateAccount: (companyId: string, accountId: string, input: UpdateMailAccountInput) =>
    api.patch<MailAccountSummary>(`/companies/${companyId}/mail-accounts/${accountId}`, input),
  removeAccount: (companyId: string, accountId: string) =>
    api.delete<void>(`/companies/${companyId}/mail-accounts/${accountId}`),

  listMessages: (companyId: string, accountId: string, folder: MailMessageFolder, limit?: number) =>
    api
      .get<{ messages: MailMessageSummary[] }>(
        `/companies/${companyId}/mail-accounts/${accountId}/messages?folder=${folder}${limit ? `&limit=${limit}` : ""}`,
      )
      .then((res) => res.messages),
  searchMessages: (companyId: string, accountId: string, q: string, folder?: MailMessageFolder, limit?: number) =>
    api
      .get<{ messages: MailMessageSummary[] }>(
        `/companies/${companyId}/mail-accounts/${accountId}/search?q=${encodeURIComponent(q)}${
          folder ? `&folder=${folder}` : ""
        }${limit ? `&limit=${limit}` : ""}`,
      )
      .then((res) => res.messages),
  getMessage: (companyId: string, accountId: string, messageId: string) =>
    api.get<MailMessageSummary>(`/companies/${companyId}/mail-accounts/${accountId}/messages/${messageId}`),
  moveMessage: (companyId: string, accountId: string, messageId: string, input: MoveMailMessageInput) =>
    api.post<MailMessageSummary>(`/companies/${companyId}/mail-accounts/${accountId}/messages/${messageId}/move`, input),
  archiveMessage: (companyId: string, accountId: string, messageId: string) =>
    api.post<MailMessageSummary>(`/companies/${companyId}/mail-accounts/${accountId}/messages/${messageId}/archive`, {}),

  setUrgencyFeedback: (companyId: string, accountId: string, messageId: string, feedback: MailUrgencyFeedback | null) =>
    api.post<MailUrgencySummary>(
      `/companies/${companyId}/mail-accounts/${accountId}/messages/${messageId}/urgency-feedback`,
      { feedback },
    ),

  createDraft: (companyId: string, accountId: string, input: ComposeMailDraftInput) =>
    api.post<MailMessageSummary>(`/companies/${companyId}/mail-accounts/${accountId}/drafts`, input),
  updateDraft: (companyId: string, accountId: string, draftId: string, input: UpdateMailDraftInput) =>
    api.patch<MailMessageSummary>(`/companies/${companyId}/mail-accounts/${accountId}/drafts/${draftId}`, input),
  removeDraft: (companyId: string, accountId: string, draftId: string) =>
    api.delete<void>(`/companies/${companyId}/mail-accounts/${accountId}/drafts/${draftId}`),
  sendDraft: (companyId: string, accountId: string, draftId: string) =>
    api.post<MailMessageSummary>(`/companies/${companyId}/mail-accounts/${accountId}/drafts/${draftId}/send`, {}),
};
